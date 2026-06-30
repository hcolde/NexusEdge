import { NexusEdgeError } from "../core/error";
import type { JsonObject, JsonSchemaObject, JsonSchemaProperty, JsonValue } from "../core/types";

export function validateJsonObject(input: JsonObject, schema?: JsonSchemaObject): void {
  if (!schema) {
    return;
  }

  if (schema.type !== "object") {
    throw new NexusEdgeError("TOOL_VALIDATION_ERROR", "Only object input schemas are supported.");
  }

  validateObjectShape(input, schema, "");
}

function validateObjectShape(input: JsonObject, schema: JsonSchemaObject | JsonSchemaProperty, path: string): void {
  const required = schema.required ?? [];
  for (const key of required) {
    if (!(key in input)) {
      throw new NexusEdgeError("TOOL_VALIDATION_ERROR", `Missing required tool input field: ${formatPath(path, key)}.`, {
        field: formatPath(path, key)
      });
    }
  }

  const properties = schema.properties ?? {};

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(input)) {
      if (!(key in properties)) {
        throw new NexusEdgeError("TOOL_VALIDATION_ERROR", `Unexpected tool input field: ${formatPath(path, key)}.`, {
          field: formatPath(path, key)
        });
      }
    }
  }

  for (const [key, property] of Object.entries(properties)) {
    if (!(key in input)) {
      continue;
    }

    validateProperty(input[key], property, formatPath(path, key));
  }
}

function validateProperty(value: JsonValue | undefined, property: JsonSchemaProperty, path: string): void {
  if (!matchesProperty(value, property)) {
    throw new NexusEdgeError("TOOL_VALIDATION_ERROR", `Invalid type for tool input field: ${path}.`, {
      field: path,
      expected: property.type
    });
  }

  if (property.enum && !property.enum.some((candidate) => jsonEquals(candidate, value))) {
    throw new NexusEdgeError("TOOL_VALIDATION_ERROR", `Invalid enum value for tool input field: ${path}.`, {
      field: path
    });
  }

  if (property.type === "object") {
    validateObjectShape(value as JsonObject, property, path);
  } else if (property.type === "array" && property.items) {
    (value as readonly JsonValue[]).forEach((item, index) => {
      validateProperty(item, property.items as JsonSchemaProperty, `${path}[${index}]`);
    });
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

function formatPath(base: string, key: string): string {
  return base.length > 0 ? `${base}.${key}` : key;
}

function jsonEquals(left: JsonValue, right: JsonValue | undefined): boolean {
  if (right === undefined) {
    return false;
  }

  return JSON.stringify(left) === JSON.stringify(right);
}
