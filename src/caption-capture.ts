/**
 * caption-capture.ts — Real-time caption capture from Google Meet
 *
 * Extracted from utter-join.ts. Uses a MutationObserver in the browser
 * to watch for caption DOM changes, bridged to Node.js via page.exposeFunction.
 *
 * Based on: https://www.recall.ai/blog/how-i-built-an-in-house-google-meet-bot
 */

import type { Page } from "playwright-core";
import { appendFileSync } from "node:fs";

/**
 * Caption observer script — injected into the browser context as a string.
 *
 * Uses the Recall.ai approach:
 * - MutationObserver watches for addedNodes + characterData changes
 * - Speaker name extracted from .NWpY1d / .xoMHSc badge elements
 * - Caption text = element text minus speaker badge text
 * - Calls window.__openutter_onCaption(speaker, text) which bridges to Node.js
 */
const CAPTION_OBSERVER_SCRIPT = `
(function() {
  var BADGE_SEL = ".NWpY1d, .xoMHSc";
  var captionContainer = null;

  var getSpeaker = function(node) {
    if (!node || !node.querySelector) return "";
    var badge = node.querySelector(BADGE_SEL);
    return badge ? badge.textContent.trim() : "";
  };

  var getText = function(node) {
    if (!node || !node.cloneNode) return "";
    var clone = node.cloneNode(true);
    var badges = clone.querySelectorAll ? clone.querySelectorAll(BADGE_SEL) : [];
    for (var i = 0; i < badges.length; i++) badges[i].remove();
    var imgs = clone.querySelectorAll ? clone.querySelectorAll("img") : [];
    for (var j = 0; j < imgs.length; j++) imgs[j].remove();
    return clone.textContent.trim();
  };

  var send = function(node) {
    if (!(node instanceof HTMLElement)) return;

    var el = node;
    var speaker = "";
    for (var depth = 0; depth < 6 && el && el !== document.body; depth++) {
      speaker = getSpeaker(el);
      if (speaker) break;
      el = el.parentElement;
    }

    if (!speaker || !el) return;

    var text = getText(el);
    if (!text || text.length > 500) return;

    if (/^(mic_off|videocam|call_end|more_vert|keyboard|arrow_)/i.test(text)) return;
    if (text.indexOf("extension") !== -1 && text.indexOf("developers.google") !== -1) return;

    try {
      window.__openutter_onCaption(speaker, text);
    } catch(e) {}
  };

  new MutationObserver(function(mutations) {
    if (!captionContainer || !document.contains(captionContainer)) {
      captionContainer = document.querySelector('[aria-label="Captions"]') ||
                         document.querySelector('[aria-live]');
    }

    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];

      if (captionContainer && !captionContainer.contains(m.target)) continue;

      var added = m.addedNodes;
      for (var j = 0; j < added.length; j++) {
        if (added[j] instanceof HTMLElement) send(added[j]);
      }

      if (m.type === "characterData" && m.target && m.target.parentElement) {
        send(m.target.parentElement);
      }
    }
  }).observe(document.body, {
    childList: true,
    characterData: true,
    subtree: true
  });

  console.log("[OpenUtter] Caption observer active");
})();
`;

export interface CaptionCaptureOptions {
  /** Called when a caption is finalized (speaker stopped talking for debounce period) */
  onCaption?: (speaker: string, text: string) => void;
  /** Bot name — captions from 'You', 'Me', or botName are skipped */
  botName?: string;
  /** Debounce timeout in ms (default: 3000) */
  debounceMs?: number;
}

export interface CaptionCaptureResult {
  cleanup: () => void;
  getLastCaptionAt: () => number;
}

/**
 * Normalize text for fuzzy comparison — lowercase, collapse whitespace, strip punctuation.
 * Google Meet changes capitalization and punctuation mid-stream.
 */
function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Set up real-time caption capture using page.exposeFunction.
 * Captions flow directly from browser -> Node.js via IPC, no polling needed.
 */
