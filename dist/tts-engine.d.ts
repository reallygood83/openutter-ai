/**
 * tts-engine.ts — OpenAI Text-to-Speech integration
 *
 * Uses the tts-1 model for low-latency speech synthesis.
 * Returns MP3 audio as a Buffer.
 */
export interface TTSEngineOptions {
    apiKey: string;
}
export declare class TTSEngine {
    private client;
    constructor(options: TTSEngineOptions);
    /**
     * Synthesize text to speech using OpenAI TTS API.
     * Returns the audio as a Buffer in MP3 format.
     */
    synthesize(text: string, voice?: string): Promise<Buffer>;
}
