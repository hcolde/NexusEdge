import type { EdgeAgent } from "./agent";
import type { Artifact, EdgeMessage, JsonValue, LLMProvider } from "./types";
import { estimateMessageTokens, estimateTokens } from "./token";
import { createId } from "../utils/id";
import { stableStringify, truncateText } from "../utils/json";

export interface EdgeContextManagerInit {
  readonly requestId: string;
  readonly input: string;
  readonly maxMemoryTokens: number;
  readonly maxShardTokens?: number;
  readonly maxArtifactTokens?: number;
  readonly maxArtifacts?: number;
  readonly maxToolOutputChars?: number;
  readonly summaryProvider?: LLMProvider;
}

export interface PutArtifactInput<T extends JsonValue> {
  readonly ownerAgentId: string;
  readonly scope?: "private" | "shared";
  readonly kind: string;
  readonly data: T;
  readonly summary?: string;
}

export interface ContextShardSnapshot {
  readonly agentId: string;
  readonly messages: readonly EdgeMessage[];
  readonly summary?: string;
  readonly tokenEstimate: number;
  readonly lastCompactedAt?: number;
}

interface ContextShard {
  readonly agentId: string;
  messages: EdgeMessage[];
  summary?: string;
  tokenEstimate: number;
  lastCompactedAt?: number;
}

const SUMMARY_PROMPT = [
  "Summarize the following agent-local context for continuation.",
  "Keep only facts, tool outputs, decisions, constraints, and unresolved questions.",
  "Do not invent facts.",
  "Maximum 180 tokens.",
  "Return plain text only."
].join("\n");

export class EdgeContextManager {
  readonly requestId: string;
  readonly originalInput: string;
  readonly maxMemoryTokens: number;
  readonly maxShardTokens: number;
  readonly maxArtifactTokens: number;
  readonly maxArtifacts: number;
  readonly maxToolOutputChars: number;

  private readonly summaryProvider?: LLMProvider;
  private readonly shards = new Map<string, ContextShard>();
  private readonly artifacts: Artifact[] = [];

  constructor(init: EdgeContextManagerInit) {
    this.requestId = init.requestId;
    this.originalInput = init.input;
    this.maxMemoryTokens = init.maxMemoryTokens;
    this.maxShardTokens = init.maxShardTokens ?? Math.max(512, Math.floor(init.maxMemoryTokens * 0.55));
    this.maxArtifactTokens = init.maxArtifactTokens ?? Math.max(256, Math.floor(init.maxMemoryTokens * 0.3));
    this.maxArtifacts = init.maxArtifacts ?? 16;
    this.maxToolOutputChars = init.maxToolOutputChars ?? 4000;
    this.summaryProvider = init.summaryProvider;
  }

  getArtifacts(): readonly Artifact[] {
    return [...this.artifacts];
  }

  getSharedArtifacts(): readonly Artifact[] {
    return this.artifacts.filter((artifact) => artifact.scope === "shared");
  }

  getShard(agentId: string): ContextShardSnapshot {
    const shard = this.ensureShard(agentId);
    return {
      agentId: shard.agentId,
      messages: [...shard.messages],
      summary: shard.summary,
      tokenEstimate: shard.tokenEstimate,
      lastCompactedAt: shard.lastCompactedAt
    };
  }

  appendMessage(agentId: string, message: EdgeMessage): void {
    const shard = this.ensureShard(agentId);
    const normalized: EdgeMessage = {
      ...message,
      tokenEstimate: message.tokenEstimate ?? estimateMessageTokens(message.role, message.content),
      createdAt: message.createdAt ?? Date.now()
    };

    shard.messages.push(normalized);
    shard.tokenEstimate += normalized.tokenEstimate ?? 0;
  }

  appendUserInput(agentId: string, input: string): void {
    this.appendMessage(agentId, {
      role: "user",
      content: input
    });
  }

  appendToolResult(agentId: string, toolName: string, output: string): void {
    this.appendMessage(agentId, {
      role: "tool",
      name: toolName,
      content: truncateText(output, this.maxToolOutputChars),
      ephemeral: false
    });
  }

  putArtifact<T extends JsonValue>(input: PutArtifactInput<T>): Artifact<T> {
    const serialized = stableStringify(input.data);
    const tokenEstimate = estimateTokens([input.kind, input.summary ?? "", serialized].join("\n"));

    const artifact: Artifact<T> = {
      id: createId("art"),
      ownerAgentId: input.ownerAgentId,
      scope: input.scope ?? "shared",
      kind: input.kind,
      data: input.data,
      summary: input.summary,
      tokenEstimate,
      createdAt: Date.now()
    };

    this.artifacts.push(artifact);
    this.evictArtifactsIfNeeded();
    return artifact;
  }

  buildMessages(agent: EdgeAgent<string>): readonly EdgeMessage[] {
    const shard = this.ensureShard(agent.id);
    const messages: EdgeMessage[] = [
      {
        role: "system",
        content: agent.buildSystemPrompt()
      },
      {
        role: "user",
        content: `Original task:\n${this.originalInput}`
      }
    ];

    const artifactText = this.formatSharedArtifacts(3000);
    if (artifactText.length > 0) {
      messages.push({
        role: "system",
        content: `Shared artifacts available to this agent:\n${artifactText}`
      });
    }

    if (shard.summary && shard.summary.length > 0) {
      messages.push({
        role: "system",
        content: `Continuation summary for this agent:\n${shard.summary}`
      });
    }

    messages.push(...shard.messages);
    return messages;
  }

