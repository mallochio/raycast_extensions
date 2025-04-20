    // src/ask-vercel.tsx (or your main file)
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
    } from "@raycast/api";
    // Import streamText and StreamTextResult, plus the stream part types
    import { streamText, StreamTextResult } from 'ai';
// Import specific provider creation functions
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI, GoogleGenerativeAIProviderOptions } from '@ai-sdk/google'; // Use this to create a custom instance and import options type

    // REMOVED: import { google as googleProvider } from '@ai-sdk/google';


    // Define the structure for preferences
    interface Preferences {
      provider: string;
  model: string; // e.g., "gemini-2.0-flash"
  apiKey: string;
  systemPrompt: string; // Added for system prompt preference
}

// Define the structure for a message in the conversation
    interface Message {
      role: "user" | "assistant" | "error";
      content: string;
      timestamp: number;
    }

    // --- Message Input Form Component ---
    // (Component remains the same)
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


    // --- Main Command Component ---
    export default function Command() {
      const preferences = getPreferenceValues<Preferences>();
      const { push } = useNavigation();

      const [isLoading, setIsLoading] = useState(false);
      const [messages, setMessages] = useState<Message[]>([]);
      const [streamCounter, setStreamCounter] = useState(0);

      // --- Format conversation for Detail view ---
      // (Formatting logic remains the same)
      const formattedConversation = useMemo(() => {
         // ... (same formatting logic) ...
        let md = messages
          .map((msg) => {
            const roleTitle = msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'Assistant' : 'Error';
            const icon = msg.role === 'user' ? '👤' : msg.role === 'assistant' ? '🤖' : '⚠️';
            const content = msg.content;
            const looksLikeCode = content.includes('```') || (content.includes('\n') && (content.includes(';') || content.includes('{') || content.includes('}')));
            const formattedContent = looksLikeCode ? `\n\`\`\`\n${content.trim()}\n\`\`\`\n` : content;
            return `**${icon} ${roleTitle}**: \n${formattedContent}\n\n---\n\n`;
          })
          .join("");

        if (isLoading && messages.length > 0 && messages[messages.length - 1]?.role === 'assistant' && messages[messages.length - 1]?.content === '...') {
           md += "\n\n*Assistant is thinking...*";
        }
        return md;
      }, [messages, isLoading, streamCounter]);

      // --- Handle message submission ---
      const handleSubmit = async (query: string) => {
        const trimmedQuery = query?.trim();
        if (!trimmedQuery) {
          // ... (validation remains the same) ...
          return;
        }

        // Check for API key early
        if (!preferences.apiKey) {
             await showToast({ style: Toast.Style.Failure, title: "API Key Missing", message: "Please set the API key in preferences." });
             // Optionally, navigate to preferences or return early
             // For now, we let the API call fail below, but this check is good practice.
             // return;
        }


        console.log("handleSubmit triggered for query:", trimmedQuery);

        setIsLoading(true);
        const newUserMessage: Message = { role: "user", content: trimmedQuery, timestamp: Date.now() };
        const assistantPlaceholder: Message = { role: 'assistant', content: "...", timestamp: Date.now() + 1 };

        // Use type predicate in filter to ensure correct type for API
        // Prepare messages for the API call, potentially adding the system prompt
        let messagesForApi: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [...messages, newUserMessage] // Start with current history + new user message
            .filter((msg): msg is Message & { role: 'user' | 'assistant' } => msg.role === 'user' || msg.role === 'assistant') // Filter out any potential 'error' messages from local state
            .map(({ role, content }) => ({ role, content })); // Map to the structure needed by the API

        // Prepend system prompt if provided
        const systemPrompt = preferences.systemPrompt?.trim();
        if (systemPrompt) {
          console.log("Prepending system prompt:", systemPrompt);
          // Add the system message to the beginning of the array
          messagesForApi.unshift({ role: 'system', content: systemPrompt });
        } else {
          console.log("No system prompt provided or it's empty.");
        }

        // Update local state *after* preparing the API message list
        setMessages(prevMessages => [...prevMessages, newUserMessage, assistantPlaceholder]);
        setStreamCounter(c => c + 1);

        const assistantMessageId = assistantPlaceholder.timestamp;
        let assistantResponse = "";
        let streamProcessed = false;

        try {
          await showToast({ style: Toast.Style.Animated, title: "Querying AI..." });

          let streamResult: StreamTextResult<any, any>;
          // Define the base payload structure
          let payload: {
              model: any;
              // Allow 'system' role in the messages array type definition
              messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
              providerOptions?: { google?: any }; // Use 'any' for google options to bypass strict local type check
           } = {
            model: null,
            messages: messagesForApi,
          };


          // Select provider and create client/model instance
          if (preferences.provider === 'openai') {
            // Create a custom instance with the API key from preferences
            const openai = createOpenAI({ apiKey: preferences.apiKey });
            payload.model = openai(preferences.model);
            console.log("Using OpenAI model:", preferences.model);
          } else if (preferences.provider === 'anthropic') {
            // Create a custom instance with the API key from preferences
            const anthropic = createAnthropic({ apiKey: preferences.apiKey });
            payload.model = anthropic(preferences.model);
            console.log("Using Anthropic model:", preferences.model);
          } else if (preferences.provider === 'google') {
            // Create a CUSTOM Google instance with the API key from preferences
            const google = createGoogleGenerativeAI({ apiKey: preferences.apiKey });
            // Use the custom instance to create the model with grounding enabled
            payload.model = google(preferences.model, {
                 useSearchGrounding: true, // Keep existing grounding option
                 dynamicRetrievalConfig: {
                  mode: 'MODE_DYNAMIC',
                  dynamicThreshold: 0.8,
                },
            });
            console.log(`Using Google model: ${preferences.model} with Search Grounding ENABLED.`);

            // *** Conditionally add thinking budget for specific models ***
            if (preferences.model.startsWith('gemini-2.5')) { // Check if model name starts with 'gemini-2.5'
                    payload.providerOptions = {
                      google: {
                        thinkingConfig: {
                          thinkingBudget: 24576,
                        },
                      } // satisfies GoogleGenerativeAIProviderOptions // Optional: Add 'satisfies' for type checking if desired
                    };
                    console.log(`Added thinkingBudget: 24576 for ${preferences.model}`);
                  }    } else {
            throw new Error(`Unsupported provider: ${preferences.provider}`);
          }

          // Log the final payload
          console.log('Sending Payload:', JSON.stringify(payload, null, 2));
          streamResult = await streamText(payload); // Use the potentially modified payload
          console.log('Raw Stream Result received, processing full stream...');

          // Process the FULL stream (logic remains the same)
          for await (const part of streamResult.fullStream) {
            switch (part.type) {
              case 'text-delta': {
                streamProcessed = true;
                assistantResponse += part.textDelta;
                setMessages(prevMessages => prevMessages.map(msg =>
                  msg.timestamp === assistantMessageId
                    ? { ...msg, content: assistantResponse }
                    : msg
                ));
                break;
              }
              // Access tool properties directly from the part object
              case 'tool-call': { console.log('Tool Call:', { toolCallId: part.toolCallId, toolName: part.toolName, args: part.args }); break; }
              case 'tool-result': { console.log('Tool Result:', { toolCallId: part.toolCallId, toolName: part.toolName, args: part.args, result: part.result }); break; }
              case 'finish': { console.log('Stream Finish Reason:', part.finishReason); console.log('Stream Usage:', part.usage); break; }
              case 'error': { console.error('Stream Error Part:', part.error); throw new Error(`Stream error: ${part.error}`); } // Propagate stream errors
              default: { console.log('Unhandled Stream Part:', part); }
            }
          }
          console.log('Finished processing full stream. Text processed:', streamProcessed);


          // Final check and state update (remains the same)
          if (!streamProcessed && assistantResponse === "") {
             console.log("assistantResponse is empty and no text-delta parts were processed.");
            setMessages(prevMessages => prevMessages.map(msg =>
              msg.timestamp === assistantMessageId
                ? { ...msg, content: "(No response received or stream format issue)" }
                : msg
            ));
             setStreamCounter(c => c + 1);
          } else if (assistantResponse === "") {
              console.log("assistantResponse is empty BUT text-delta parts *were* processed (stream likely contained only whitespace).");
               setMessages(prevMessages => prevMessages.map(msg =>
                msg.timestamp === assistantMessageId
                  ? { ...msg, content: "(Empty response received)" }
                  : msg
              ));
              setStreamCounter(c => c + 1);
          }
           else {
             console.log("assistantResponse has content. Length:", assistantResponse.length);
             setStreamCounter(c => c + 1);
          }

          await showToast({ style: Toast.Style.Success, title: "Response received" });

        } catch (err: any) {
          // Error logging remains the same
          console.error("API Error Caught:", err);
          // Log specific details if available
          if (err.message?.includes('API key is missing')) {
              console.error("Verify API key is correctly set in Raycast preferences for the selected provider.");
          }
          if (err.cause) console.error("Error Cause:", err.cause);
          if (err.response) {
              console.error("Error Response Status:", err.response.status);
              try { const errorBody = await err.response.text(); console.error("Error Response Body:", errorBody); } catch (e) { console.error("Could not read error response body."); }
          }

          const errorMessageContent = `Error: ${err.message || "Failed to fetch response from AI."}`;
           setMessages(prevMessages => prevMessages.map(msg =>
               msg.timestamp === assistantMessageId
                   ? { ...msg, role: 'error', content: errorMessageContent }
                   : msg
           ));
           setStreamCounter(c => c + 1);

          await showToast({ style: Toast.Style.Failure, title: "API Error", message: err.message });
        } finally {
          setIsLoading(false);
          console.log("handleSubmit finished.");
        }
      };

      // --- UI Rendering ---
      // (UI rendering logic remains the same)

      if (!preferences.apiKey) {
        // This check might be redundant now if the API call fails clearly,
        // but it's good for immediate feedback if the preference is empty.
        return (
          <Detail markdown="## API Key Not Set 🔑&#x0a;&#x0a;Please set your API key for the selected provider in the extension preferences (⌘ + ,) to use this command." />
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
                   <Action.CopyToClipboard title="Copy Conversation" content={formattedConversation} shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}/>
                   <Action.CopyToClipboard title="Copy Last Response" content={messages.findLast(m => m.role === 'assistant')?.content ?? ""} shortcut={{ modifiers: ["cmd", "shift"], key: "l" }}/>
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
