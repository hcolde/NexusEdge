import { NexusEdgeError } from "../core/error";
import type { EdgeMessage, LLMCompleteResult, LLMProvider, LLMRequest, LLMStreamEvent, TokenUsage } from "../core/types";
import { parseSse } from "../streams/sse";
import { asNumber, asReadonlyArray, asString, isJsonObject, safeJsonParse } from "../utils/json";

export interface OpenAICompatibleProviderInit {
  readonly name?: string;
  readonly baseURL: string;
  readonly apiKey: string;
  readonly model: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;

  constructor(private readonly init: OpenAICompatibleProviderInit) {
    this.name = init.name ?? "openai-compatible";
  }

  async complete(request: LLMRequest): Promise<LLMCompleteResult> {
    const response = await fetch(`${trimTrailingSlash(this.init.baseURL)}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: request.model ?? this.init.model,
        messages: toOpenAIMessages(request.messages),
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        stream: false,
        response_format: request.responseFormat === "json" ? { type: "json_object" } : undefined
      }),
      signal: request.signal
    });

    if (!response.ok) {
      throw await providerHttpError(response);
    }

    const json: unknown = await response.json();
    return parseOpenAIComplete(json);
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const response = await fetch(`${trimTrailingSlash(this.init.baseURL)}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: request.model ?? this.init.model,
        messages: toOpenAIMessages(request.messages),
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        stream: true
      }),
      signal: request.signal
    });

    if (!response.ok) {
      throw await providerHttpError(response);
    }

    if (!response.body) {
      throw new NexusEdgeError("PROVIDER_STREAM_ERROR", "Provider response does not contain a stream body.");
    }

    for await (const event of parseSse(response.body)) {
      if (event.data === "[DONE]") {
        yield { type: "done" };
        return;
      }

      const parsed = safeJsonParse(event.data);
      if (!parsed.ok) {
        yield { type: "error", code: "PROVIDER_PARSE_ERROR", message: parsed.error };
        continue;
      }

      const text = extractOpenAIDelta(parsed.value);
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

  private headers(): Headers {
    const headers = new Headers(this.init.headers);
    headers.set("Authorization", `Bearer ${this.init.apiKey}`);
    headers.set("Content-Type", "application/json");
    return headers;
  }
}

export function toOpenAIMessages(messages: readonly EdgeMessage[]): readonly Record<string, string>[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "user",
        content: `Tool result${message.name ? ` from ${message.name}` : ""}:\n${message.content}`
      };
    }

    const converted: Record<string, string> = {
      role: message.role,
      content: message.content
    };

    if (message.name && message.role !== "system") {
      converted.name = message.name;
    }

    return converted;
  });
}

export function parseOpenAIComplete(json: unknown): LLMCompleteResult {
  if (!isJsonObject(json)) {
    throw new NexusEdgeError("PROVIDER_PARSE_ERROR", "OpenAI-compatible response is not a JSON object.");
  }

  const choices = asReadonlyArray(json.choices);
  const first = choices?.[0];
  if (!isJsonObject(first)) {
    throw new NexusEdgeError("PROVIDER_PARSE_ERROR", "OpenAI-compatible response is missing choices[0].");
  }

  const message = first.message;
  if (!isJsonObject(message)) {
    throw new NexusEdgeError("PROVIDER_PARSE_ERROR", "OpenAI-compatible response is missing message content.");
  }

  const content = asString(message.content) ?? "";
  const usage = extractUsage(json);

  return {
    text: content,
    raw: json,
    usage
  };
}

export function extractOpenAIDelta(json: unknown): string {
  if (!isJsonObject(json)) {
    return "";
  }

  const choices = asReadonlyArray(json.choices);
  const first = choices?.[0];
  if (!isJsonObject(first)) {
    return "";
  }

  const delta = first.delta;
  if (isJsonObject(delta)) {
    return asString(delta.content) ?? "";
  }

  const message = first.message;
  if (isJsonObject(message)) {
    return asString(message.content) ?? "";
  }

  return "";
}

function extractUsage(json: unknown): TokenUsage | undefined {
  if (!isJsonObject(json) || !isJsonObject(json.usage)) {
    return undefined;
  }

  const inputTokens = asNumber(json.usage.prompt_tokens) ?? asNumber(json.usage.input_tokens);
  const outputTokens = asNumber(json.usage.completion_tokens) ?? asNumber(json.usage.output_tokens);
  const totalTokens = asNumber(json.usage.total_tokens);

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
  const body = await response.text().catch(() => "");
  return new NexusEdgeError("PROVIDER_HTTP_ERROR", `Provider returned HTTP ${response.status}.`, {
    status: response.status,
    body: body.slice(0, 2000)
  });
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