  formatSharedArtifacts(maxChars: number): string {
    const lines: string[] = [];
    for (const artifact of this.getSharedArtifacts()) {
      const data = artifact.summary ?? stableStringify(artifact.data);
      lines.push(
        [
          `Artifact ${artifact.id}`,
          `owner=${artifact.ownerAgentId}`,
          `kind=${artifact.kind}`,
          `summary=${truncateText(data, 600)}`
        ].join(" | ")
      );
    }

    return truncateText(lines.join("\n"), maxChars);
  }

  getTotalTokenEstimate(): number {
    let total = estimateTokens(this.originalInput);
    for (const shard of this.shards.values()) {
      total += shard.tokenEstimate;
      if (shard.summary) {
        total += estimateTokens(shard.summary);
      }
    }

    for (const artifact of this.artifacts) {
      total += artifact.tokenEstimate;
    }

    return total;
  }

  async compactIfNeeded(agentId: string, signal?: AbortSignal): Promise<void> {
    const shard = this.ensureShard(agentId);

    if (this.estimateShardTotal(shard) <= this.maxShardTokens && this.getTotalTokenEstimate() <= this.maxMemoryTokens) {
      return;
    }

    shard.messages = shard.messages.filter((message, index) => {
      const isRecent = index >= shard.messages.length - 4;
      return !message.ephemeral || isRecent;
    });
    this.recalculateShard(shard);

    if (this.estimateShardTotal(shard) <= this.maxShardTokens) {
      return;
    }

    const compactCount = Math.max(1, Math.floor(shard.messages.length * 0.5));
    const compactedMessages = shard.messages.slice(0, compactCount);
    const recentMessages = shard.messages.slice(compactCount);
    const compactBlock = compactedMessages
      .map((message) => `${message.role}${message.name ? `:${message.name}` : ""}: ${message.content}`)
      .join("\n");

    const summary = await this.summarize(compactBlock, signal);
    shard.summary = [shard.summary, summary].filter((part): part is string => Boolean(part)).join("\n");
    shard.summary = truncateText(shard.summary, 3000);
    shard.messages = recentMessages;
    shard.lastCompactedAt = Date.now();
    this.recalculateShard(shard);

    while (this.estimateShardTotal(shard) > this.maxShardTokens && shard.messages.length > 1) {
      shard.messages.shift();
      this.recalculateShard(shard);
    }

    if (this.estimateShardTotal(shard) > this.maxShardTokens && shard.messages.length === 1) {
      const only = shard.messages[0];
      if (only) {
        shard.messages[0] = {
          ...only,
          content: truncateText(only.content, Math.max(200, this.maxShardTokens * 3)),
          tokenEstimate: estimateMessageTokens(only.role, truncateText(only.content, Math.max(200, this.maxShardTokens * 3)))
        };
        this.recalculateShard(shard);
      }
    }
  }

  private ensureShard(agentId: string): ContextShard {
    const existing = this.shards.get(agentId);
    if (existing) {
      return existing;
    }

    const shard: ContextShard = {
      agentId,
      messages: [],
      tokenEstimate: 0
    };
    this.shards.set(agentId, shard);
    return shard;
  }

  private recalculateShard(shard: ContextShard): void {
    shard.tokenEstimate = shard.messages.reduce((total, message) => total + (message.tokenEstimate ?? estimateMessageTokens(message.role, message.content)), 0);
  }

  private estimateShardTotal(shard: ContextShard): number {
    return shard.tokenEstimate + (shard.summary ? estimateTokens(shard.summary) : 0);
  }

  private async summarize(text: string, signal?: AbortSignal): Promise<string> {
    const fallback = deterministicSummary(text);

    if (!this.summaryProvider) {
      return fallback;
    }

    try {
      const result = await this.summaryProvider.complete({
        messages: [
          { role: "system", content: SUMMARY_PROMPT },
          { role: "user", content: truncateText(text, 6000) }
        ],
        temperature: 0,
        maxTokens: 220,
        responseFormat: "text",
        signal
      });

      return truncateText(result.text.trim() || fallback, 1200);
    } catch {
      return fallback;
    }
  }

  private evictArtifactsIfNeeded(): void {
    let total = this.artifacts.reduce((sum, artifact) => sum + artifact.tokenEstimate, 0);

    while ((total > this.maxArtifactTokens || this.artifacts.length > this.maxArtifacts) && this.artifacts.length > 0) {
      const removableIndex = this.artifacts.findIndex((artifact) => artifact.kind !== "final" && artifact.kind !== "decision");
      const index = removableIndex >= 0 ? removableIndex : 0;
      const removed = this.artifacts.splice(index, 1)[0];
      if (!removed) {
        return;
      }
      total -= removed.tokenEstimate;
    }
  }
}

function deterministicSummary(text: string): string {
  const compact = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 24)
    .join("\n");

  return truncateText(`Compacted context:\n${compact}`, 1200);
}
