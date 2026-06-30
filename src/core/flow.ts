import { NexusEdgeError } from "./error";
import type { Artifact, MaybePromise } from "./types";

export type EndState = "END";

export type RouteTarget<Ids extends string> = Ids | EndState;

export interface RunView<Ids extends string> {
  readonly requestId: string;
  readonly currentAgentId: Ids;
  readonly step: number;
  readonly artifacts: readonly Artifact[];
  readonly lastText?: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export type RouteFunction<Ids extends string> = (context: RunView<Ids>) => MaybePromise<RouteTarget<Ids>>;

export interface LLMRouteSpec<Ids extends string> {
  readonly type: "llm";
  readonly routerAgentId?: Ids;
  readonly candidates: readonly RouteTarget<Ids>[];
  readonly instruction: string;
  readonly fallback: RouteTarget<Ids>;
}

export type RouteSpec<Ids extends string> = RouteTarget<Ids> | RouteFunction<Ids> | LLMRouteSpec<Ids>;

export interface FlowSpec<Ids extends string> {
  readonly start: Ids;
  readonly next: Readonly<Partial<Record<Ids, RouteSpec<Ids>>>>;
  readonly mode?: "dag" | "fsm";
}

export function isLlmRouteSpec<Ids extends string>(value: RouteSpec<Ids>): value is LLMRouteSpec<Ids> {
  return typeof value === "object" && value !== null && "type" in value && value.type === "llm";
}

export function validateFlow<Ids extends string>(flow: FlowSpec<Ids>, agents: ReadonlyMap<string, unknown>): void {
  if (!agents.has(flow.start)) {
    throw new NexusEdgeError("INVALID_FLOW", `Flow start agent is not registered: ${flow.start}.`, {
      agentId: flow.start
    });
  }

  for (const [from, spec] of Object.entries(flow.next) as unknown as readonly [Ids, RouteSpec<Ids>][]) {
    if (!agents.has(from)) {
      throw new NexusEdgeError("INVALID_FLOW", `Flow references unknown source agent: ${from}.`, {
        agentId: from
      });
    }

    validateRouteSpec(spec, agents);
  }

  if ((flow.mode ?? "dag") === "dag") {
    assertNoStaticCycles(flow);
  }
}

export function validateRouteTarget<Ids extends string>(target: RouteTarget<Ids>, agents: ReadonlyMap<string, unknown>): void {
  if (target === "END") {
    return;
  }

  if (!agents.has(target)) {
    throw new NexusEdgeError("INVALID_ROUTE", `Route target is not registered: ${target}.`, {
      target
    });
  }
}

function validateRouteSpec<Ids extends string>(spec: RouteSpec<Ids>, agents: ReadonlyMap<string, unknown>): void {
  if (typeof spec === "string") {
    validateRouteTarget(spec, agents);
    return;
  }

  if (typeof spec === "function") {
    return;
  }

  if (isLlmRouteSpec(spec)) {
    if (spec.candidates.length === 0) {
      throw new NexusEdgeError("INVALID_FLOW", "LLM route must provide at least one candidate.");
    }

    for (const candidate of spec.candidates) {
      validateRouteTarget(candidate, agents);
    }

    validateRouteTarget(spec.fallback, agents);

    if (!spec.candidates.includes(spec.fallback)) {
      throw new NexusEdgeError("INVALID_FLOW", "LLM route fallback must be included in candidates.");
    }

    if (spec.routerAgentId && !agents.has(spec.routerAgentId)) {
      throw new NexusEdgeError("INVALID_FLOW", `Router agent is not registered: ${spec.routerAgentId}.`, {
        agentId: spec.routerAgentId
      });
    }
  }
}

function assertNoStaticCycles<Ids extends string>(flow: FlowSpec<Ids>): void {
  const graph = new Map<string, readonly string[]>();

  for (const [from, spec] of Object.entries(flow.next) as unknown as readonly [Ids, RouteSpec<Ids>][]) {
    graph.set(from, staticTargets(spec));
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (node: string, path: readonly string[]): void => {
    if (node === "END") {
      return;
    }

    if (visiting.has(node)) {
      throw new NexusEdgeError("INVALID_FLOW", `DAG flow contains a static cycle: ${[...path, node].join(" -> ")}.`);
    }

    if (visited.has(node)) {
      return;
    }

    visiting.add(node);
    const nextNodes = graph.get(node) ?? [];
    for (const next of nextNodes) {
      visit(next, [...path, node]);
    }
    visiting.delete(node);
    visited.add(node);
  };

  visit(flow.start, []);
}

function staticTargets<Ids extends string>(spec: RouteSpec<Ids>): readonly string[] {
  if (typeof spec === "string") {
    return spec === "END" ? [] : [spec];
  }

  if (typeof spec === "function") {
    return [];
  }

  return spec.candidates.filter((candidate) => candidate !== "END");
}
