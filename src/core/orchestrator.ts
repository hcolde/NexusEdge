import { EdgeAgent } from "./agent";
import { EdgeContextManager } from "./context";
import { NexusEdgeError, normalizeError } from "./error";
import { estimateTokens } from "./token";
import type { EdgeTool } from "./tool";
import type { Artifact, EdgeMessage, JsonObject, JsonValue, LLMProvider, ToolExecutionContext, TokenUsage } from "./types";
import type { FlowSpec, RouteSpec, RouteTarget, RunView } from "./flow";
import { isLlmRouteSpec, validateFlow, validateRouteTarget } from "./flow";
import { createSseStream } from "../streams/sse";
import { createAbortSignal, withTimeoutSignal } from "../utils/deadline";
import { createId } from "../utils/id";
import { isJsonObject, isJsonValue, parseJsonObjectFromText, stableStringify, truncateText } from "../utils/json";

export interface EdgeOrchestratorInit {
  readonly provider: LLMProvider;
  readonly summaryProvider?: LLMProvider;
  readonly maxMemoryTokens?: number;
  readonly maxShardTokens?: number;
  readonly maxArtifactTokens?: number;
  readonly maxArtifacts?: number;
  readonly maxToolOutputChars?: number;
  readonly maxSteps?: number;
  readonly maxRouteRetries?: number;
  readonly requestTimeoutMs?: number;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly model?: string;
}

export interface RunOptions {
  readonly signal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly streamMode?: "final" | "all" | "events";
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly model?: string;
}

export type RunEvent =
  | { readonly type: "run_start"; readonly requestId: string; readonly inputTokenEstimate: number }
  | { readonly type: "agent_start"; readonly requestId: string; readonly agentId: string; readonly step: number }
  | { readonly type: "tool_call"; readonly requestId: string; readonly agentId: string; readonly tool: string; readonly input: JsonObject }
  | { readonly type: "tool_result"; readonly requestId: string; readonly agentId: string; readonly tool: string; readonly preview: string; readonly tokenEstimate: number }
  | { readonly type: "agent_delta"; readonly requestId: string; readonly agentId: string; readonly text: string }
  | { readonly type: "artifact"; readonly requestId: string; readonly agentId: string; readonly artifact: Artifact }
  | { readonly type: "agent_done"; readonly requestId: string; readonly agentId: string; readonly text: string; readonly usage?: TokenUsage }
  | { readonly type: "route"; readonly requestId: string; readonly from: string; readonly to: string }
  | { readonly type: "run_done"; readonly requestId: string; readonly text: string; readonly artifacts: readonly Artifact[]; readonly steps: number }
  | { readonly type: "error"; readonly requestId: string; readonly code: string; readonly message: string; readonly details?: JsonValue };

export interface RunResult {
  readonly requestId: string;
  readonly text: string;
  readonly artifacts: readonly Artifact[];
  readonly steps: number;
  readonly events: readonly RunEvent[];
}

interface AgentExecution {
  readonly text: string;
  readonly artifact?: Artifact;
  readonly usage?: TokenUsage;
  readonly events: readonly RunEvent[];
}

interface AgentProtocolArtifact {
  readonly kind: string;
  readonly summary?: string;
  readonly data: JsonValue;
}

interface FinalAgentOutput {
  readonly type: "final";
  readonly text: string;
  readonly artifact?: AgentProtocolArtifact;
}

interface ToolCallAgentOutput {
  readonly type: "tool_call";
  readonly tool: string;
  readonly input: JsonObject;
}

type AgentProtocolOutput = FinalAgentOutput | ToolCallAgentOutput;

const AGENT_PROTOCOL_PROMPT = [
  "NexusEdge agent protocol:",
  "Return compact JSON only.",
  "To call a tool, return: {\"type\":\"tool_call\",\"tool\":\"toolName\",\"input\":{...}}",
  "To finish, return: {\"type\":\"final\",\"text\":\"...\",\"artifact\":{\"kind\":\"...\",\"summary\":\"...\",\"data\":{...}}}",
  "The artifact field is optional but recommended for downstream agents."
].join("\n");

