/**
 * tts-engine.ts — OpenAI Text-to-Speech integration
 *
 * Uses the tts-1 model for low-latency speech synthesis.
 * Returns MP3 audio as a Buffer.
 */

import OpenAI from "openai";

export interface TTSEngineOptions {
  apiKey: string;
}

type TTSVoice = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;

export class TTSEngine {
  private client: OpenAI;

  constructor(options: TTSEngineOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey });
  }

  /**
   * Synthesize text to speech using OpenAI TTS API.
   * Returns the audio as a Buffer in MP3 format.
   */
  async synthesize(text: string, voice: string = "alloy"): Promise<Buffer> {
    // Validate voice
    const validVoices: TTSVoice[] = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
    const ttsVoice: TTSVoice = validVoices.includes(voice as TTSVoice)
      ? (voice as TTSVoice)
      : "alloy";

    // Truncate very long text to avoid API limits
    const maxChars = 4096;
    const inputText = text.length > maxChars ? text.slice(0, maxChars) : text;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.client.audio.speech.create({
          model: "tts-1",
          voice: ttsVoice,
          input: inputText,
          response_format: "mp3",
          speed: 1.0,
        });

        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      } catch (err: unknown) {
        const isRetryable =
          err instanceof OpenAI.APIError &&
          err.status !== undefined &&
          (err.status === 429 || err.status >= 500);

        if (isRetryable && attempt < MAX_RETRIES) {
          const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
          console.error(`  [tts] API error, retrying in ${delay}ms...`);
          await sleep(delay);
          continue;
        }

        throw new Error(
          `TTS synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Unreachable, but TypeScript needs it
    throw new Error("TTS synthesis failed after all retries");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
