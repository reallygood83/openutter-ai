/**
 * ai-responder.ts — OpenAI Chat Completions integration for meeting AI
 *
 * Maintains conversation history, processes captions, and generates responses.
 * Supports optional trigger keyword filtering.
 */

import OpenAI from "openai";

export interface AIResponderOptions {
  apiKey: string;
  model: string;
  systemPrompt: string;
  trigger?: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const MAX_HISTORY = 20;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

export class AIResponder {
  private client: OpenAI;
  private model: string;
  private systemPrompt: string;
  private trigger: string | undefined;
  private history: ChatMessage[];

  constructor(options: AIResponderOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey });
    this.model = options.model;
    this.systemPrompt = options.systemPrompt;
    this.trigger = options.trigger?.toLowerCase();
    this.history = [];
  }

  /**
   * Process a finalized caption from a meeting participant.
   * Returns the AI response text, or null if the bot should not respond
   * (e.g., trigger keyword not present, or the caption is from the bot itself).
   */
  async processCaption(speaker: string, text: string): Promise<string | null> {
    // If a trigger keyword is configured, only respond when it appears
    if (this.trigger) {
      const lowerText = text.toLowerCase();
      if (!lowerText.includes(this.trigger)) {
        // Still add to history for context, but don't respond
        this.addToHistory("user", `${speaker}: ${text}`);
        return null;
      }
      // Remove the trigger keyword from the text before sending to LLM
      const cleanedText = text.replace(new RegExp(this.trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "").trim();
      if (!cleanedText) {
        return null;
      }
      this.addToHistory("user", `${speaker}: ${cleanedText}`);
    } else {
      this.addToHistory("user", `${speaker}: ${text}`);
    }

    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      ...this.history,
    ];

    const response = await this.callWithRetry(messages);
    if (response) {
      this.addToHistory("assistant", response);
    }
    return response;
  }

  private addToHistory(role: "user" | "assistant", content: string): void {
    this.history.push({ role, content });
    // Keep only the last MAX_HISTORY messages
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
  }

  private async callWithRetry(messages: ChatMessage[]): Promise<string | null> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const completion = await this.client.chat.completions.create({
          model: this.model,
          messages,
          max_tokens: 256,
          temperature: 0.7,
        });

        const content = completion.choices[0]?.message?.content?.trim();
        return content || null;
      } catch (err: unknown) {
        const isRateLimit =
          err instanceof OpenAI.APIError && err.status === 429;
        const isServerError =
          err instanceof OpenAI.APIError &&
          err.status !== undefined &&
          err.status >= 500;

        if ((isRateLimit || isServerError) && attempt < MAX_RETRIES - 1) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          console.error(
            `  [ai] API error (${isRateLimit ? "rate limit" : "server error"}), retrying in ${delay}ms...`,
          );
          await sleep(delay);
          continue;
        }

        console.error(
          "  [ai] Chat completion failed:",
          err instanceof Error ? err.message : String(err),
        );
        return null;
      }
    }
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