export class EdgeOrchestrator<Ids extends string = never> {
  private readonly agents = new Map<string, EdgeAgent<string>>();
  private flow?: FlowSpec<Ids>;

  constructor(private readonly init: EdgeOrchestratorInit) {}

  addAgent<Id extends string>(agent: EdgeAgent<Id>): EdgeOrchestrator<Ids | Id> {
    this.agents.set(agent.id, agent as unknown as EdgeAgent<string>);
    return this as unknown as EdgeOrchestrator<Ids | Id>;
  }

  setFlow(flow: FlowSpec<Ids>): this {
    validateFlow(flow, this.agents);
    this.flow = flow;
    return this;
  }

  async run(input: string, options: RunOptions = {}): Promise<RunResult> {
    const events: RunEvent[] = [];
    let requestId = "";
    let text = "";
    let artifacts: readonly Artifact[] = [];
    let steps = 0;

    for await (const event of this.events(input, options)) {
      events.push(event);
      if (event.type === "run_start") {
        requestId = event.requestId;
      } else if (event.type === "run_done") {
        text = event.text;
        artifacts = event.artifacts;
        steps = event.steps;
      }
    }

    return {
      requestId,
      text,
      artifacts,
      steps,
      events
    };
  }

  async runAsStream(input: string, options: RunOptions = {}): Promise<ReadableStream<Uint8Array>> {
    return createSseStream(async (emit) => {
      const visibleArtifactOwnerIds = new Set<string>();
      let lastVisibleText = "";
      for await (const event of this.events(input, options)) {
        const streamEvent = this.toStreamEvent(event, options, visibleArtifactOwnerIds, (text) => {
          lastVisibleText = text;
        }, () => lastVisibleText);
        if (streamEvent) {
          await emit(streamEvent.type, streamEvent);
        }
      }
    });
  }

  async *events(input: string, options: RunOptions = {}): AsyncIterable<RunEvent> {
    if (!this.flow) {
      throw new NexusEdgeError("FLOW_NOT_SET", "Flow has not been configured.");
    }

    const requestId = createId("run");
    const timeout = withTimeoutSignal(options.signal, this.init.requestTimeoutMs);
    const signal = timeout.signal;
    const metadata = { ...(this.init.metadata ?? {}), ...(options.metadata ?? {}) };
    const context = new EdgeContextManager({
      requestId,
      input,
      maxMemoryTokens: this.init.maxMemoryTokens ?? 4000,
      maxShardTokens: this.init.maxShardTokens,
      maxArtifactTokens: this.init.maxArtifactTokens,
      maxArtifacts: this.init.maxArtifacts,
      maxToolOutputChars: this.init.maxToolOutputChars,
      summaryProvider: this.init.summaryProvider
    });

    let current: RouteTarget<Ids> = this.flow.start;
    let step = 0;
    let lastText = "";

    try {
      yield {
        type: "run_start",
        requestId,
        inputTokenEstimate: estimateTokens(input)
      };

      while (current !== "END") {
        if (signal.aborted) {
          throw new NexusEdgeError("ABORTED", "The orchestration run was aborted.");
        }

        if (step >= (this.init.maxSteps ?? 16)) {
          throw new NexusEdgeError("MAX_STEPS", "Maximum orchestration steps exceeded.", {
            maxSteps: this.init.maxSteps ?? 16
          });
        }

        const agent = this.getAgent(current);
        yield {
          type: "agent_start",
          requestId,
          agentId: agent.id,
          step
        };

        const execution = await this.invokeAgent(agent, context, {
          requestId,
          signal,
          metadata,
          options
        });

        for (const event of execution.events) {
          yield event;
        }

        if (execution.artifact) {
          yield {
            type: "artifact",
            requestId,
            agentId: agent.id,
            artifact: execution.artifact
          };
        }

        yield {
          type: "agent_done",
          requestId,
          agentId: agent.id,
          text: execution.text,
          usage: execution.usage
        };

        lastText = execution.text;

        const next = await this.resolveRoute({
          spec: this.flow.next[current] ?? "END",
          current,
          requestId,
          step,
          context,
          lastText,
          metadata,
          signal,
          options
        });

        yield {
          type: "route",
          requestId,
          from: current,
          to: next
        };

        await context.compactIfNeeded(agent.id, signal);
        current = next;
        step += 1;
      }

      yield {
        type: "run_done",
        requestId,
        text: lastText,
        artifacts: context.getArtifacts(),
        steps: step
      };
    } catch (error) {
      const normalized = normalizeError(error);
      yield {
        type: "error",
        requestId,
        code: normalized.code,
        message: normalized.message,
        details: normalized.details
      };
      throw normalized;
    } finally {
      timeout.clear();
    }
  }

