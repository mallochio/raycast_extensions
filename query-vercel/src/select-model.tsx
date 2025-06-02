import { useState } from "react";
import { ActionPanel, Action, Detail, showToast, Toast } from "@raycast/api";
import { getPreferenceValues, setPreferenceValues } from "@raycast/api";
import ModelDropdown from "./ModelDropdown";
import { Preferences } from "./types";

export default function Command() {
  const preferences = getPreferenceValues<Preferences>();
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  const handleSelectModel = async (model: { id: string; name: string }) => {
    try {
      await setPreferenceValues({ ...preferences, model: model.id });
      showToast({
        style: Toast.Style.Success,
        title: "Model Selected",
        message: `Using model: ${model.name}`,
      });
      setSelectedModel(model.name);
    } catch (error) {
      showToast({
        style: Toast.Style.Failure,
        title: "Failed to set model",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  if (selectedModel) {
    return (
      <Detail
        markdown={`## Model Selected\n\nYou have selected: **${selectedModel}**\n\nYou can now use this model in the chat command.`}
      />
    );
  }

  return <ModelDropdown onSelect={handleSelectModel} />;
}
