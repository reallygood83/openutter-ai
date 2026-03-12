/**
 * caption-capture.ts — Real-time caption capture from Google Meet
 *
 * Extracted from utter-join.ts. Uses a MutationObserver in the browser
 * to watch for caption DOM changes, bridged to Node.js via page.exposeFunction.
 *
 * Based on: https://www.recall.ai/blog/how-i-built-an-in-house-google-meet-bot
 */
import type { Page } from "playwright-core";
export interface CaptionCaptureOptions {
    /** Called when a caption is finalized (speaker stopped talking for 5s) */
    onCaption?: (speaker: string, text: string) => void;
}
export interface CaptionCaptureResult {
    cleanup: () => void;
    getLastCaptionAt: () => number;
}
/**
 * Set up real-time caption capture using page.exposeFunction.
 * Captions flow directly from browser -> Node.js via IPC, no polling needed.
 */
export declare function setupCaptionCapture(page: Page, transcriptPath: string, verbose: boolean, options?: CaptionCaptureOptions): Promise<CaptionCaptureResult>;