  private async invokeAgent(
    agent: EdgeAgent<string>,
    context: EdgeContextManager,
    runtime: {
      readonly requestId: string;
      readonly signal: AbortSignal;
      readonly metadata: Readonly<Record<string, string>>;
      readonly options: RunOptions;
    }
  ): Promise<AgentExecution> {
    const events: RunEvent[] = [];
    const localMessages: EdgeMessage[] = [
      ...context.buildMessages(agent),
      { role: "system", content: AGENT_PROTOCOL_PROMPT }
    ];

    let usage: TokenUsage | undefined;

    for (let toolCallIndex = 0; toolCallIndex <= agent.maxToolCalls; toolCallIndex += 1) {
      const result = await this.init.provider.complete({
        messages: localMessages,
        responseFormat: "json",
        model: runtime.options.model ?? agent.model ?? this.init.model,
        temperature: runtime.options.temperature ?? agent.temperature ?? this.init.temperature ?? 0.2,
        maxTokens: runtime.options.maxTokens ?? agent.maxOutputTokens ?? this.init.maxTokens ?? 900,
        signal: runtime.signal
      });

      usage = result.usage ?? usage;
      const parsed = parseAgentOutput(result.text);

      if (parsed.type === "final") {
        context.appendMessage(agent.id, {
          role: "assistant",
          content: parsed.text
        });

        const artifact = this.createArtifactFromFinal(agent.id, context, parsed);

        if (shouldEmitText(agent, runtime.options) && parsed.text.length > 0) {
          events.push({
            type: "agent_delta",
            requestId: runtime.requestId,
            agentId: agent.id,
            text: parsed.text
          });
        }

        return {
          text: parsed.text,
          artifact,
          usage,
          events
        };
      }

      if (toolCallIndex >= agent.maxToolCalls) {
        throw new NexusEdgeError("MAX_TOOL_CALLS", `Agent exceeded max tool calls: ${agent.id}.`, {
          agentId: agent.id,
          maxToolCalls: agent.maxToolCalls
        });
      }

      const tool = findTool(agent.tools, parsed.tool);
      if (!tool) {
        throw new NexusEdgeError("TOOL_NOT_FOUND", `Tool is not registered on agent ${agent.id}: ${parsed.tool}.`, {
          agentId: agent.id,
          tool: parsed.tool
        });
      }

      events.push({
        type: "tool_call",
        requestId: runtime.requestId,
        agentId: agent.id,
        tool: parsed.tool,
        input: parsed.input
      });

      context.appendMessage(agent.id, {
        role: "assistant",
        content: stableStringify({ type: "tool_call", tool: parsed.tool, input: parsed.input }),
        ephemeral: true
      });

      const toolContext: ToolExecutionContext = {
        requestId: runtime.requestId,
        signal: runtime.signal,
        metadata: runtime.metadata
      };

      let output: JsonValue;
      try {
        output = await tool.run(parsed.input, toolContext);
      } catch (error) {
        const normalized = normalizeError(error);
        if (normalized.code === "UNKNOWN") {
          throw new NexusEdgeError("TOOL_EXECUTION_ERROR", normalized.message, {
            agentId: agent.id,
            tool: parsed.tool
          });
        }
        throw normalized;
      }

      const outputText = serializeToolOutput(output, context.maxToolOutputChars);
      context.appendToolResult(agent.id, parsed.tool, outputText);
      localMessages.push({
        role: "assistant",
        content: stableStringify({ type: "tool_call", tool: parsed.tool, input: parsed.input })
      });
      localMessages.push({
        role: "tool",
        name: parsed.tool,
        content: outputText
      });

      events.push({
        type: "tool_result",
        requestId: runtime.requestId,
        agentId: agent.id,
        tool: parsed.tool,
        preview: truncateText(outputText, 800),
        tokenEstimate: estimateTokens(outputText)
      });
    }

    throw new NexusEdgeError("MAX_TOOL_CALLS", `Agent exceeded max tool calls: ${agent.id}.`, {
      agentId: agent.id,
      maxToolCalls: agent.maxToolCalls
    });
  }

