// Thin wrapper over the Anthropic SDK for the chat handler (claude-api skill: TypeScript README
// + streaming.md). Kept separate from handler.ts so tests can inject a mock implementing the
// same narrow interface instead of hitting the real API (`ChatHandlerOptions.anthropicClient`).
import Anthropic from "@anthropic-ai/sdk";
import type { AssembledRequest } from "./prompt.js";
import type { ChatTokenUsage } from "./types.js";

export interface AnthropicStreamResult {
  /** Yields text deltas as they arrive, for the route to forward to the client. */
  textChunks: AsyncIterable<string>;
  /** Resolves once the stream finishes, with final token usage. */
  usage: Promise<ChatTokenUsage>;
}

/** Everything the chat handler needs from an Anthropic client — real client or test mock. */
export interface AnthropicChatClient {
  streamMessage(req: AssembledRequest, model: string, maxTokens: number): AnthropicStreamResult;
}

export class RealAnthropicChatClient implements AnthropicChatClient {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  streamMessage(req: AssembledRequest, model: string, maxTokens: number): AnthropicStreamResult {
    const stream = this.client.messages.stream({
      model,
      max_tokens: maxTokens,
      system: req.system,
      messages: req.messages,
    });

    let resolveUsage!: (u: ChatTokenUsage) => void;
    const usage = new Promise<ChatTokenUsage>((resolve) => {
      resolveUsage = resolve;
    });

    async function* chunks(): AsyncIterable<string> {
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield event.delta.text;
        }
      }
      const final = await stream.finalMessage();
      resolveUsage({
        model: final.model,
        input: final.usage.input_tokens,
        output: final.usage.output_tokens,
        cacheRead: final.usage.cache_read_input_tokens ?? 0,
      });
    }

    return { textChunks: chunks(), usage };
  }
}
