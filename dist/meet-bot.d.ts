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
import type { Config } from "./config.js";
export declare function runBot(config: Config): Promise<void>;
