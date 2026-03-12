/**
 * config.ts — CLI argument parsing and configuration for OpenUtter AI
 */

import dotenv from "dotenv";

dotenv.config();

export interface Config {
  meetUrl: string;
  auth: boolean;
  anon: boolean;
  botName: string;
  headed: boolean;
  camera: boolean;
  mic: boolean;
  verbose: boolean;
  durationMs: number | undefined;
  channel: string | undefined;
  target: string | undefined;

  // AI mode
  ai: boolean;
  aiModel: string;
  aiSystemPrompt: string;
  aiVoice: string;
  aiTrigger: string | undefined;
  openaiApiKey: string | undefined;

  // Locale
  lang: string;
}

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

function parseDuration(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = raw.match(/^(\d+)(ms|s|m|h)?$/);
  if (!match) return undefined;
  const value = parseInt(match[1]!, 10);
  const unit = match[2] ?? "ms";
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
  };
  return value * (multipliers[unit] ?? 1);
}

export function parseConfig(): Config {
  const args = process.argv.slice(2);

  const meetUrl = args.find((a) => !a.startsWith("--"));
  if (!meetUrl) {
    console.error(
      "Usage: openutter-ai <meet-url> [--auth|--anon] [--bot-name <name>] [--ai] [options...]",
    );
    console.error("");
    console.error("Options:");
    console.error("  --auth                 Join using saved Google account (~/.openutter/auth.json)");
    console.error("  --anon                 Join as a guest (requires --bot-name)");
    console.error("  --bot-name <name>      Display name for the bot");
    console.error("  --headed               Show the browser window");
    console.error("  --camera               Enable camera (default: off)");
    console.error("  --mic                  Enable microphone (default: off)");
    console.error("  --verbose              Verbose caption logging");
    console.error("  --duration <time>      Max meeting duration (e.g. 60m, 2h)");
    console.error("  --channel <channel>    Notification channel");
    console.error("  --target <id>          Notification target");
    console.error("");
    console.error("AI Options:");
    console.error("  --ai                   Enable AI conversation mode");
    console.error("  --ai-model <model>     OpenAI model (default: gpt-4o-mini)");
    console.error("  --ai-system-prompt <p> System prompt for the AI");
    console.error("  --ai-voice <voice>     TTS voice (default: alloy)");
    console.error("  --ai-trigger <word>    Only respond when text contains this keyword");
    console.error("");
    console.error("Locale Options:");
    console.error("  --lang <code>          Caption/browser language (default: ko-KR)");
    process.exit(1);
  }

  const auth = args.includes("--auth");
  const anon = args.includes("--anon");

  if (!auth && !anon) {
    console.error("ERROR: You must specify either --auth or --anon.");
    console.error("  --auth  Join using saved Google account (~/.openutter/auth.json)");
    console.error("  --anon  Join as a guest (no Google account)");
    process.exit(1);
  }

  if (auth && anon) {
    console.error("ERROR: Cannot use both --auth and --anon.");
    process.exit(1);
  }

  const botName = getArgValue(args, "--bot-name") ?? "OpenUtter Bot";

  if (anon && !getArgValue(args, "--bot-name")) {
    console.error("ERROR: --anon requires --bot-name <name>.");
    process.exit(1);
  }

  const ai = args.includes("--ai");
  const openaiApiKey = process.env.OPENAI_API_KEY;

  if (ai && !openaiApiKey) {
    console.error("ERROR: --ai requires OPENAI_API_KEY environment variable.");
    console.error("Set it in .env or export it in your shell.");
    process.exit(1);
  }

  return {
    meetUrl,
    auth,
    anon,
    botName,
    headed: args.includes("--headed"),
    camera: args.includes("--camera"),
    mic: args.includes("--mic"),
    verbose: args.includes("--verbose"),
    durationMs: parseDuration(getArgValue(args, "--duration")),
    channel: getArgValue(args, "--channel"),
    target: getArgValue(args, "--target"),
    ai,
    aiModel: getArgValue(args, "--ai-model") ?? "gpt-4o-mini",
    aiSystemPrompt:
      getArgValue(args, "--ai-system-prompt") ??
      "You are a helpful meeting assistant. Keep responses concise and relevant to the conversation.",
    aiVoice: getArgValue(args, "--ai-voice") ?? "alloy",
    aiTrigger: getArgValue(args, "--ai-trigger"),
    openaiApiKey,
    lang: getArgValue(args, "--lang") ?? "ko-KR",
  };
}
