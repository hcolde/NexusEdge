import type { JsonObject, JsonSchemaObject, JsonValue, ToolExecutionContext } from "./types";
import { validateJsonObject } from "../utils/schema";

export interface EdgeToolInit<I extends JsonObject, O extends JsonValue> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: JsonSchemaObject;
  readonly execute: (input: Readonly<I>, context: ToolExecutionContext) => O | Promise<O>;
}

export class EdgeTool<I extends JsonObject = JsonObject, O extends JsonValue = JsonValue> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: JsonSchemaObject;

  private readonly executor: EdgeToolInit<I, O>["execute"];

  constructor(init: EdgeToolInit<I, O>) {
    this.name = init.name;
    this.description = init.description;
    this.inputSchema = init.inputSchema;
    this.executor = init.execute;
  }

  async run(input: I, context: ToolExecutionContext): Promise<O> {
    validateJsonObject(input, this.inputSchema);
    return await this.executor(input, context);
  }

  toPromptDescriptor(): string {
    const schema = this.inputSchema ? JSON.stringify(this.inputSchema) : "{\"type\":\"object\"}";
    return `- ${this.name}: ${this.description}\n  input_schema: ${schema}`;
  }
}
