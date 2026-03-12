#!/usr/bin/env node
/**
 * OpenUtter AI — Google Meet AI conversation agent
 *
 * Join meetings, capture captions, and optionally respond with AI.
 */

import dotenv from "dotenv";
dotenv.config();

import { parseConfig } from "./config.js";
import { runBot } from "./meet-bot.js";

async function main(): Promise<void> {
  const config = parseConfig();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      console.log("\nForce quit.");
      process.exit(1);
    }
    shuttingDown = true;
    console.log("\nShutting down gracefully... (press Ctrl+C again to force quit)");
    // The runBot function handles cleanup via waitForMeetingEnd detecting page navigation
    // Give it a moment, then force exit
    setTimeout(() => {
      console.log("Timeout waiting for graceful shutdown, exiting.");
      process.exit(0);
    }, 5000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await runBot(config);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