  private createArtifactFromFinal(agentId: string, context: EdgeContextManager, parsed: FinalAgentOutput): Artifact {
    if (parsed.artifact) {
      return context.putArtifact({
        ownerAgentId: agentId,
        scope: "shared",
        kind: parsed.artifact.kind,
        summary: parsed.artifact.summary,
        data: parsed.artifact.data
      });
    }

    return context.putArtifact({
      ownerAgentId: agentId,
      scope: "shared",
      kind: "agent_result",
      summary: truncateText(parsed.text, 240),
      data: {
        text: parsed.text
      }
    });
  }

  private async resolveRoute(args: {
    readonly spec: RouteSpec<Ids>;
    readonly current: Ids;
    readonly requestId: string;
    readonly step: number;
    readonly context: EdgeContextManager;
    readonly lastText: string;
    readonly metadata: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
    readonly options: RunOptions;
  }): Promise<RouteTarget<Ids>> {
    if (typeof args.spec === "string") {
      validateRouteTarget(args.spec, this.agents);
      return args.spec;
    }

    if (typeof args.spec === "function") {
      const view: RunView<Ids> = {
        requestId: args.requestId,
        currentAgentId: args.current,
        step: args.step,
        artifacts: args.context.getArtifacts(),
        lastText: args.lastText,
        metadata: args.metadata
      };
      const target = await args.spec(view);
      validateRouteTarget(target, this.agents);
      return target;
    }

    if (isLlmRouteSpec(args.spec)) {
      return await this.resolveLlmRoute(args);
    }

    throw new NexusEdgeError("INVALID_ROUTE", "Unsupported route spec.");
  }

  private async resolveLlmRoute(args: {
    readonly spec: RouteSpec<Ids>;
    readonly current: Ids;
    readonly requestId: string;
    readonly step: number;
    readonly context: EdgeContextManager;
    readonly lastText: string;
    readonly metadata: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
    readonly options: RunOptions;
  }): Promise<RouteTarget<Ids>> {
    if (!isLlmRouteSpec(args.spec)) {
      throw new NexusEdgeError("INVALID_ROUTE", "Route spec is not an LLM route.");
    }

    const routerAgent = args.spec.routerAgentId ? this.getAgent(args.spec.routerAgentId) : undefined;
    const systemPrompt = routerAgent
      ? routerAgent.buildSystemPrompt()
      : "You are a routing classifier. Choose the next state from the allowed candidates. Return compact JSON only.";

    const candidates = args.spec.candidates.map((candidate) => String(candidate));
    const maxRetries = this.init.maxRouteRetries ?? 1;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const prompt = [
        `Current state: ${args.current}`,
        `Allowed candidates: ${candidates.join(", ")}`,
        `Routing instruction: ${args.spec.instruction}`,
        `Last agent output: ${truncateText(args.lastText, 1200)}`,
        `Artifacts:\n${args.context.formatSharedArtifacts(2500)}`,
        "Return exactly: {\"next\":\"candidate\"}"
      ].join("\n\n");

      const result = await this.init.provider.complete({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt }
        ],
        responseFormat: "json",
        temperature: 0,
        maxTokens: 80,
        model: args.options.model ?? this.init.model,
        signal: args.signal
      });

      const parsed = parseJsonObjectFromText(result.text);
      if (parsed.ok && isJsonObject(parsed.value)) {
        const next = parsed.value.next;
        if (typeof next === "string" && candidates.includes(next)) {
          const target = next as RouteTarget<Ids>;
          validateRouteTarget(target, this.agents);
          return target;
        }
      }
    }

    validateRouteTarget(args.spec.fallback, this.agents);
    return args.spec.fallback;
  }

  private getAgent(id: string): EdgeAgent<string> {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new NexusEdgeError("AGENT_NOT_FOUND", `Agent is not registered: ${id}.`, {
        agentId: id
      });
    }

    return agent;
  }

  private toStreamEvent(
    event: RunEvent,
    options: RunOptions,
    visibleArtifactOwnerIds: Set<string>,
    setLastVisibleText: (text: string) => void,
    getLastVisibleText: () => string
  ): RunEvent | undefined {
    if ("agentId" in event && !shouldExposeAgentOutput(this.getAgent(event.agentId), options)) {
      if (
        event.type === "agent_delta" ||
        event.type === "artifact" ||
        event.type === "agent_done" ||
        event.type === "tool_call" ||
        event.type === "tool_result"
      ) {
        return undefined;
      }
    }

    if (event.type === "artifact") {
      visibleArtifactOwnerIds.add(event.agentId);
    } else if (event.type === "agent_done") {
      visibleArtifactOwnerIds.add(event.agentId);
      setLastVisibleText(event.text);
    } else if (event.type === "run_done") {
      return {
        ...event,
        text: getLastVisibleText(),
        artifacts: event.artifacts.filter((artifact) => visibleArtifactOwnerIds.has(artifact.ownerAgentId))
      };
    }

    return event;
  }
}

