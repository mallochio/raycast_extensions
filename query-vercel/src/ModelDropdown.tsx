import { useState, useEffect } from "react";
import { List, ActionPanel, Action, showToast, Toast } from "@raycast/api";
import { getCachedModels } from "./api-service";
import { Model } from "./types";

interface ModelDropdownProps {
  onSelect: (model: Model) => void;
}

export default function ModelDropdown({ onSelect }: ModelDropdownProps) {
  const [models, setModels] = useState<Model[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadModels() {
      try {
        setIsLoading(true);
        const fetchedModels = await getCachedModels();
        setModels(fetchedModels);
      } catch (error) {
        showToast({
          style: Toast.Style.Failure,
          title: "Failed to load models",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        setIsLoading(false);
      }
    }

    loadModels();
  }, []);

  return (
    <List isLoading={isLoading}>
      {models.map((model) => (
        <List.Item
          key={model.id}
          title={model.name}
          subtitle={model.provider}
          actions={
            <ActionPanel>
              <Action title="Select Model" onAction={() => onSelect(model)} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
