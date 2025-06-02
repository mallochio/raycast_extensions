import React, { useState } from "react";
import { Form, ActionPanel, Action, Detail, showToast, Toast, getPreferenceValues, useNavigation } from "@raycast/api";
import fetch from "node-fetch";
import { GoogleGenAI } from "@google/genai";

// Preferences interface
interface Preferences {
  apiKey: string;
  defaultModel: string;
  defaultSystemPrompt: string;
}

const preferences = getPreferenceValues<Preferences>();

// Initialize Gemini SDK client (for 2.5 models)
const geminiClient = new GoogleGenAI({ apiKey: preferences.apiKey });

// Message type definition
interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

// Gemini specific types
interface GeminiPart {
  text: string;
  thought?: boolean;
}

interface GeminiContent {
  parts: GeminiPart[];
  role?: "user" | "model";
}

interface GroundingSource {
  title: string;
  uri: string;
}

interface GroundingChunk {
  web?: GroundingSource;
}

interface GroundingSegment {
  text: string;
  startIndex?: number;
  endIndex?: number;
}

interface GroundingSupport {
  segment: GroundingSegment;
  groundingChunkIndices: number[];
  confidenceScores: number[];
}

interface GroundingMetadata {
  searchEntryPoint?: {
    renderedContent: string;
  };
  groundingChunks?: GroundingChunk[];
  groundingSupports?: GroundingSupport[];
  webSearchQueries?: string[];
}

interface GeminiCandidate {
  content: {
    parts: GeminiPart[];
    role: string;
  };
  finishReason: string;
  groundingMetadata?: GroundingMetadata;
}

