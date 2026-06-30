import { NexusEdgeError } from "../core/error";
import type { JsonObject, JsonSchemaObject, JsonSchemaProperty, JsonValue } from "../core/types";

export function validateJsonObject(input: JsonObject, schema?: JsonSchemaObject): void {
  if (!schema) {
    return;
  }

  if (schema.type !== "object") {
    throw new NexusEdgeError("TOOL_VALIDATION_ERROR", "Only object input schemas are supported.");
  }

  const required = schema.required ?? [];
  for (const key of required) {
    if (!(key in input)) {
      throw new NexusEdgeError("TOOL_VALIDATION_ERROR", `Missing required tool input field: ${key}.`, {
        field: key
      });
    }
  }

  const properties = schema.properties ?? {};

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(input)) {
      if (!(key in properties)) {
        throw new NexusEdgeError("TOOL_VALIDATION_ERROR", `Unexpected tool input field: ${key}.`, {
          field: key
        });
      }
    }
  }

  for (const [key, property] of Object.entries(properties)) {
    if (!(key in input)) {
      continue;
    }

    const value = input[key];
    if (!matchesProperty(value, property)) {
      throw new NexusEdgeError("TOOL_VALIDATION_ERROR", `Invalid type for tool input field: ${key}.`, {
        field: key,
        expected: property.type
      });
    }

    if (property.enum && !property.enum.some((candidate) => jsonEquals(candidate, value))) {
      throw new NexusEdgeError("TOOL_VALIDATION_ERROR", `Invalid enum value for tool input field: ${key}.`, {
        field: key
      });
    }
  }
}

function matchesProperty(value: JsonValue | undefined, property: JsonSchemaProperty): boolean {
  switch (property.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
  }
}

function jsonEquals(left: JsonValue, right: JsonValue | undefined): boolean {
  if (right === undefined) {
    return false;
  }

  return JSON.stringify(left) === JSON.stringify(right);
}