function findTool(tools: readonly EdgeTool<JsonObject, JsonValue>[], name: string): EdgeTool<JsonObject, JsonValue> | undefined {
  return tools.find((tool) => tool.name === name);
}

function shouldEmitText(agent: EdgeAgent<string>, options: RunOptions): boolean {
  if (options.streamMode === "events") {
    return false;
  }

  if (options.streamMode === "all") {
    return true;
  }

  return agent.visibleOutput;
}

function shouldExposeAgentOutput(agent: EdgeAgent<string>, options: RunOptions): boolean {
  return options.streamMode === "all" || agent.visibleOutput;
}

function parseAgentOutput(text: string): AgentProtocolOutput {
  const parsed = parseJsonObjectFromText(text);

  if (!parsed.ok) {
    if (parsed.code === "JSON_LIMIT") {
      throw new NexusEdgeError("PROVIDER_PARSE_ERROR", parsed.error);
    }

    return {
      type: "final",
      text: text.trim(),
      artifact: {
        kind: "agent_result",
        summary: truncateText(text.trim(), 240),
        data: {
          text: text.trim()
        }
      }
    };
  }

  if (!isJsonObject(parsed.value)) {
    return {
      type: "final",
      text: text.trim(),
      artifact: {
        kind: "agent_result",
        summary: truncateText(text.trim(), 240),
        data: {
          text: text.trim()
        }
      }
    };
  }

  const value = parsed.value;

  if (value.type === "tool_call") {
    const tool = value.tool;
    const input = value.input;

    if (typeof tool === "string" && isJsonObject(input)) {
      return {
        type: "tool_call",
        tool,
        input
      };
    }
  }

  if (value.type === "final") {
    const textValue = typeof value.text === "string" ? value.text : "";
    const artifact = parseProtocolArtifact(value.artifact);
    if (artifact) {
      return {
        type: "final",
        text: textValue,
        artifact
      };
    }

    return {
      type: "final",
      text: textValue
    };
  }

  return {
    type: "final",
    text: text.trim(),
    artifact: {
      kind: "agent_result",
      summary: truncateText(text.trim(), 240),
      data: {
        text: text.trim()
      }
    }
  };
}

function parseProtocolArtifact(value: JsonValue | undefined): AgentProtocolArtifact | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }

  const kind = typeof value.kind === "string" ? value.kind : undefined;
  const data = value.data;

  if (!kind || !isJsonValue(data)) {
    return undefined;
  }

  const summary = typeof value.summary === "string" ? value.summary : undefined;

  if (summary) {
    return {
      kind,
      summary,
      data
    };
  }

  return {
    kind,
    data
  };
}

function serializeToolOutput(value: JsonValue, maxChars: number): string {
  const text = typeof value === "string" ? value : stableStringify(value);
  return truncateText(text, maxChars);
}

export function createNeverAbortedSignal(): AbortSignal {
  return createAbortSignal();
}
