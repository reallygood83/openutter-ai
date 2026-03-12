/**
 * meet-bot.ts — Google Meet bot with optional AI conversation capabilities
 *
 * Handles the complete lifecycle:
 * 1. Launch browser with stealth patches
 * 2. Join Google Meet (guest or authenticated)
 * 3. Enable captions and capture transcript
 * 4. (AI mode) Process captions -> LLM -> TTS -> audio injection
 * 5. Wait for meeting end, clean up
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Page, BrowserContext } from "playwright-core";

import type { Config } from "./config.js";
import { setupCaptionCapture } from "./caption-capture.js";
import { AIResponder } from "./ai-responder.js";
import { TTSEngine } from "./tts-engine.js";
import { setupVirtualAudio, injectAudio, isPlaying } from "./audio-injector.js";

// ── Directory constants ──────────────────────────────────────────────────

const OPENUTTER_DIR = join(homedir(), ".openutter");
const OPENUTTER_WORKSPACE_DIR = join(homedir(), ".openclaw", "workspace", "openutter");
const CONFIG_FILE = join(OPENUTTER_DIR, "config.json");
const AUTH_FILE = join(OPENUTTER_DIR, "auth.json");
const PID_FILE = join(OPENUTTER_DIR, "otter.pid");
const SCREENSHOT_READY_FILE = join(OPENUTTER_WORKSPACE_DIR, "screenshot-ready.json");
const TRANSCRIPTS_DIR = join(OPENUTTER_WORKSPACE_DIR, "transcripts");

// ── Stealth script ──────────────────────────────────────────────────────

function buildStealthScript(lang: string): string {
  const langShort = lang.split("-")[0] ?? lang;
  return `
  Object.defineProperty(navigator, "webdriver", { get: () => false });
  if (!window.chrome) { window.chrome = { runtime: {} }; }
  Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, "languages", { get: () => ${JSON.stringify([lang, langShort, "en-US", "en"])} });
  var originalQuery = window.Permissions && window.Permissions.prototype && window.Permissions.prototype.query;
  if (originalQuery) {
    window.Permissions.prototype.query = function (params) {
      if (params.name === "notifications") {
        return Promise.resolve({ state: "default", onchange: null });
      }
      return originalQuery.call(this, params);
    };
  }
  var getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (param) {
    if (param === 37445) return "Google Inc. (Apple)";
    if (param === 37446) return "ANGLE (Apple, Apple M1, OpenGL 4.1)";
    return getParameter.call(this, param);
  };
`;
}

// ── Google Meet UI automation helpers ────────────────────────────────────

async function isBlockedFromJoining(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const text = document.body.innerText || "";
      return /you can.t join this video call/i.test(text);
    });
  } catch {
    return false;
  }
}

async function dismissOverlays(page: Page): Promise<void> {
  const dismissTexts = ["Got it", "Dismiss", "OK", "Accept all", "Continue without microphone", "No thanks"];
  for (let round = 0; round < 3; round++) {
    let dismissed = false;
    for (const text of dismissTexts) {
      try {
        const btn = page.locator(`button:has-text("${text}")`).first();
        if (await btn.isVisible({ timeout: 1500 })) {
          await btn.click();
          console.log(`  Dismissed overlay ("${text}")`);
          dismissed = true;
          await page.waitForTimeout(500);
        }
      } catch {
        // Not present
      }
    }
    try {
      const gemini = page.locator("text=/Use Gemini/i").first();
      if (await gemini.isVisible({ timeout: 1000 })) {
        await page.keyboard.press("Escape");
        console.log("  Dismissed Gemini banner");
        dismissed = true;
        await page.waitForTimeout(500);
      }
    } catch {
      // Not present
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    if (!dismissed) break;
  }
}

async function dismissPostJoinDialogs(page: Page): Promise<void> {
  await page.waitForTimeout(2000);
  for (let round = 0; round < 3; round++) {
    let dismissed = false;
    for (const text of ["Got it", "OK", "Dismiss", "Close"]) {
      try {
        const btn = page.locator(`button:has-text("${text}")`).first();
        if (await btn.isVisible({ timeout: 1000 })) {
          await btn.click();
          console.log(`  Dismissed post-join dialog ("${text}")`);
          dismissed = true;
          await page.waitForTimeout(500);
        }
      } catch {
        // Not present
      }
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    if (!dismissed) break;
  }
}

async function disableMediaOnPreJoin(
  page: Page,
  opts: { noCamera: boolean; noMic: boolean },
): Promise<void> {
  if (opts.noMic) {
    try {
      const micBtn = page
        .locator(
          '[aria-label*="microphone" i][data-is-muted="false"], ' +
            'button[aria-label*="Turn off microphone" i]',
        )
        .first();
      if (await micBtn.isVisible({ timeout: 3000 })) {
        await micBtn.click();
        console.log("  Microphone turned off");
      }
    } catch {
      // Already muted
    }
  }
  if (opts.noCamera) {
    try {
      const camBtn = page
        .locator(
          '[aria-label*="camera" i][data-is-muted="false"], ' +
            'button[aria-label*="Turn off camera" i]',
        )
        .first();
      if (await camBtn.isVisible({ timeout: 3000 })) {
        await camBtn.click();
        console.log("  Camera turned off");
      }
    } catch {
      // Already off
    }
  }
}

async function enterNameIfNeeded(page: Page, botName: string): Promise<void> {
  try {
    const nameInput = page
      .locator('input[aria-label="Your name"], input[placeholder*="name" i]')
      .first();
    if (await nameInput.isVisible({ timeout: 3000 })) {
      await nameInput.fill(botName);
      console.log(`  Set display name: ${botName}`);
    }
  } catch {
    // Name field not shown
  }
}

async function clickJoinButton(page: Page, maxAttempts = 6): Promise<boolean> {
  const joinSelectors = [
    'button:has-text("Continue without microphone and camera")',
    'button:has-text("Ask to join")',
    'button:has-text("Join now")',
    'button:has-text("Join meeting")',
    'button:has-text("Join")',
    '[data-idom-class*="join"] button',
    "button >> text=/join/i",
  ];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const isBlocked = await page
      .evaluate(() => {
        const text = document.body.innerText || "";
        return (
          /you can.t join this video call/i.test(text) ||
          /return(ing)? to home screen/i.test(text)
        );
      })
      .catch(() => false);

    if (isBlocked) {
      console.log("  Detected 'can't join' — aborting join attempt");
      return false;
    }

    for (const selector of joinSelectors) {
      try {
        const btn = page.locator(selector).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click();
          console.log("  Clicked join button");
          return true;
        }
      } catch {
        // Try next
      }
    }

    if (attempt < maxAttempts - 1) {
      console.log(`  Join button not found yet, retrying (${attempt + 1}/${maxAttempts})...`);
      if (attempt === 0) {
        const debugPath = join(OPENUTTER_WORKSPACE_DIR, "debug-pre-join.png");
        await page.screenshot({ path: debugPath }).catch(() => {});
        console.log(`  [OPENUTTER_DEBUG_IMAGE] ${debugPath}`);
      }
      await page.waitForTimeout(5000);
    }
  }
  return false;
}

async function waitUntilInMeeting(page: Page, timeoutMs = 600_000): Promise<void> {
  console.log("  Waiting to be admitted to the meeting (up to 10 min)...");
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const endCallBtn = page
        .locator('[aria-label*="Leave call" i], [aria-label*="leave" i][data-tooltip*="Leave"]')
        .first();
      if (await endCallBtn.isVisible({ timeout: 2000 })) {
        return;
      }
    } catch {
      // Not visible yet
    }

    try {
      const inMeetingText = page
        .locator("text=/only one here/i, text=/you.ve been admitted/i")
        .first();
      if (await inMeetingText.isVisible({ timeout: 1000 })) {
        return;
      }
    } catch {
      // Keep waiting
    }

    const isBlocked = await page
      .evaluate(() => {
        const text = document.body.innerText || "";
        return (
          /you can.t join this video call/i.test(text) ||
          /return(ing)? to home screen/i.test(text) ||
          /you have been removed/i.test(text) ||
          /denied your request/i.test(text) ||
          /meeting has been locked/i.test(text) ||
          /cannot join/i.test(text)
        );
      })
      .catch(() => false);

    if (isBlocked) {
      throw new Error("Blocked from joining — access denied or meeting unavailable");
    }

    await page.waitForTimeout(2000);
  }

  throw new Error("Timed out waiting to be admitted (10 minutes)");
}

async function clickLeaveButton(page: Page): Promise<void> {
  try {
    const leaveBtn = page
      .locator('[aria-label*="Leave call" i], [aria-label*="leave" i][data-tooltip*="Leave"]')
      .first();
    if (await leaveBtn.isVisible({ timeout: 1000 })) {
      await leaveBtn.click();
      await page.waitForTimeout(1000);
    }
  } catch {
    // Best-effort
  }
}

async function waitForMeetingEnd(
  page: Page,
  opts?: {
    durationMs?: number;
    captionIdleTimeoutMs?: number;
    getLastCaptionAt?: () => number;
  },
): Promise<string> {
  const start = Date.now();
  const durationMs = opts?.durationMs;
  const captionIdleTimeoutMs = opts?.captionIdleTimeoutMs;
  const getLastCaptionAt = opts?.getLastCaptionAt;

  while (true) {
    if (durationMs && Date.now() - start >= durationMs) {
      await clickLeaveButton(page);
      return "Duration limit reached";
    }

    if (
      captionIdleTimeoutMs &&
      getLastCaptionAt &&
      Date.now() - getLastCaptionAt() >= captionIdleTimeoutMs
    ) {
      await clickLeaveButton(page);
      return "No captions captured for 10 minutes";
    }

    try {
      const endedText = page
        .locator(
          "text=/meeting has ended/i, text=/removed from/i, text=/You left the meeting/i, text=/You.ve left the call/i",
        )
        .first();
      if (await endedText.isVisible({ timeout: 500 })) {
        return "Meeting ended";
      }
    } catch {
      // Still in meeting
    }

    if (!page.url().includes("meet.google.com")) {
      return "Navigated away from meeting";
    }

    await page.waitForTimeout(3000);
  }
}

async function enableCaptions(page: Page): Promise<void> {
  await page.waitForTimeout(5000);

  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(500);

  for (const text of ["Got it", "Dismiss", "Continue"]) {
    try {
      const btn = page.locator(`button:has-text("${text}")`).first();
      if (await btn.isVisible({ timeout: 500 })) {
        await btn.click();
        await page.waitForTimeout(300);
      }
    } catch {
      // Not present
    }
  }

  const checkCaptions = async (): Promise<boolean> =>
    page
      .evaluate(
        `!!(document.querySelector('[role="region"][aria-label*="Captions"]') ||
            document.querySelector('[aria-label="Captions are on"]') ||
            document.querySelector('button[aria-label*="Turn off captions" i]') ||
            document.querySelector('[data-is-persistent-caption="true"]'))`,
      )
      .catch(() => false) as Promise<boolean>;

  if (await checkCaptions()) {
    console.log("  Captions already enabled");
    return;
  }

  // Method 1: Click CC button
  try {
    await page.mouse.move(640, 680);
    await page.waitForTimeout(1000);
    const ccButton = page
      .locator(
        'button[aria-label*="Turn on captions" i], ' +
          'button[aria-label*="captions" i][aria-pressed="false"], ' +
          'button[aria-label*="captions (c)" i]',
      )
      .first();
    if (await ccButton.isVisible({ timeout: 3000 })) {
      await ccButton.click();
      await page.waitForTimeout(2000);
      if (await checkCaptions()) {
        console.log("  Captions enabled (clicked CC button)");
        return;
      }
    }
  } catch {
    // Try keyboard
  }

  // Method 2: press 'c'
  await page.keyboard.press("c");
  await page.waitForTimeout(2000);
  if (await checkCaptions()) {
    console.log("  Captions enabled (pressed 'c')");
    return;
  }

  // Method 3: Shift+C
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Shift+c");
    await page.waitForTimeout(1000);
    if (await checkCaptions()) {
      console.log(`  Captions enabled (Shift+C, attempt ${i + 1})`);
      return;
    }
  }

  // Method 4: More options menu
  try {
    const moreBtn = page
      .locator('button[aria-label*="more options" i], button[aria-label*="More actions" i]')
      .first();
    if (await moreBtn.isVisible({ timeout: 2000 })) {
      await moreBtn.click();
      await page.waitForTimeout(1000);
      const captionsMenuItem = page
        .locator('li:has-text("Captions"), [role="menuitem"]:has-text("Captions")')
        .first();
      if (await captionsMenuItem.isVisible({ timeout: 2000 })) {
        await captionsMenuItem.click();
        await page.waitForTimeout(2000);
        if (await checkCaptions()) {
          console.log("  Captions enabled (via More Options menu)");
          return;
        }
      } else {
        await page.keyboard.press("Escape");
      }
    }
  } catch {
    // Menu approach failed
  }

  // Method 5: CC icon
  try {
    await page.mouse.move(640, 680);
    await page.waitForTimeout(500);
    const ccByIcon = page
      .locator(
        'button:has([data-icon="closed_caption"]), button:has([data-icon="closed_caption_off"])',
      )
      .first();
    if (await ccByIcon.isVisible({ timeout: 2000 })) {
      await ccByIcon.click();
      await page.waitForTimeout(2000);
      if (await checkCaptions()) {
        console.log("  Captions enabled (clicked CC icon)");
        return;
      }
    }
  } catch {
    // Icon not found
  }

  console.log("  WARNING: Could not verify captions are on — capture may not work");
}

function extractMeetingId(meetUrl: string): string {
  try {
    const url = new URL(meetUrl);
    return url.pathname.replace(/^\//, "").replace(/\//g, "-") || "unknown";
  } catch {
    return "unknown";
  }
}

function registerScreenshotHandler(page: Page): void {
  writeFileSync(PID_FILE, String(process.pid));
  process.on("SIGUSR1", async () => {
    try {
      const screenshotPath = join(OPENUTTER_WORKSPACE_DIR, "on-demand-screenshot.png");
      await page.screenshot({ path: screenshotPath });
      const payload = JSON.stringify({ path: screenshotPath, timestamp: Date.now() });
      writeFileSync(SCREENSHOT_READY_FILE, payload);
      console.log(`[OPENUTTER_SCREENSHOT] ${screenshotPath}`);
    } catch (err) {
      console.error("Screenshot failed:", err instanceof Error ? err.message : String(err));
    }
  });
}

function cleanupPidFile(): void {
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch {
    // best-effort
  }
}

// ── Main bot logic ──────────────────────────────────────────────────────

export async function runBot(config: Config): Promise<void> {
  const {
    meetUrl,
    headed,
    anon: noAuth,
    camera,
    mic,
    verbose,
    durationMs,
    botName: botNameOpt,
    channel,
    target,
    ai: aiEnabled,
    aiModel,
    aiSystemPrompt,
    aiVoice,
    aiTrigger,
    openaiApiKey,
    lang,
  } = config;

  const noCamera = !camera;
  const noMic = !mic;

  // Resolve bot name
  let botName = botNameOpt ?? "OpenUtter Bot";
  if (!botNameOpt && existsSync(CONFIG_FILE)) {
    try {
      const configData = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as { botName?: string };
      if (configData.botName) {
        botName = configData.botName;
      }
    } catch {
      // Use default
    }
  }

  mkdirSync(OPENUTTER_DIR, { recursive: true });
  mkdirSync(OPENUTTER_WORKSPACE_DIR, { recursive: true });

  console.log(`OpenUtter AI — Joining meeting: ${meetUrl}`);
  console.log(`  Bot name: ${botName}`);
  console.log(`  Camera: ${noCamera ? "off" : "on"}, Mic: ${noMic ? "off" : "on"}`);
  console.log(`  AI mode: ${aiEnabled ? `ON (model: ${aiModel}, voice: ${aiVoice})` : "OFF"}`);
  if (aiEnabled && aiTrigger) {
    console.log(`  AI trigger: "${aiTrigger}"`);
  }
  if (durationMs) {
    console.log(`  Max duration: ${Math.round(durationMs / 60_000)}m`);
  }

  // Import playwright-core
  let pw: typeof import("playwright-core");
  try {
    pw = await import("playwright-core");
  } catch {
    console.error("playwright-core not found. Run `npm install`.");
    process.exit(1);
  }

  const userDataDir = join(OPENUTTER_DIR, "chrome-profile");
  mkdirSync(userDataDir, { recursive: true });

  const hasAuth = !noAuth && existsSync(AUTH_FILE);
  console.log(`  Language: ${lang}`);

  if (noAuth) {
    console.log("  Joining as guest (--anon)");
  } else if (hasAuth) {
    console.log(`  Using saved auth: ${AUTH_FILE}`);
  } else {
    console.log("  No auth.json found — joining as guest");
  }

  // Chromium launch args — for AI mode, do NOT use fake device
  // because we need the virtual audio stream to work
  const chromiumArgs = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--use-fake-ui-for-media-stream",
    "--auto-select-desktop-capture-source=Entire screen",
    "--disable-dev-shm-usage",
    "--window-size=1280,720",
  ];

  // Only use fake device when NOT in AI mode (AI mode uses virtual audio)
  if (!aiEnabled) {
    chromiumArgs.push("--use-fake-device-for-media-stream");
  }

  if (!headed) {
    chromiumArgs.push("--headless=new", "--disable-gpu");
  }

  // Launch browser and create context
  let context: BrowserContext;
  let page: Page;

  if (hasAuth) {
    const browser = await pw.chromium.launch({
      headless: !headed,
      args: chromiumArgs,
      ignoreDefaultArgs: ["--enable-automation"],
    });
    context = await browser.newContext({
      storageState: AUTH_FILE,
      viewport: { width: 1280, height: 720 },
      permissions: ["camera", "microphone"],
      locale: lang,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    page = await context.newPage();
  } else {
    context = await pw.chromium.launchPersistentContext(userDataDir, {
      headless: true,
      args: chromiumArgs,
      ignoreDefaultArgs: ["--enable-automation"],
      viewport: { width: 1280, height: 720 },
      permissions: ["camera", "microphone"],
      locale: lang,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    page = context.pages()[0] ?? (await context.newPage());
  }

  // Stealth patches
  await context.addInitScript(buildStealthScript(lang));

  // Set up virtual audio BEFORE navigating (if AI mode)
  if (aiEnabled) {
    await setupVirtualAudio(context);
    console.log("  Virtual audio stream configured");
  }

  // Join the meeting with retry logic
  const MAX_JOIN_RETRIES = 3;
  let currentContext = context;
  let currentPage = page;
  let joined = false;

  for (let attempt = 1; attempt <= MAX_JOIN_RETRIES; attempt++) {
    console.log(`\nNavigating to meeting... (attempt ${attempt}/${MAX_JOIN_RETRIES})`);
    await currentPage.goto(meetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await currentPage.waitForTimeout(3000);

    await dismissOverlays(currentPage);

    if (await isBlockedFromJoining(currentPage)) {
      console.warn(`  Blocked: "You can't join this video call" (attempt ${attempt})`);
      if (attempt < MAX_JOIN_RETRIES) {
        console.log("  Retrying with fresh incognito browser context...");
        await currentContext.close();

        const browser = await pw.chromium.launch({
          headless: !headed,
          args: chromiumArgs,
          ignoreDefaultArgs: ["--enable-automation"],
        });
        currentContext = await browser.newContext({
          viewport: { width: 1280, height: 720 },
          permissions: ["camera", "microphone"],
          locale: lang,
          userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        });
        await currentContext.addInitScript(buildStealthScript(lang));
        if (aiEnabled) {
          await setupVirtualAudio(currentContext);
        }
        currentPage = await currentContext.newPage();
        continue;
      }

      const screenshotPath = join(OPENUTTER_WORKSPACE_DIR, "debug-join-failed.png");
      await currentPage.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      console.error(`[OPENUTTER_DEBUG_IMAGE] ${screenshotPath}`);
      await currentContext.close();
      throw new Error(
        `Blocked from joining after ${MAX_JOIN_RETRIES} attempts. Debug screenshot: ${screenshotPath}`,
      );
    }

    await enterNameIfNeeded(currentPage, botName);
    await disableMediaOnPreJoin(currentPage, { noCamera, noMic });
    await currentPage.waitForTimeout(1000);

    console.log("\nAttempting to join...");
    joined = await clickJoinButton(currentPage);

    if (joined) {
      await currentPage.waitForTimeout(2000);
      try {
        const secondJoin = currentPage.locator('button:has-text("Join now")').first();
        if (await secondJoin.isVisible({ timeout: 2000 })) {
          await secondJoin.click();
          console.log("  Clicked second join button (2-step preview)");
        }
      } catch {
        // Single-step flow
      }
    }

    if (joined) {
      registerScreenshotHandler(currentPage);
      try {
        await waitUntilInMeeting(currentPage);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  Post-join block: ${msg} (attempt ${attempt})`);
        joined = false;
      }
    }

    if (attempt < MAX_JOIN_RETRIES) {
      console.log(`  Retrying with fresh context... (attempt ${attempt}/${MAX_JOIN_RETRIES})`);
      await currentContext.close();

      const browser = await pw.chromium.launch({
        headless: !headed,
        args: chromiumArgs,
        ignoreDefaultArgs: ["--enable-automation"],
      });
      currentContext = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        permissions: ["camera", "microphone"],
        locale: lang,
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      });
      await currentContext.addInitScript(buildStealthScript(lang));
      if (aiEnabled) {
        await setupVirtualAudio(currentContext);
      }
      currentPage = await currentContext.newPage();
      continue;
    }
  }

  if (!joined) {
    const screenshotPath = join(OPENUTTER_WORKSPACE_DIR, "debug-join-failed.png");
    await currentPage.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    console.error("Could not join the meeting after all attempts.");
    console.error(`[OPENUTTER_DEBUG_IMAGE] ${screenshotPath}`);
    await currentContext.close();
    throw new Error(
      `Failed to join after ${MAX_JOIN_RETRIES} attempts. Debug screenshot: ${screenshotPath}`,
    );
  }

  // Successfully in the meeting
  const successScreenshotPath = join(OPENUTTER_WORKSPACE_DIR, "joined-meeting.png");
  await currentPage.screenshot({ path: successScreenshotPath }).catch(() => {});
  console.log("\nSuccessfully joined the meeting!");
  console.log(`[OPENUTTER_JOINED] ${meetUrl}`);

  await dismissPostJoinDialogs(currentPage);

  // Enable captions
  await enableCaptions(currentPage);

  const meetingId = extractMeetingId(meetUrl);
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  const transcriptPath = join(TRANSCRIPTS_DIR, `${meetingId}.txt`);
  writeFileSync(transcriptPath, "");

  // Set up AI pipeline if enabled
  let aiResponder: AIResponder | undefined;
  let ttsEngine: TTSEngine | undefined;
  let aiProcessingQueue: Promise<void> = Promise.resolve();

  if (aiEnabled && openaiApiKey) {
    aiResponder = new AIResponder({
      apiKey: openaiApiKey,
      model: aiModel,
      systemPrompt: aiSystemPrompt,
      trigger: aiTrigger,
    });

    ttsEngine = new TTSEngine({ apiKey: openaiApiKey });
    console.log("  AI responder and TTS engine initialized");
  }

  // Flag to pause caption processing while AI is responding
  let aiResponding = false;

  // Caption callback for AI processing
  const onCaption = aiEnabled
    ? (speaker: string, text: string) => {
        if (!aiResponder || !ttsEngine) return;

        // Skip captions from the bot itself (TTS audio shows as 'You' or 'Me' in Meet)
        const speakerLower = speaker.toLowerCase();
        if (
          speakerLower === "you" ||
          speakerLower === "me" ||
          speakerLower === botName.toLowerCase()
        ) return;

        // Don't process new captions while AI is generating/speaking
        if (aiResponding) return;

        // Queue AI processing to avoid overlapping responses
        aiProcessingQueue = aiProcessingQueue.then(async () => {
          try {
            // Don't respond while audio is playing
            const playing = await isPlaying(currentPage).catch(() => false);
            if (playing) return;

            if (verbose) {
              console.log(`  [ai] Processing caption from ${speaker}: "${text}"`);
            }

            const response = await aiResponder!.processCaption(speaker, text);
            if (!response) return;

            console.log(`  [ai] Response: "${response.slice(0, 80)}${response.length > 80 ? "..." : ""}"`);

            aiResponding = true;
            try {
              const audioBuffer = await ttsEngine!.synthesize(response, aiVoice);
              if (verbose) {
                console.log(`  [ai] TTS generated ${audioBuffer.length} bytes`);
              }

              await injectAudio(currentPage, audioBuffer);
              if (verbose) {
                console.log("  [ai] Audio injected successfully");
              }
            } finally {
              aiResponding = false;
            }
          } catch (err) {
            aiResponding = false;
            console.error(
              "  [ai] Pipeline error:",
              err instanceof Error ? err.message : String(err),
            );
          }
        });
      }
    : undefined;

  // Start caption capture
  const { cleanup: cleanupCaptions, getLastCaptionAt } = await setupCaptionCapture(
    currentPage,
    transcriptPath,
    verbose,
    onCaption ? { onCaption, botName, debounceMs: 3000 } : { botName },
  );

  console.log(
    aiEnabled
      ? "Listening and responding with AI... (Ctrl+C to leave)"
      : "Waiting in meeting, capturing captions... (Ctrl+C to leave)",
  );

  // Wait for meeting to end
  const reason = await waitForMeetingEnd(currentPage, {
    durationMs,
    captionIdleTimeoutMs: 10 * 60_000,
    getLastCaptionAt,
  });
  console.log(`\nLeaving meeting: ${reason}`);

  // Flush remaining captions
  cleanupCaptions();

  // Wait for any pending AI processing
  await aiProcessingQueue;

  if (existsSync(transcriptPath)) {
    const content = readFileSync(transcriptPath, "utf-8").trim();
    if (content) {
      console.log(`[OPENUTTER_TRANSCRIPT] ${transcriptPath}`);
    } else {
      console.log("No captions were captured.");
    }
  }

  await currentContext.close();
  cleanupPidFile();
  console.log("Done.");
}
