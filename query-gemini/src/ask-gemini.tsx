import React, { useState } from "react";
import { Form, ActionPanel, Action, Detail, showToast, Toast, getPreferenceValues, useNavigation } from "@raycast/api";
import fetch from "node-fetch";
import { Readable } from "stream";
import { ReadableStream } from "stream/web";

// Preferences interface
interface Preferences {
  apiKey: string;
  defaultModel: string;
  defaultSystemPrompt: string;
}

const preferences = getPreferenceValues<Preferences>();

// Message type definition
interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

// Gemini specific types
interface GeminiPart {
  text: string;
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
  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm onSubmit={(values: { query: string }) => { props.onSubmit(values.query); pop(); }} />
        </ActionPanel>
      }
    >
      <Form.TextArea id="query" title="New Message" placeholder="Type your message here" autoFocus />
    </Form>
  );
}

// Query input form
export default function QueryForm() {
  const [isLoading, setIsLoading] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [systemPrompt, setSystemPrompt] = useState<string>(preferences.defaultSystemPrompt || "");
  const [model, setModel] = useState<string>(preferences.defaultModel || "");
  const [inputValue, setInputValue] = useState("");
  const [tokenCount, setTokenCount] = useState(0);
  const [groundingSources, setGroundingSources] = useState<{[index: number]: GroundingChunk}>({});
  const [searchQueries, setSearchQueries] = useState<string[]>([]);

  // Format messages for display in markdown, including grounding information
  const getFormattedConversation = () => {
    return messages
      .filter(msg => msg.role !== "system")
      .map(msg => {
        // User messages remain simple
        if (msg.role === "user") {
          return `### User\n\n${msg.content.trim()}\n\n---`;
        }
        
        // For assistant messages, format with better visual hierarchy
        const modelName = model || preferences.defaultModel;
        const content = msg.content.trim();
        let formattedMessage = `### ${modelName} (Token Tally: ${tokenCount})\n\n${content}`;
        if (searchQueries.length > 0) {
          formattedMessage += "\n\n> **Searched for:** " + 
            searchQueries.map(q => `"${q}"`).join(", ");
        }
        if (Object.keys(groundingSources).length > 0) {
          const sourcesList = Object.values(groundingSources)
            .map((source, index) => source.web
              ? `[${source.web.title || "Source " + (index + 1)}](${source.web.uri})`
              : ""
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
          parts: [{ text: newSystemPrompt }]
        });
        
        // Add a placeholder assistant response after system prompt
        geminiContents.push({
          role: "model",
          parts: [{ text: "I'll follow those instructions." }]
        });
      }
      
      // Add conversation messages
      updatedMessages.forEach(msg => {
        if (msg.role === "system") return;
        
        geminiContents.push({
          role: msg.role === "user" ? "user" : "model",
          parts: [{ text: msg.content }]
        });
      });
      
      // Initialize AI's response message
      const aiMessage: Message = { role: "assistant", content: "" };
      setMessages([...updatedMessages, aiMessage]);
  
      // Prepare request payload
      const requestPayload: any = {
        contents: geminiContents,
        generationConfig: {
          temperature: 0.9,
          topP: 0.95,
          maxOutputTokens: 32768,
        }
      };
      
      // Add Google Search tool if using Gemini 2.0
      if (newModel.startsWith("gemini-2.0")) {
        requestPayload.tools = [{ google_search: {} }];
      }
  
      // Let's try the non-streaming endpoint first and fall back if needed
      try {
        // First attempt with regular non-streaming endpoint
        console.log("Attempting non-streaming request...");
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${newModel}:generateContent?key=${preferences.apiKey}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify(requestPayload)
          }
        );
  
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(errorText || `API error: ${response.status}`);
        }
        
        const responseData: GeminiResponse = await response.json() as GeminiResponse;
        
        if (!responseData.candidates || responseData.candidates.length === 0) {
          throw new Error("No response from Gemini");
        }
        
        const candidate = responseData.candidates[0];
        const responseText = candidate.content.parts.map(part => part.text).join("");
        
        // Update AI message with the response
        const updatedAiMessage = { ...aiMessage, content: responseText };
        setMessages([...updatedMessages, updatedAiMessage]);
        
        // Extract grounding information
        if (candidate.groundingMetadata) {
          const sources: {[index: number]: GroundingChunk} = {};
          
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
        if (responseData.usageMetadata) {
          setTokenCount(prev => prev + responseData.usageMetadata.totalTokenCount);
        }
      } catch (error) {
        console.error("Error with non-streaming request:", error);
        await showToast({
          style: Toast.Style.Failure,
          title: "Error with standard request, trying fallback",
        });
        
        // If standard request fails, try the streaming endpoint as fallback
        try {
          console.log("Falling back to streaming request...");
          // Reset the AI message content
          const resetAiMessage = { ...aiMessage, content: "Loading response..." };
          setMessages([...updatedMessages, resetAiMessage]);
          
          // Use node-fetch to call the streaming API
          const streamingResponse = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${newModel}:streamGenerateContent?key=${preferences.apiKey}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify(requestPayload)
            }
          );
  
          if (!streamingResponse.ok) {
            const errorText = await streamingResponse.text();
            throw new Error(errorText || `API error: ${streamingResponse.status}`);
          }
          
          if (!streamingResponse.body) {
            throw new Error("Response body is null");
          }
          
          // Process the streaming response
          const webReadableStream = Readable.toWeb(streamingResponse.body as any) as ReadableStream;
          const reader = webReadableStream.getReader();
          const decoder = new TextDecoder("utf-8");
          let cumulativeContent = "";
          let finalGroundingMetadata: GroundingMetadata | undefined;
          let totalTokens = 0;
  
          try {
            while (true) {
              const { done, value } = await reader.read();
              
              if (done) {
                break;
              }
              
              // Decode the chunk and process
              const chunk = decoder.decode(value, { stream: true });
              console.log("Received chunk:", chunk);
              
              const lines = chunk.split("\n").filter(line => line.trim() !== "");
              
              for (const line of lines) {
                // Skip if not a data line
                if (!line.startsWith("data: ")) continue;
                
                // Extract the JSON string
                const jsonString = line.slice(6); // Remove "data: " prefix
                
                // Check for the end of stream marker
                if (jsonString.trim() === "[DONE]") continue;
                
                try {
                  const parsedData = JSON.parse(jsonString);
                  console.log("Parsed chunk data:", parsedData);
                  
                  // Extract content and update the message
                  if (parsedData.candidates && parsedData.candidates[0]) {
                    const candidate = parsedData.candidates[0];
                    
                    if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
                      const deltaContent = candidate.content.parts[0].text || "";
                      cumulativeContent += deltaContent;
                      
                      // Update the AI message with new content
                      const updatedStreamingMessage = { ...aiMessage, content: cumulativeContent };
                      setMessages([...updatedMessages, updatedStreamingMessage]);
                    }
                    
                    // Capture grounding metadata if available
                    if (candidate.groundingMetadata) {
                      finalGroundingMetadata = candidate.groundingMetadata;
                    }
                  }
                  
                  // Track token usage
                  if (parsedData.usageMetadata) {
                    totalTokens += parsedData.usageMetadata.totalTokenCount || 0;
                  }
                } catch (error) {
                  console.error("Error parsing JSON from stream:", error, jsonString);
                }
              }
            }
            
            // After streaming is complete, update token count
            if (totalTokens > 0) {
              setTokenCount(prev => prev + totalTokens);
            }
            
            // Extract grounding information after streaming is complete
            if (finalGroundingMetadata) {
              const sources: {[index: number]: GroundingChunk} = {};
              
              if (finalGroundingMetadata.groundingChunks) {
                finalGroundingMetadata.groundingChunks.forEach((chunk, index) => {
                  sources[index] = chunk;
                });
              }
              
              setGroundingSources(sources);
              
              if (finalGroundingMetadata.webSearchQueries) {
                setSearchQueries(finalGroundingMetadata.webSearchQueries);
              } else {
                setSearchQueries([]);
              }
            }
            
          } catch (streamError) {
            console.error("Error processing stream:", streamError);
            throw streamError;
          } finally {
            reader.releaseLock();
          }
        } catch (streamingError) {
          console.error("Both standard and streaming requests failed:", streamingError);
          throw streamingError;
        }
      }
      
      await showToast({
        style: Toast.Style.Success,
        title: "Response complete",
      });
      
    } catch (error) {
      console.error("Error querying Gemini:", error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Error querying Gemini",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setIsLoading(false);
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
      />
    </Form>
  );
}
