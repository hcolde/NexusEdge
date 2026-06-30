import type { JsonObject, JsonValue } from "../core/types";

export interface ParseOk {
  readonly ok: true;
  readonly value: unknown;
}

export interface ParseErr {
  readonly ok: false;
  readonly error: string;
  readonly code?: "NO_JSON_OBJECT" | "INVALID_JSON" | "JSON_LIMIT";
}

export type ParseResult = ParseOk | ParseErr;

export interface ParseJsonOptions {
  readonly maxChars?: number;
  readonly maxDepth?: number;
}

const DEFAULT_PARSE_JSON_LIMITS: Required<ParseJsonOptions> = {
  maxChars: 1024 * 1024,
  maxDepth: 64
};

export function safeJsonParse(text: string, options: ParseJsonOptions = {}): ParseResult {
  const limits = { ...DEFAULT_PARSE_JSON_LIMITS, ...options };
  if (text.length > limits.maxChars) {
    return {
      ok: false,
      code: "JSON_LIMIT",
      error: "JSON text exceeded maximum size."
    };
  }

  try {
    const value = JSON.parse(text) as unknown;
    if (!isJsonValue(value, limits.maxDepth)) {
      return {
        ok: false,
        code: "JSON_LIMIT",
        error: "JSON value exceeded maximum nesting depth."
      };
    }

    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      code: "INVALID_JSON",
      error: error instanceof Error ? error.message : "Invalid JSON."
    };
  }
}

export async function parseJsonResponse(response: Response, options: ParseJsonOptions = {}): Promise<ParseResult> {
  const limits = { ...DEFAULT_PARSE_JSON_LIMITS, ...options };
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const contentLengthValue = Number(contentLength);
    if (Number.isFinite(contentLengthValue) && contentLengthValue > limits.maxChars) {
      return {
        ok: false,
        code: "JSON_LIMIT",
        error: "JSON text exceeded maximum size."
      };
    }
  }

  const text = await readResponseText(response, limits.maxChars);
  if (!text.ok) {
    return text;
  }

  return safeJsonParse(text.value, limits);
}

export function extractJsonObjectText(input: string): string | undefined {
  let text = input.trim();

  if (!text.startsWith("{") || !text.endsWith("}")) {
    return undefined;
  }

  return text;
}

export function parseJsonObjectFromText(input: string, options: ParseJsonOptions = {}): ParseResult {
  const limits = { ...DEFAULT_PARSE_JSON_LIMITS, ...options };
  if (input.length > limits.maxChars) {
    return {
      ok: false,
      code: "JSON_LIMIT",
      error: "JSON text exceeded maximum size."
    };
  }

  const jsonText = extractJsonObjectText(input);
  if (!jsonText) {
    return { ok: false, code: "NO_JSON_OBJECT", error: "No JSON object found." };
  }

  const parsed = safeJsonParse(jsonText, limits);
  if (!parsed.ok) {
    return parsed;
  }

  if (!isJsonValue(parsed.value, limits.maxDepth)) {
    return {
      ok: false,
      code: "JSON_LIMIT",
      error: "JSON value exceeded maximum nesting depth."
    };
  }

  return parsed;
}

export function isJsonValue(value: unknown, maxDepth = DEFAULT_PARSE_JSON_LIMITS.maxDepth): value is JsonValue {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();

  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) {
      continue;
    }

    if (item.depth > maxDepth) {
      return false;
    }

    if (item.value === null) {
      continue;
    }

    const kind = typeof item.value;
    if (kind === "string" || kind === "boolean") {
      continue;
    }

    if (kind === "number") {
      if (!Number.isFinite(item.value)) {
        return false;
      }
      continue;
    }

    if (Array.isArray(item.value)) {
      if (seen.has(item.value)) {
        return false;
      }
      seen.add(item.value);
      for (const child of item.value) {
        stack.push({ value: child, depth: item.depth + 1 });
      }
      continue;
    }

    if (kind === "object") {
      const record = item.value as Record<string, unknown>;
      if (seen.has(record)) {
        return false;
      }
      seen.add(record);
      for (const child of Object.values(record)) {
        stack.push({ value: child, depth: item.depth + 1 });
      }
      continue;
    }

    return false;
  }

  return true;
}

export function isJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return isJsonValue(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asReadonlyArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxChars - 24))}…[truncated ${text.length - maxChars}]`;
}

export function stableStringify(value: JsonValue): string {
  return JSON.stringify(value);
}

type ReadResponseTextResult = { readonly ok: true; readonly value: string } | ParseErr;

async function readResponseText(response: Response, maxChars: number): Promise<ReadResponseTextResult> {
  if (!response.body) {
    const text = await response.text();
    return text.length > maxChars
      ? {
          ok: false,
          code: "JSON_LIMIT",
          error: "JSON text exceeded maximum size."
        }
      : { ok: true, value: text };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";

  const append = async (chunk: string): Promise<ReadResponseTextResult | undefined> => {
    text += chunk;
    if (text.length > maxChars) {
      await reader.cancel();
      return {
        ok: false,
        code: "JSON_LIMIT",
        error: "JSON text exceeded maximum size."
      };
    }

    return undefined;
  };

  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }

    const overLimit = await append(decoder.decode(result.value, { stream: true }));
    if (overLimit) {
      return overLimit;
    }
  }

  const overLimit = await append(decoder.decode());
  if (overLimit) {
    return overLimit;
  }

  return { ok: true, value: text };
}
