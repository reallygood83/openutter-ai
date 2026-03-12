/**
 * audio-injector.ts — Inject TTS audio into Google Meet via virtual MediaStream
 *
 * Strategy:
 * 1. Before the page loads, monkey-patch navigator.mediaDevices.getUserMedia
 *    via context.addInitScript() so that audio requests return a virtual
 *    MediaStreamDestination stream instead of a real microphone.
 * 2. When TTS audio needs to play, decode it in the browser's AudioContext
 *    and route it through the same MediaStreamDestination.
 * 3. Google Meet sees the virtual stream as the microphone input.
 */
import type { BrowserContext, Page } from "playwright-core";
/**
 * Set up the virtual audio infrastructure. Must be called BEFORE
 * navigating to Google Meet so the getUserMedia patch is in place.
 */
export declare function setupVirtualAudio(context: BrowserContext): Promise<void>;
/**
 * Inject audio into the virtual MediaStream so Google Meet participants hear it.
 *
 * @param page - The Playwright page with the Google Meet session
 * @param audioBuffer - MP3 audio data as a Buffer
 */
export declare function injectAudio(page: Page, audioBuffer: Buffer): Promise<void>;
/**
 * Check if audio is currently being played through the virtual stream.
 */
export declare function isPlaying(page: Page): Promise<boolean>;