interface GeminiResponse {
  candidates: GeminiCandidate[];
  usageMetadata: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

// A new component for entering a message in a multi-turn conversation
function MessageInputForm(props: { onSubmit: (query: string) => void }) {
  const { pop } = useNavigation();
  const [inputValue, setInputValue] = useState<string>("");
  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            onSubmit={(values: { query: string }) => {
              props.onSubmit(values.query);
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextArea
        id="query"
        title="New Message"
        placeholder="Type your message here"
        autoFocus
        value={inputValue}
        onChange={setInputValue}
      />
    </Form>
  );
}

// Query input form
export default function QueryForm() {
  const [isLoading, setIsLoading] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [systemPrompt] = useState<string>(preferences.defaultSystemPrompt || "");
  const [model] = useState<string>(preferences.defaultModel || "");
  const [inputValue, setInputValue] = useState("");
  const [tokenCount, setTokenCount] = useState(0);
  const [groundingSources, setGroundingSources] = useState<{ [index: number]: GroundingChunk }>({});
  const [searchQueries, setSearchQueries] = useState<string[]>([]);
  const [thinkingTraces, setThinkingTraces] = useState<string[]>([]);

  // Format messages for display in markdown, including grounding information and collapsible thinking traces
  const getFormattedConversation = () => {
    return messages
      .filter((msg) => msg.role !== "system")
      .map((msg, idx) => {
        // User messages remain simple
        if (msg.role === "user") {
          return `### User\n\n${msg.content.trim()}\n\n---`;
        }
        // For assistant messages, format with better visual hierarchy
        const modelName = model || preferences.defaultModel;
        const content = msg.content.trim();
        let formattedMessage = `### ${modelName} (Token Tally: ${tokenCount})\n\n`;

        // Always-visible thinking trace as blockquote (no heading)
        if (thinkingTraces[idx]) {
          formattedMessage += `> ${thinkingTraces[idx].replace(/\n/g, "\n> ")}\n\n`;
        }

        formattedMessage += content;

        if (searchQueries.length > 0) {
          formattedMessage += "\n\n> **Searched for:** " + searchQueries.map((q) => `"${q}"`).join(", ");
        }
        if (Object.keys(groundingSources).length > 0) {
          const sourcesList = Object.values(groundingSources)
            .map((source, index) =>
              source.web ? `[${source.web.title || "Source " + (index + 1)}](${source.web.uri})` : "",
            )
            .filter(Boolean)
            .join(", ");
          formattedMessage += `\n\n> **Sources:** ${sourcesList}`;
        }
        return `${formattedMessage}\n\n---`;
      })
      .join("\n\n");
  };

  async function handleSubmit(query: string) {
    if (!query?.trim()) return;

    try {
      setIsLoading(true);
      setInputValue("");

      const newModel = model || preferences.defaultModel || "gemini-2.0-flash";
      const newSystemPrompt = systemPrompt || preferences.defaultSystemPrompt;

      // Add user message to conversation
      const userMessage: Message = { role: "user", content: query };
      const updatedMessages = [...messages, userMessage];
      setMessages(updatedMessages);

      // Show toast indicating query is in progress
      await showToast({
        style: Toast.Style.Animated,
        title: "Querying Gemini",
        message: `Using model: ${newModel}`,
      });

      // Convert Raycast messages to Gemini format
      const geminiContents: GeminiContent[] = [];

      // Add system prompt if available
      if (newSystemPrompt) {
        geminiContents.push({
          role: "user",
          parts: [{ text: newSystemPrompt }],
        });

        // Add a placeholder assistant response after system prompt
        geminiContents.push({
          role: "model",
          parts: [{ text: "I'll follow those instructions." }],
        });
      }

      // Add conversation messages
      updatedMessages.forEach((msg) => {
        if (msg.role === "system") return;

        geminiContents.push({
          role: msg.role === "user" ? "user" : "model",
          parts: [{ text: msg.content }],
        });
      });

      // Initialize AI's response message
      const aiMessage: Message = { role: "assistant", content: "" };
      setMessages([...updatedMessages, aiMessage]);

      // SDK path for Gemini 2.5 models
      if (newModel.startsWith("gemini-2.5")) {
        try {
          // Prepare the prompt as a string (Gemini 2.5 expects a string or array of strings)
          const prompt: string[] = [];
          if (systemPrompt) {
            prompt.push(systemPrompt);
          }
          updatedMessages.forEach((msg) => {
            if (msg.role === "user" || msg.role === "assistant") {
              prompt.push(msg.content);
            }
          });

          // Build the request for Gemini 2.5 with thinking and Google Search tool
          const response = await geminiClient.models.generateContent({
            model: newModel,
            contents: prompt,
            config: {
              tools: [
                {
                  googleSearch: {},
                  codeExecution: {},
                },
              ],
              thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: 24576,
              },
            },
          });

          // Parse the response for thought summary and answer
          let thoughtSummary = "";
          let answerText = "";
          if (
            response &&
            response.candidates &&
            response.candidates.length > 0 &&
            response.candidates[0].content &&
            response.candidates[0].content.parts
          ) {
            response.candidates[0].content.parts.forEach((part: any) => {
              if (part.thought) {
                thoughtSummary += part.text;
              } else if (part.text) {
                answerText += part.text;
              }
            });

            // Compose assistant message content (answer only)
            let responseText = answerText;

            // Update AI message with the response
            const updatedAiMessage = { ...aiMessage, content: responseText };
            setMessages([...updatedMessages, updatedAiMessage]);

            // Store thinking trace for this message index (collapsible)
            setThinkingTraces((prev) => {
              const arr = [...prev];
              arr[updatedMessages.length] = thoughtSummary;
              return arr;
            });

            // Extract grounding information if present
            const candidate = response.candidates[0];
            if (candidate.groundingMetadata) {
              const sources: { [index: number]: GroundingChunk } = {};
              if (candidate.groundingMetadata.groundingChunks) {
                candidate.groundingMetadata.groundingChunks.forEach((chunk: any, index: number) => {
                  sources[index] = chunk;
                });
              }
              setGroundingSources(sources);
              if (candidate.groundingMetadata.webSearchQueries) {
                setSearchQueries(candidate.groundingMetadata.webSearchQueries);
              } else {
                setSearchQueries([]);
              }
            } else {
              setGroundingSources({});
              setSearchQueries([]);
            }

            // Update token count if available
            setTokenCount(response.usageMetadata?.totalTokenCount || 0);
          } else {
            throw new Error("No response from Gemini");
          }

          setIsLoading(false);
        } catch (err: any) {
          setIsLoading(false);
          // Print full error object to console for troubleshooting
          // eslint-disable-next-line no-console
          console.error("Gemini SDK error:", err);
          await showToast({
            style: Toast.Style.Failure,
            title: "Error querying Gemini (SDK)",
            message: err && err.message ? err.message : String(err),
          });
        }
        return;
      }

      // Fallback: REST API for non-2.5 models
      try {
        const requestPayload: any = {
          contents: geminiContents,
          generationConfig: {
            temperature: 0.9,
            topP: 0.95,
            maxOutputTokens: 32768,
          },
        };

        // Add Google Search tool if using Gemini 2.0
        if (newModel.startsWith("gemini-2.0")) {
          requestPayload.tools = [{ google_search: {} }];
        }

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${newModel}:generateContent?key=${preferences.apiKey}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(requestPayload),
          },
        );

        if (!response.ok) {
          const errorText = await response.text();
          // Print full error object to console for troubleshooting
          // eslint-disable-next-line no-console
          console.error("Gemini REST error:", errorText);
          throw new Error(errorText || `API error: ${response.status}`);
        }

        const responseData: GeminiResponse = (await response.json()) as GeminiResponse;

        if (!responseData.candidates || responseData.candidates.length === 0) {
          throw new Error("No response from Gemini");
        }

        const candidate = responseData.candidates[0];
        const responseText = candidate.content.parts.map((part) => part.text).join("");

        // Update AI message with the response
        const updatedAiMessage = { ...aiMessage, content: responseText };
        setMessages([...updatedMessages, updatedAiMessage]);

        // Clear thinking traces for this message (not supported)
        setThinkingTraces((prev) => {
          const arr = [...prev];
          arr[updatedMessages.length] = "";
          return arr;
        });

        // Extract grounding information
        if (candidate.groundingMetadata) {
          const sources: { [index: number]: GroundingChunk } = {};
          if (candidate.groundingMetadata.groundingChunks) {
            candidate.groundingMetadata.groundingChunks.forEach((chunk, index) => {
              sources[index] = chunk;
            });
          }
          setGroundingSources(sources);
          if (candidate.groundingMetadata.webSearchQueries) {
            setSearchQueries(candidate.groundingMetadata.webSearchQueries);
          } else {
            setSearchQueries([]);
          }
        } else {
          setGroundingSources({});
          setSearchQueries([]);
        }

        // Update token count
        setTokenCount(responseData.usageMetadata?.totalTokenCount || 0);

        setIsLoading(false);
      } catch (err: any) {
        setIsLoading(false);
        // Print full error object to console for troubleshooting
        // eslint-disable-next-line no-console
        console.error("Gemini REST error:", err);
        await showToast({
          style: Toast.Style.Failure,
          title: "Error querying Gemini",
          message: err && err.message ? err.message : String(err),
        });
      }
    } catch (err: any) {
      setIsLoading(false);
      // Print full error object to console for troubleshooting
      // eslint-disable-next-line no-console
      console.error("General error:", err);
      await showToast({
        style: Toast.Style.Failure,
        title: "Error",
        message: err && err.message ? err.message : String(err),
      });
    }
  }

  // If we have messages, show the conversation
  if (messages.length > 0) {
    return (
      <Detail
        markdown={getFormattedConversation()}
        isLoading={isLoading}
        navigationTitle="Conversation with Gemini"
        actions={
          <ActionPanel>
            <Action.Push
              title="Add Message"
              target={<MessageInputForm onSubmit={handleSubmit} />}
              shortcut={{ modifiers: ["cmd"], key: "return" }}
            />
            <Action
              title="New Conversation"
              onAction={() => {
                setMessages([]);
                setInputValue("");
                setTokenCount(0);
                setGroundingSources({});
                setSearchQueries([]);
              }}
              shortcut={{ modifiers: ["cmd"], key: "n" }}
            />
          </ActionPanel>
        }
      />
    );
  }

  // Otherwise show the initial form
  return (
    <Form
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm onSubmit={(values: { query: string }) => handleSubmit(values.query)} />
        </ActionPanel>
      }
    >
      <Form.TextArea
        id="query"
        title="Query"
        placeholder="What would you like to ask?"
        autoFocus
        value={inputValue}
        onChange={setInputValue}
      />
    </Form>
  );
}
