import React, { useState, useMemo } from "react";
import {
  Form,
  ActionPanel,
  Action,
  Detail,
  showToast,
  Toast,
  getPreferenceValues,
  useNavigation,
  Icon,
  environment,
  open,
} from "@raycast/api";
import { streamText, StreamTextResult } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

// Custom error message handler
const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return "An unknown error occurred";
};

interface Preferences {
  provider: string;
  model: string;
  apiKey: string;
  systemPrompt: string;
}

interface Message {
  role: "user" | "assistant" | "error";
  content: string;
  timestamp: number;
}

function MessageInputForm(props: { onSubmit: (query: string) => void }) {
  const { pop } = useNavigation();
  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Send Message"
            onSubmit={(values: { query: string }) => {
              if (values.query?.trim()) {
                props.onSubmit(values.query);
                pop();
              } else {
                showToast({ style: Toast.Style.Failure, title: "Message cannot be empty" });
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextArea id="query" title="New Message" placeholder="Type your message here..." autoFocus />
    </Form>
  );
}

export default function Command() {
  const preferences = getPreferenceValues<Preferences>();
  const { push } = useNavigation();

  const [isLoading, setIsLoading] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamCounter, setStreamCounter] = useState(0);

  const formattedConversation = useMemo(() => {
    let md = messages
      .map((msg) => {
        const roleTitle = msg.role === "user" ? "You" : msg.role === "assistant" ? "Assistant" : "Error";
        const icon = msg.role === "user" ? "👤" : msg.role === "assistant" ? "🤖" : "⚠️";
        const content = msg.content;
        const looksLikeCode =
          content.includes("```") ||
          (content.includes("\n") && (content.includes(";") || content.includes("{") || content.includes("}")));
        const formattedContent = looksLikeCode
          ? `
\`\`\`
${content.trim()}
\`\`\`
`
          : content;
        return `**${icon} ${roleTitle}**:
${formattedContent}

---

`;
      })
      .join("");

    if (
      isLoading &&
      messages.length > 0 &&
      messages[messages.length - 1]?.role === "assistant" &&
      messages[messages.length - 1]?.content === "..."
    ) {
      md += "\n\n*Assistant is thinking...*";
    }
    return md;
  }, [messages, isLoading, streamCounter]);

  const handleSubmit = async (query: string) => {
    const trimmedQuery = query?.trim();
    if (!trimmedQuery) {
      return;
    }

    if (!preferences.apiKey) {
      await showToast({
        style: Toast.Style.Failure,
        title: "API Key Missing",
        message: "Please set the API key in preferences.",
      });
    }

    console.log("handleSubmit triggered for query:", trimmedQuery);

    setIsLoading(true);
    const newUserMessage: Message = { role: "user", content: trimmedQuery, timestamp: Date.now() };
    const assistantPlaceholder: Message = { role: "assistant", content: "...", timestamp: Date.now() + 1 };

    let messagesForApi: Array<{ role: "user" | "assistant" | "system"; content: string }> = [
      ...messages,
      newUserMessage,
    ]
      .filter((msg): msg is Message & { role: "user" | "assistant" } => msg.role === "user" || msg.role === "assistant")
      .map(({ role, content }) => ({ role, content }));

    const systemPrompt = preferences.systemPrompt?.trim();
    if (systemPrompt) {
      console.log("Prepending system prompt:", systemPrompt);
      messagesForApi.unshift({ role: "system", content: systemPrompt });
    } else {
      console.log("No system prompt provided or it's empty.");
    }

    setMessages((prevMessages) => [...prevMessages, newUserMessage, assistantPlaceholder]);
    setStreamCounter((c) => c + 1);

    const assistantMessageId = assistantPlaceholder.timestamp;
    let assistantResponse = "";
    let streamProcessed = false;

    try {
      await showToast({ style: Toast.Style.Animated, title: "Querying AI..." });

      let streamResult: StreamTextResult<any, any>;
      let payload: {
        model: any;
        messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
        providerOptions?: { google?: any };
      } = {
        model: null,
        messages: messagesForApi,
      };

      if (preferences.provider === "openai") {
        const openai = createOpenAI({ apiKey: preferences.apiKey });
        payload.model = openai(preferences.model);
        console.log("Using OpenAI model:", preferences.model);
      } else if (preferences.provider === "anthropic") {
        const anthropic = createAnthropic({ apiKey: preferences.apiKey });
        payload.model = anthropic(preferences.model);
        console.log("Using Anthropic model:", preferences.model);
      } else if (preferences.provider === "google") {
        const google = createGoogleGenerativeAI({ apiKey: preferences.apiKey });
        payload.model = google(preferences.model, {
          useSearchGrounding: true,
          dynamicRetrievalConfig: {
            mode: "MODE_DYNAMIC",
            dynamicThreshold: 0.8,
          },
        });
        console.log(`Using Google model: ${preferences.model} with Search Grounding ENABLED.`);

        if (preferences.model.startsWith("gemini-2.5")) {
          payload.providerOptions = {
            google: {
              thinkingConfig: {
                thinkingBudget: 24576,
              },
            },
          };
          console.log(`Added thinkingBudget: 24576 for ${preferences.model}`);
        }
      } else {
        throw new Error(`Unsupported provider: ${preferences.provider}`);
      }

      console.log("Sending Payload:", JSON.stringify(payload, null, 2));
      streamResult = await streamText(payload);
      console.log("Raw Stream Result received, processing full stream...");

      for await (const part of streamResult.fullStream) {
        switch (part.type) {
          case "text-delta": {
            streamProcessed = true;
            assistantResponse += part.textDelta;
            setMessages((prevMessages) =>
              prevMessages.map((msg) =>
                msg.timestamp === assistantMessageId ? { ...msg, content: assistantResponse } : msg,
              ),
            );
            break;
          }
          case "tool-call": {
            console.log("Tool Call:", { toolCallId: part.toolCallId, toolName: part.toolName, args: part.args });
            break;
          }
          case "tool-result": {
            console.log("Tool Result:", {
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              args: part.args,
              result: part.result,
            });
            break;
          }
          case "finish": {
            console.log("Stream Finish Reason:", part.finishReason);
            console.log("Stream Usage:", part.usage);
            break;
          }
          case "error": {
            console.error("Stream Error Part:", part.error);
            throw new Error(`Stream error: ${part.error}`);
          }
          default: {
            console.log("Unhandled Stream Part:", part);
          }
        }
      }
      console.log("Finished processing full stream. Text processed:", streamProcessed);

      if (!streamProcessed && assistantResponse === "") {
        console.log("assistantResponse is empty and no text-delta parts were processed.");
        setMessages((prevMessages) =>
          prevMessages.map((msg) =>
            msg.timestamp === assistantMessageId
              ? { ...msg, content: "(No response received or stream format issue)" }
              : msg,
          ),
        );
        setStreamCounter((c) => c + 1);
      } else if (assistantResponse === "") {
        console.log(
          "assistantResponse is empty BUT text-delta parts *were* processed (stream likely contained only whitespace).",
        );
        setMessages((prevMessages) =>
          prevMessages.map((msg) =>
            msg.timestamp === assistantMessageId ? { ...msg, content: "(Empty response received)" } : msg,
          ),
        );
        setStreamCounter((c) => c + 1);
      } else {
        console.log("assistantResponse has content. Length:", assistantResponse.length);
        setStreamCounter((c) => c + 1);
      }

      await showToast({ style: Toast.Style.Success, title: "Response received" });
    } catch (err: any) {
      console.error("API Error Caught:", err);
      const errorMessage = err instanceof Error ? err.message : "An unknown error occurred";

      // Enhanced error handling with retry logic
      if (errorMessage.includes("API key is missing")) {
        const detailedMessage =
          "API Key Missing: Please verify your API key is correctly set in Raycast preferences for the selected provider.";
        console.error(detailedMessage);
        await showToast({
          style: Toast.Style.Failure,
          title: "API Key Error",
          message: detailedMessage,
          primaryAction: {
            title: "Open Preferences",
            onAction: async () => {
              await open("raycast://preferences");
            },
          },
        });
      } else if (errorMessage.includes("rate limit") || errorMessage.includes("too many requests")) {
        const retryAfter = 5000; // 5 seconds
        const detailedMessage = `Rate limit exceeded. Retrying after ${retryAfter / 1000} seconds...`;
        console.log(detailedMessage);

        await showToast({
          style: Toast.Style.Animated,
          title: "Rate Limit Exceeded",
          message: detailedMessage,
        });

        // Retry after delay
        await new Promise((resolve) => setTimeout(resolve, retryAfter));
        return handleSubmit(query); // Retry the original request
      } else if (errorMessage.includes("network")) {
        const detailedMessage = "Network Error: Please check your internet connection and try again.";
        console.error(detailedMessage);
        await showToast({
          style: Toast.Style.Failure,
          title: "Network Error",
          message: detailedMessage,
        });
      } else {
        const detailedMessage = `Error: ${errorMessage}. Please try again or contact support if the problem persists.`;
        console.error(detailedMessage);
        await showToast({
          style: Toast.Style.Failure,
          title: "API Error",
          message: detailedMessage,
        });
      }

      // Update the error message in the UI
      const errorMessageContent = `Error: ${errorMessage}`;
      setMessages((prevMessages) =>
        prevMessages.map((msg) =>
          msg.timestamp === assistantMessageId ? { ...msg, role: "error", content: errorMessageContent } : msg,
        ),
      );
      setStreamCounter((c) => c + 1);
    } finally {
      setIsLoading(false);
      console.log("handleSubmit finished.");
    }
  };

  if (!preferences.apiKey) {
    return (
      <Detail markdown="## API Key Not Set 🔑\n\nPlease set your API key for the selected provider in the extension preferences (⌘ + ,) to use this command." />
    );
  }

  if (messages.length > 0) {
    return (
      <Detail
        markdown={formattedConversation}
        isLoading={isLoading}
        navigationTitle={`Chat (${preferences.provider}/${preferences.model})`}
        actions={
          !isLoading ? (
            <ActionPanel>
              <Action.Push
                title="Add Message"
                icon={Icon.Plus}
                target={<MessageInputForm onSubmit={handleSubmit} />}
                shortcut={{ modifiers: ["cmd"], key: "m" }}
              />
              <Action
                title="Clear Conversation"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                onAction={() => {
                  setMessages([]);
                }}
                shortcut={{ modifiers: ["cmd", "shift"], key: "n" }}
              />
              <Action.CopyToClipboard
                title="Copy Conversation"
                content={formattedConversation}
                shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
              />
              <Action.CopyToClipboard
                title="Copy Last Response"
                content={messages.findLast((m) => m.role === "assistant")?.content ?? ""}
                shortcut={{ modifiers: ["cmd", "shift"], key: "l" }}
              />
            </ActionPanel>
          ) : null
        }
      />
    );
  }

  return (
    <Form
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Start Chat" onSubmit={(values: { query: string }) => handleSubmit(values.query)} />
        </ActionPanel>
      }
    >
      <Form.TextArea id="query" title="Initial Message" placeholder="What would you like to ask?" autoFocus />
      <Form.Description text={`Using ${preferences.provider} / ${preferences.model}. Change in preferences (⌘ + ,).`} />
    </Form>
  );
}
