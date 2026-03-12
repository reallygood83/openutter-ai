/**
 * ai-responder.ts — OpenAI Chat Completions integration for meeting AI
 *
 * Maintains conversation history, processes captions, and generates responses.
 * Supports optional trigger keyword filtering.
 */
export interface AIResponderOptions {
    apiKey: string;
    model: string;
    systemPrompt: string;
    trigger?: string;
}
export declare class AIResponder {
    private client;
    private model;
    private systemPrompt;
    private trigger;
    private history;
    constructor(options: AIResponderOptions);
    /**
     * Process a finalized caption from a meeting participant.
     * Returns the AI response text, or null if the bot should not respond
     * (e.g., trigger keyword not present, or the caption is from the bot itself).
     */
    processCaption(speaker: string, text: string): Promise<string | null>;
    private addToHistory;
    private callWithRetry;
}