export async function setupCaptionCapture(
  page: Page,
  transcriptPath: string,
  verbose: boolean,
  options?: CaptionCaptureOptions,
): Promise<CaptionCaptureResult> {
  const onCaptionCallback = options?.onCaption;
  const botName = options?.botName;
  const debounceMs = options?.debounceMs ?? 3000;

  // Track the current in-progress caption per speaker
  const tracking = new Map<string, { text: string; ts: number; startTs: number }>();
  // Track what was already written to disk per speaker to avoid duplicates
  const lastWritten = new Map<string, string>();
  let lastMinuteKey = "";
  let lastCaptionAt = Date.now();

  const finalizeCaption = (speaker: string, text: string, startTs: number): void => {
    const prevWritten = lastWritten.get(speaker) ?? "";
    const normNew = normalizeForCompare(text);
    const normPrev = normalizeForCompare(prevWritten);

    if (
      normPrev &&
      (normNew === normPrev ||
        normPrev.startsWith(normNew) ||
        (normNew.startsWith(normPrev) && normNew.length - normPrev.length < 5))
    ) {
      return;
    }

    lastWritten.set(speaker, text);

    const d = new Date(startTs);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const minuteKey = `${hh}:${mm}`;

    let prefix = "";
    if (lastMinuteKey && minuteKey !== lastMinuteKey) {
      prefix = "\n";
    }
    lastMinuteKey = minuteKey;

    const line = `[${hh}:${mm}:${ss}] ${speaker}: ${text}`;
    try {
      appendFileSync(transcriptPath, `${prefix}${line}\n`);
    } catch {
      // File write error
    }
    lastCaptionAt = Date.now();
    if (verbose) {
      console.log(`  [caption] ${line}`);
    }

    // Fire callback for AI processing
    if (onCaptionCallback) {
      try {
        onCaptionCallback(speaker, text);
      } catch (err) {
        console.error(
          "  [caption] onCaption callback error:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  };

  // Bridge browser -> Node.js
  await page.exposeFunction("__openutter_onCaption", (speaker: string, text: string) => {
    // Skip self-captions (bot's TTS shows as 'You' or 'Me')
    const speakerLower = speaker.toLowerCase();
    if (
      speakerLower === "you" ||
      speakerLower === "me" ||
      (botName && speakerLower === botName.toLowerCase())
    ) {
      return;
    }

    const existing = tracking.get(speaker);
    const prevWritten = lastWritten.get(speaker) ?? "";

    const normNew = normalizeForCompare(text);
    const normWritten = normalizeForCompare(prevWritten);
    if (normWritten && (normNew === normWritten || normWritten.startsWith(normNew))) {
      return;
    }

    if (existing) {
      const normOld = normalizeForCompare(existing.text);

      const isGrowing =
        normNew.startsWith(normOld) ||
        normOld.startsWith(normNew) ||
        (normNew.length > normOld.length &&
          normNew.includes(normOld.slice(0, Math.min(20, normOld.length))));

      if (isGrowing) {
        if (text.length >= existing.text.length) {
          existing.text = text;
          existing.ts = Date.now();
        }
        return;
      }

      // Genuinely different text — finalize previous
      finalizeCaption(speaker, existing.text, existing.startTs);
    }

    tracking.set(speaker, { text, ts: Date.now(), startTs: Date.now() });
  });

  // Periodically finalize stale captions (text unchanged for debounceMs)
  const settleInterval = setInterval(() => {
    const now = Date.now();
    for (const [speaker, data] of tracking.entries()) {
      if (now - data.ts >= debounceMs) {
        finalizeCaption(speaker, data.text, data.startTs);
        tracking.delete(speaker);
      }
    }
  }, 1000);

  // Inject the browser-side MutationObserver
  await page.evaluate(CAPTION_OBSERVER_SCRIPT);

  return {
    getLastCaptionAt: () => lastCaptionAt,
    cleanup: () => {
      clearInterval(settleInterval);
      for (const [speaker, data] of tracking.entries()) {
        finalizeCaption(speaker, data.text, data.startTs);
      }
      tracking.clear();
    },
  };
}
