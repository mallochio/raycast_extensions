import { useState } from "react";
import { Form, ActionPanel, Action, Detail, showToast, Toast, getPreferenceValues, useNavigation } from "@raycast/api";
import fetch from "node-fetch";
import { Readable } from "stream";
import { ReadableStream } from "stream/web";

// Preferences interface
interface Preferences {
  apiKey: string;
  virtualKey: string;
  defaultModel: string;
  defaultSystemPrompt: string;
}

const preferences = getPreferenceValues<Preferences>();

// Message type definition
interface Message {
  role: "system" | "user" | "assistant";
  content: string;
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

  // Format messages for display in markdown
  const getFormattedConversation = () => {
    return messages
      .filter(msg => msg.role !== "system")
      .map(msg => {
        const prefix = msg.role === "user" 
          ? "### User" 
          : `### ${model || preferences.defaultModel} (Token Tally: ${tokenCount})`;
        const content = msg.content.trim();
        return `${prefix}\n\n${content}\n\n---`;
      })
      .join("\n\n");
  };

  async function handleSubmit(query: string) {
    if (!query?.trim()) return;
    
    try {
      setIsLoading(true);
      setInputValue("");
      
      const newModel = model || preferences.defaultModel;
      const newSystemPrompt = systemPrompt || preferences.defaultSystemPrompt;
      
      // Add user message to conversation
      const userMessage: Message = { role: "user", content: query };
      const updatedMessages = [...messages, userMessage];
      setMessages(updatedMessages);
      
      // Show toast indicating query is in progress
      await showToast({
        style: Toast.Style.Animated,
        title: "Querying Portkey",
        message: `Using model: ${newModel}`,
      });
  
      // Prepare full conversation history for API
      const apiMessages: Message[] = [];
      
      // Add system prompt if available
      if (newSystemPrompt) {
        apiMessages.push({ role: "system", content: newSystemPrompt });
      }
      
      // Add all conversation messages
      apiMessages.push(...updatedMessages);
  
      // Initialize AI's response message
      const aiMessage: Message = { role: "assistant", content: "" };
      setMessages([...updatedMessages, aiMessage]);
  
      // Prepare request payload based on model
      const requestPayload = {
        model: newModel,
        messages: apiMessages,
        max_tokens: 32768,
        temperature: 0.95,
        top_p: 0.9,
        stream: true
      };
      
      // Only add tools for Gemini 2.0 models
      if (newModel.startsWith("gemini-2.0")) {
        Object.assign(requestPayload, {
          tools: [
            {
              type: "function",
              function: {
                name: "google_search"
              }
            }
          ]
        });
      }
  
      // Use node-fetch to call the API
      const response = await fetch("https://api.portkey.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-portkey-api-key": preferences.apiKey,
          "x-portkey-virtual-key": preferences.virtualKey
        },
        body: JSON.stringify(requestPayload)
      });
  
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `API error: ${response.status}`);
      }
      
      if (!response.body) {
        throw new Error("Response body is null");
      }
      // Convert node-fetch response body to web ReadableStream
      const webReadableStream = Readable.toWeb(response.body as any) as ReadableStream;
      const reader = webReadableStream.getReader();
      const decoder = new TextDecoder("utf-8");
      let cumulativeContent = "";
      let finalTokenCount = 0;
  
      try {
        while (true) {
          const { done, value } = await reader.read();
          
          if (done) {
            break;
          }
          
          // Decode the chunk and split by lines
          const chunk = decoder.decode(value, { stream: true });
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
              
              // Extract content from delta if available
              const deltaContent = parsedData.choices?.[0]?.delta?.content || "";
              if (deltaContent) {
                cumulativeContent += deltaContent;
                
                // Update the AI message with new content
                const updatedAiMessage = { ...aiMessage, content: cumulativeContent };
                setMessages([...updatedMessages, updatedAiMessage]);
              }
              
              // Check for token usage
              if (parsedData.usage?.total_tokens) {
                finalTokenCount = parsedData.usage.total_tokens;
              }
            } catch (error) {
              console.error("Error parsing JSON from stream:", error, jsonString);
            }
          }
        }
      } catch (error) {
        console.error("Error reading stream:", error);
        throw error;
      } finally {
        reader.releaseLock();
      }
      
      // Update token count after stream is complete
      if (finalTokenCount > 0) {
        setTokenCount(prev => prev + finalTokenCount);
      } else {
        // If no token count was provided in the stream, estimate it
        // This is just a fallback and might not be accurate
        setTokenCount(prev => prev + Math.ceil(cumulativeContent.length / 4));
      }
      
      await showToast({
        style: Toast.Style.Success,
        title: "Response complete",
      });
      
    } catch (error) {
      console.error("Error querying Portkey:", error);
      await showToast({
        style: Toast.Style.Failure,
        title: "Error querying Portkey",
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
        navigationTitle="Conversation with Portkey AI"
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
              }} 
              shortcut={{ modifiers: ["cmd"], key: "n" }}
            />
          </ActionPanel>
        }
      />
    );
  }

  // Otherwise show the initial form (removed model and system prompt fields)
  return (
    <Form
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm onSubmit={(values: { query: string; }) => handleSubmit(values.query)} />
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
