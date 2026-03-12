/**
 * config.ts — CLI argument parsing and configuration for OpenUtter AI
 */
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
    ai: boolean;
    aiModel: string;
    aiSystemPrompt: string;
    aiVoice: string;
    aiTrigger: string | undefined;
    openaiApiKey: string | undefined;
}
export declare function parseConfig(): Config;
