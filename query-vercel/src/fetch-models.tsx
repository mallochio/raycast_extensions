import { useState, useEffect } from "react";
import { List, ActionPanel, Action, Detail } from "@raycast/api";
import { fetchOpenAIModels, fetchAnthropicModels, fetchGoogleModels } from "./api-service";

interface Model {
  id: string;
  name: string;
  provider: string;
}

export default function Command() {
  const [models, setModels] = useState<Model[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadModels() {
      try {
        setIsLoading(true);
        const [openaiModels, anthropicModels, googleModels] = await Promise.all([
          fetchOpenAIModels(),
          fetchAnthropicModels(),
          fetchGoogleModels(),
        ]);
        setModels([...openaiModels, ...anthropicModels, ...googleModels]);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error occurred");
      } finally {
        setIsLoading(false);
      }
    }

    loadModels();
  }, []);

  if (error) {
    return <Detail markdown={`Error: ${error}`} />;
  }

  return (
    <List isLoading={isLoading}>
      {models.map((model) => (
        <List.Item
          key={model.id}
          title={model.name}
          subtitle={model.provider}
          actions={
            <ActionPanel>
              <Action.CopyToClipboard content={model.id} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
