import type { EdgeTool } from "./tool";
import type { JsonObject, JsonValue } from "./types";

export interface EdgeAgentInit<
  Id extends string,
  Tools extends readonly EdgeTool<JsonObject, JsonValue>[]
> {
  readonly id: Id;
  readonly role: string;
  readonly goal: string;
  readonly backstory?: string;
  readonly tools?: Tools;
  readonly systemPrompt?: string;
  readonly maxToolCalls?: number;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly model?: string;
  readonly visibleOutput?: boolean;
}

export class EdgeAgent<
  Id extends string = string,
  Tools extends readonly EdgeTool<JsonObject, JsonValue>[] = readonly EdgeTool<JsonObject, JsonValue>[]
> {
  readonly id: Id;
  readonly role: string;
  readonly goal: string;
  readonly backstory?: string;
  readonly tools: Tools;
  readonly systemPrompt?: string;
  readonly maxToolCalls: number;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly model?: string;
  readonly visibleOutput: boolean;

  constructor(init: EdgeAgentInit<Id, Tools>) {
    this.id = init.id;
    this.role = init.role;
    this.goal = init.goal;
    this.backstory = init.backstory;
    this.tools = (init.tools ?? []) as unknown as Tools;
    this.systemPrompt = init.systemPrompt;
    this.maxToolCalls = init.maxToolCalls ?? 2;
    this.maxOutputTokens = init.maxOutputTokens;
    this.temperature = init.temperature;
    this.model = init.model;
    this.visibleOutput = init.visibleOutput ?? true;
  }

  buildSystemPrompt(): string {
    const tools = this.tools.length > 0
      ? this.tools.map((tool) => tool.toPromptDescriptor()).join("\n")
      : "No tools available.";

    return [
      this.systemPrompt ?? "",
      `Role: ${this.role}`,
      `Goal: ${this.goal}`,
      this.backstory ? `Backstory: ${this.backstory}` : "",
      "Return compact JSON following the NexusEdge agent protocol.",
      "Use tools only when they are necessary for the task.",
      "Do not reveal hidden reasoning. Return concise artifacts and final text only.",
      "Available tools:",
      tools
    ]
      .filter((part) => part.length > 0)
      .join("\n");
  }
}
