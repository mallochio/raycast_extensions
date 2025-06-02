export interface Preferences {
  provider: string;
  model: string;
  apiKey: string;
  systemPrompt: string;
  customEndpoint?: string; // New field for custom OpenAI-compatible endpoint
}

export interface Model {
  id: string;
  name: string;
  provider: string;
}
