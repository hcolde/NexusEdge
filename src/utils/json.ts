import type { JsonObject, JsonValue } from "../core/types";

export interface ParseOk {
  readonly ok: true;
  readonly value: unknown;
}

export interface ParseErr {
  readonly ok: false;
  readonly error: string;
}

export type ParseResult = ParseOk | ParseErr;

export function safeJsonParse(text: string): ParseResult {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid JSON."
    };
  }
}

export function extractJsonObjectText(input: string): string | undefined {
  let text = input.trim();

  if (text.startsWith("```")) {
    const firstNewline = text.indexOf("\n");
    const lastFence = text.lastIndexOf("```");
    if (firstNewline >= 0 && lastFence > firstNewline) {
      text = text.slice(firstNewline + 1, lastFence).trim();
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start < 0 || end <= start) {
    return undefined;
  }

  return text.slice(start, end + 1);
}

export function parseJsonObjectFromText(input: string): ParseResult {
  const jsonText = extractJsonObjectText(input);
  if (!jsonText) {
    return { ok: false, error: "No JSON object found." };
  }

  return safeJsonParse(jsonText);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }

  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") {
    return Number.isFinite(value as number) || kind !== "number";
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (kind === "object") {
    const record = value as Record<string, unknown>;
    return Object.values(record).every(isJsonValue);
  }

  return false;
}

export function isJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return Object.values(record).every(isJsonValue);
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
