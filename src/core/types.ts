export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

export type MaybePromise<T> = T | Promise<T>;

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface EdgeMessage {
  readonly role: MessageRole;
  readonly content: string;
  readonly name?: string;
  readonly tokenEstimate?: number;
  readonly ephemeral?: boolean;
  readonly createdAt?: number;
  readonly meta?: JsonObject;
}

export interface TokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface Artifact<T extends JsonValue = JsonValue> {
  readonly id: string;
  readonly ownerAgentId: string;
  readonly scope: "private" | "shared";
  readonly kind: string;
  readonly data: T;
  readonly summary?: string;
  readonly tokenEstimate: number;
  readonly createdAt: number;
}

export interface ToolExecutionContext {
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface JsonSchemaProperty {
  readonly type: "string" | "number" | "boolean" | "object" | "array";
  readonly description?: string;
  readonly enum?: readonly JsonValue[];
}

export interface JsonSchemaObject {
  readonly type: "object";
  readonly properties?: Readonly<Record<string, JsonSchemaProperty>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

export interface LLMRequest {
  readonly model?: string;
  readonly messages: readonly EdgeMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly responseFormat?: "text" | "json";
  readonly signal?: AbortSignal;
}

export interface LLMCompleteResult {
  readonly text: string;
  readonly raw?: unknown;
  readonly usage?: TokenUsage;
}

export type LLMStreamEvent =
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "usage"; readonly usage: TokenUsage }
  | { readonly type: "done" }
  | { readonly type: "error"; readonly code: string; readonly message: string };

export interface LLMProvider {
  readonly name: string;
  complete(request: LLMRequest): Promise<LLMCompleteResult>;
  stream(request: LLMRequest): AsyncIterable<LLMStreamEvent>;
}
