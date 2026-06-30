import { NexusEdgeError } from "../core/error";
import type { EdgeMessage, LLMCompleteResult, LLMProvider, LLMRequest, LLMStreamEvent, TokenUsage } from "../core/types";
import { parseSse } from "../streams/sse";
import { asNumber, asReadonlyArray, asString, isJsonObject, safeJsonParse } from "../utils/json";

export interface AnthropicProviderInit {
  readonly apiKey: string;
  readonly model: string;
  readonly baseURL?: string;
  readonly anthropicVersion?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";

  constructor(private readonly init: AnthropicProviderInit) {}

  async complete(request: LLMRequest): Promise<LLMCompleteResult> {
    const response = await fetch(`${this.baseURL()}/v1/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(toAnthropicBody(request, false, this.init.model)),
      signal: request.signal
    });

    if (!response.ok) {
      throw await providerHttpError(response);
    }

    const json: unknown = await response.json();
    return parseAnthropicComplete(json);
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const response = await fetch(`${this.baseURL()}/v1/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(toAnthropicBody(request, true, this.init.model)),
      signal: request.signal
    });

    if (!response.ok) {
      throw await providerHttpError(response);
    }

    if (!response.body) {
      throw new NexusEdgeError("PROVIDER_STREAM_ERROR", "Provider response does not contain a stream body.");
    }

    for await (const event of parseSse(response.body)) {
      const parsed = safeJsonParse(event.data);
      if (!parsed.ok) {
        yield { type: "error", code: "PROVIDER_PARSE_ERROR", message: parsed.error };
        continue;
      }

      const text = extractAnthropicDelta(parsed.value);
      if (text.length > 0) {
        yield { type: "delta", text };
      }

      const usage = extractUsage(parsed.value);
      if (usage) {
        yield { type: "usage", usage };
      }
    }

    yield { type: "done" };
  }

  private baseURL(): string {
    const base = this.init.baseURL ?? "https://api.anthropic.com";
    return base.endsWith("/") ? base.slice(0, -1) : base;
  }

  private headers(): Headers {
    const headers = new Headers(this.init.headers);
    headers.set("x-api-key", this.init.apiKey);
    headers.set("anthropic-version", this.init.anthropicVersion ?? "2023-06-01");
    headers.set("Content-Type", "application/json");
    return headers;
  }
}

export interface AnthropicBody {
  readonly model: string;
  readonly max_tokens: number;
  readonly temperature?: number;
  readonly system?: string;
  readonly messages: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
  readonly stream: boolean;
}

export function toAnthropicBody(request: LLMRequest, stream: boolean, defaultModel: string): AnthropicBody {
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  const messages = request.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" as const : "user" as const,
      content: message.role === "tool"
        ? `Tool result${message.name ? ` from ${message.name}` : ""}:\n${message.content}`
        : message.content
    }));

  return {
    model: request.model ?? defaultModel,
    max_tokens: request.maxTokens ?? 1024,
    temperature: request.temperature,
    system: system.length > 0 ? system : undefined,
    messages,
    stream
  };
}

export function parseAnthropicComplete(json: unknown): LLMCompleteResult {
  if (!isJsonObject(json)) {
    throw new NexusEdgeError("PROVIDER_PARSE_ERROR", "Anthropic response is not a JSON object.");
  }

  const content = asReadonlyArray(json.content);
  if (!content) {
    throw new NexusEdgeError("PROVIDER_PARSE_ERROR", "Anthropic response is missing content array.");
  }

  const text = content
    .map((block) => isJsonObject(block) && block.type === "text" ? asString(block.text) ?? "" : "")
    .join("");

  return {
    text,
    raw: json,
    usage: extractUsage(json)
  };
}

export function extractAnthropicDelta(json: unknown): string {
  if (!isJsonObject(json)) {
    return "";
  }

  if (json.type !== "content_block_delta" || !isJsonObject(json.delta)) {
    return "";
  }

  return asString(json.delta.text) ?? "";
}

function extractUsage(json: unknown): TokenUsage | undefined {
  if (!isJsonObject(json)) {
    return undefined;
  }

  const usage = isJsonObject(json.usage) ? json.usage : isJsonObject(json.message) && isJsonObject(json.message.usage) ? json.message.usage : undefined;
  if (!usage) {
    return undefined;
  }

  const inputTokens = asNumber(usage.input_tokens);
  const outputTokens = asNumber(usage.output_tokens);
  const totalTokens = inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined;

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens
  };
}

async function providerHttpError(response: Response): Promise<NexusEdgeError> {
  return new NexusEdgeError("PROVIDER_HTTP_ERROR", `Provider returned HTTP ${response.status}.`, {
    status: response.status
  });
}
