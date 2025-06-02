import { getPreferenceValues } from "@raycast/api";
import fetch from "node-fetch";
import { Preferences, Model } from "./types";

const CACHE_DURATION = 60 * 60 * 1000; // 1 hour
let modelCache: { models: Model[]; timestamp: number } | null = null;

export async function fetchModels(): Promise<Model[]> {
  const preferences = getPreferenceValues<Preferences>();
  const endpoint = preferences.customEndpoint || "https://api.openai.com/v1";

  try {
    const response = await fetch(`${endpoint}/models`, {
      headers: {
        Authorization: `Bearer ${preferences.apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.data.map((model: any) => ({
      id: model.id,
      name: model.id,
      provider: preferences.provider || "openai-compatible",
    }));
  } catch (error) {
    console.error("Error fetching models:", error);
    return [];
  }
}

export async function getCachedModels(): Promise<Model[]> {
  const now = Date.now();
  if (modelCache && now - modelCache.timestamp < CACHE_DURATION) {
    return modelCache.models;
  }

  const models = await fetchModels();
  modelCache = {
    models,
    timestamp: now,
  };
  return models;
}
