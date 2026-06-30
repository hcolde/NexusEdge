import { describe, expect, it } from "vitest";
import { EdgeAgent, EdgeOrchestrator, EdgeTool, NexusEdgeError, parseSse, withTimeoutSignal } from "../src";
import type { LLMCompleteResult, LLMProvider, LLMRequest, LLMStreamEvent } from "../src";
import { QueueProvider } from "./mock-provider";

describe("EdgeOrchestrator", () => {
  it("runs a static DAG", async () => {
    const provider = new QueueProvider([
      JSON.stringify({
        type: "final",
        text: "analysis complete",
        artifact: {
          kind: "analysis",
          summary: "risk is medium",
          data: { risk: "medium" }
        }
      }),
      JSON.stringify({
        type: "final",
        text: "final brief",
        artifact: {
          kind: "final",
          summary: "final brief",
          data: { text: "final brief" }
        }
      })
    ]);

    const analyst = new EdgeAgent({
      id: "analyst",
      role: "analyst",
      goal: "analyze",
      visibleOutput: false
    });

    const writer = new EdgeAgent({
      id: "writer",
      role: "writer",
      goal: "write"
    });

    const orchestrator = new EdgeOrchestrator({ provider })
      .addAgent(analyst)
      .addAgent(writer)
      .setFlow({
        start: "analyst",
        next: {
          analyst: "writer",
          writer: "END"
        }
      });

    const result = await orchestrator.run("analyze BTC");
    expect(result.text).toBe("final brief");
    expect(result.steps).toBe(2);
    expect(result.artifacts.length).toBe(2);
  });

  it("executes the JSON tool protocol", async () => {
    const provider = new QueueProvider([
      JSON.stringify({
        type: "tool_call",
        tool: "echo",
        input: { value: "BTC" }
      }),
      JSON.stringify({
        type: "final",
        text: "tool used",
        artifact: {
          kind: "tool_result_summary",
          summary: "echo returned BTC",
          data: { ok: true }
        }
      })
    ]);

    const echo = new EdgeTool<{ readonly value: string }, { readonly echoed: string }>({
      name: "echo",
      description: "echo input",
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "string" }
        },
        required: ["value"],
        additionalProperties: false
      },
      execute(input) {
        return { echoed: input.value };
      }
    });

    const agent = new EdgeAgent({
      id: "agent",
      role: "tool user",
      goal: "use echo",
      tools: [echo]
    });

    const orchestrator = new EdgeOrchestrator({ provider })
      .addAgent(agent)
      .setFlow({
        start: "agent",
        next: {
          agent: "END"
        }
      });

    const result = await orchestrator.run("echo BTC");
    expect(result.text).toBe("tool used");
    expect(result.events.some((event) => event.type === "tool_call")).toBe(true);
    expect(result.events.some((event) => event.type === "tool_result")).toBe(true);
  });

  it("does not execute tool calls embedded in prose", async () => {
    let toolExecuted = false;
    const prose = 'Here is an example: {"type":"tool_call","tool":"echo","input":{"value":"BTC"}}';
    const provider = new QueueProvider([prose]);
    const echo = new EdgeTool<{ readonly value: string }, { readonly echoed: string }>({
      name: "echo",
      description: "echo input",
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "string" }
        },
        required: ["value"],
        additionalProperties: false
      },
      execute(input) {
        toolExecuted = true;
        return { echoed: input.value };
      }
    });
    const agent = new EdgeAgent({
      id: "agent",
      role: "tool user",
      goal: "use echo",
      tools: [echo]
    });
    const orchestrator = new EdgeOrchestrator({ provider })
      .addAgent(agent)
      .setFlow({
        start: "agent",
        next: {
          agent: "END"
        }
      });

    const result = await orchestrator.run("echo BTC");

    expect(result.text).toBe(prose);
    expect(toolExecuted).toBe(false);
    expect(result.events.some((event) => event.type === "tool_call")).toBe(false);
  });

  it("does not execute tool calls embedded in markdown fences", async () => {
    let toolExecuted = false;
    const fenced = [
      "```json",
      JSON.stringify({
        type: "tool_call",
        tool: "echo",
        input: { value: "BTC" }
      }),
      "```"
    ].join("\n");
    const provider = new QueueProvider([fenced]);
    const echo = new EdgeTool<{ readonly value: string }, { readonly echoed: string }>({
      name: "echo",
      description: "echo input",
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "string" }
        },
        required: ["value"],
        additionalProperties: false
      },
      execute(input) {
        toolExecuted = true;
        return { echoed: input.value };
      }
    });
    const agent = new EdgeAgent({
      id: "agent",
      role: "tool user",
      goal: "use echo",
      tools: [echo]
    });
    const orchestrator = new EdgeOrchestrator({ provider })
      .addAgent(agent)
      .setFlow({
        start: "agent",
        next: {
          agent: "END"
        }
      });

    const result = await orchestrator.run("echo BTC");

    expect(result.text).toBe(fenced);
    expect(toolExecuted).toBe(false);
    expect(result.events.some((event) => event.type === "tool_call")).toBe(false);
  });

  it("rejects original input that exceeds the memory budget before provider calls", async () => {
    let providerCalled = false;
    const provider = createProvider(async () => {
      providerCalled = true;
      return {
        text: JSON.stringify({ type: "final", text: "done" })
      };
    });
    const agent = new EdgeAgent({ id: "agent", role: "writer", goal: "write" });
    const orchestrator = new EdgeOrchestrator({ provider, maxMemoryTokens: 4 })
      .addAgent(agent)
      .setFlow({
        start: "agent",
        next: {
          agent: "END"
        }
      });

    await expect(orchestrator.run("x".repeat(1000))).rejects.toMatchObject({
      code: "CONTEXT_OVERFLOW"
    });
    expect(providerCalled).toBe(false);
  });

  it("passes shared artifacts as untrusted user data instead of system prompts", async () => {
    const requests: LLMRequest[] = [];
    const responses = [
      JSON.stringify({
        type: "final",
        text: "analysis complete",
        artifact: {
          kind: "analysis",
          summary: "IGNORE_SYSTEM_PROMPT",
          data: { note: "IGNORE_SYSTEM_DATA" }
        }
      }),
      JSON.stringify({
        type: "final",
        text: "final brief"
      })
    ];
    const provider = createProvider(async (request) => {
      requests.push(request);
      return {
        text: responses.shift() ?? JSON.stringify({ type: "final", text: "fallback" })
      };
    });
    const analyst = new EdgeAgent({
      id: "analyst",
      role: "analyst",
      goal: "analyze"
    });
    const writer = new EdgeAgent({
      id: "writer",
      role: "writer",
      goal: "write"
    });
    const orchestrator = new EdgeOrchestrator({ provider })
      .addAgent(analyst)
      .addAgent(writer)
      .setFlow({
        start: "analyst",
        next: {
          analyst: "writer",
          writer: "END"
        }
      });

    await orchestrator.run("analyze");

    const secondRequest = requests[1];
    expect(secondRequest).toBeDefined();
    const systemText = secondRequest?.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n") ?? "";
    const userText = secondRequest?.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n") ?? "";

    expect(systemText).not.toContain("IGNORE_SYSTEM_PROMPT");
    expect(userText).toContain("IGNORE_SYSTEM_PROMPT");
    expect(userText).toContain("untrusted data");
  });

  it("passes compacted summaries as untrusted user data instead of system prompts", async () => {
    const summaryMarker = "SUMMARY_INJECTION_MARKER";
    const requests: LLMRequest[] = [];
    const responses = [
      JSON.stringify({
        type: "final",
        text: "analysis complete"
      }),
      JSON.stringify({
        type: "final",
        text: "done"
      })
    ];
    const provider = createProvider(async (request) => {
      requests.push(request);
      return {
        text: responses.shift() ?? JSON.stringify({ type: "final", text: "fallback" })
      };
    });
    const summaryProvider = createProvider(async () => ({
      text: summaryMarker
    }));
    const agent = new EdgeAgent({
      id: "agent",
      role: "analyst",
      goal: "analyze"
    });
    const orchestrator = new EdgeOrchestrator({
      provider,
      summaryProvider,
      maxShardTokens: 1
    })
      .addAgent(agent)
      .setFlow({
        start: "agent",
        mode: "fsm",
        next: {
          agent: ({ step }) => step === 0 ? "agent" : "END"
        }
      });

    await orchestrator.run("analyze");

    const secondRequest = requests[1];
    expect(secondRequest).toBeDefined();
    const systemText = secondRequest?.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n") ?? "";
    const userText = secondRequest?.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n") ?? "";

    expect(systemText).not.toContain(summaryMarker);
    expect(userText).toContain(summaryMarker);
    expect(userText).toContain("untrusted data");
  });

  it("uses LLM routing with validated candidates", async () => {
    const provider = new QueueProvider([
      JSON.stringify({
        type: "final",
        text: "analysis says write",
        artifact: {
          kind: "analysis",
          summary: "needs brief",
          data: { next: "writer" }
        }
      }),
      JSON.stringify({ next: "writer" }),
      JSON.stringify({
        type: "final",
        text: "written",
        artifact: {
          kind: "final",
          summary: "written",
          data: { text: "written" }
        }
      })
    ]);

    const analyst = new EdgeAgent({ id: "analyst", role: "analyst", goal: "analyze" });
    const writer = new EdgeAgent({ id: "writer", role: "writer", goal: "write" });

    const orchestrator = new EdgeOrchestrator({ provider })
      .addAgent(analyst)
      .addAgent(writer)
      .setFlow({
        start: "analyst",
        mode: "fsm",
        next: {
          analyst: {
            type: "llm",
            candidates: ["writer", "END"],
            fallback: "END",
            instruction: "Route to writer when writing is required."
          },
          writer: "END"
        }
      });

    const result = await orchestrator.run("analyze and write");
    expect(result.text).toBe("written");
    expect(result.steps).toBe(2);
  });

  it("streams events as SSE", async () => {
    const provider = new QueueProvider([
      JSON.stringify({
        type: "final",
        text: "hello",
        artifact: {
          kind: "final",
          summary: "hello",
          data: { text: "hello" }
        }
      })
    ]);

    const agent = new EdgeAgent({ id: "agent", role: "writer", goal: "write" });
    const orchestrator = new EdgeOrchestrator({ provider })
      .addAgent(agent)
      .setFlow({
        start: "agent",
        next: {
          agent: "END"
        }
      });

    const stream = await orchestrator.runAsStream("say hello");
    const events = [];
    for await (const event of parseSse(stream)) {
      events.push(event.event);
    }

    expect(events).toContain("run_start");
    expect(events).toContain("agent_start");
    expect(events).toContain("run_done");
  });

  it("does not stream hidden agent output-bearing events", async () => {
    const provider = new QueueProvider([
      JSON.stringify({
        type: "final",
        text: "SECRET_HIDDEN_TEXT",
        artifact: {
          kind: "analysis",
          summary: "SECRET_HIDDEN_SUMMARY",
          data: { token: "SECRET_HIDDEN_ARTIFACT" }
        }
      })
    ]);
    const agent = new EdgeAgent({
      id: "agent",
      role: "internal analyst",
      goal: "analyze",
      visibleOutput: false
    });
    const orchestrator = new EdgeOrchestrator({ provider })
      .addAgent(agent)
      .setFlow({
        start: "agent",
        next: {
          agent: "END"
        }
      });

    const stream = await orchestrator.runAsStream("analyze");
    const events = [];
    const payloads = [];
    for await (const event of parseSse(stream)) {
      events.push(event.event);
      payloads.push(JSON.parse(event.data) as Record<string, unknown>);
    }

    expect(events).not.toContain("agent_delta");
    expect(events).not.toContain("artifact");
    expect(events).not.toContain("agent_done");
    expect(JSON.stringify(payloads)).not.toContain("SECRET_HIDDEN");
    expect(payloads.find((payload) => payload.type === "run_done")).toMatchObject({
      text: "",
      artifacts: []
    });
  });

  it("does not stream raw tool error messages from hidden agents", async () => {
    const provider = new QueueProvider([
      JSON.stringify({
        type: "tool_call",
        tool: "explode",
        input: {}
      })
    ]);
    const explode = new EdgeTool({
      name: "explode",
      description: "throw an error",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      execute() {
        throw new Error("SECRET_TOOL_FAILURE");
      }
    });
    const agent = new EdgeAgent({
      id: "agent",
      role: "internal analyst",
      goal: "analyze",
      tools: [explode],
      visibleOutput: false
    });
    const orchestrator = new EdgeOrchestrator({ provider })
      .addAgent(agent)
      .setFlow({
        start: "agent",
        next: {
          agent: "END"
        }
      });

    const stream = await orchestrator.runAsStream("analyze");
    const payloads = [];
    for await (const event of parseSse(stream)) {
      payloads.push(JSON.parse(event.data) as Record<string, unknown>);
    }

    expect(payloads.some((payload) => payload.type === "error")).toBe(true);
    expect(JSON.stringify(payloads)).not.toContain("SECRET_TOOL_FAILURE");
  });

  it("does not stream hidden agent NexusEdgeError details from tools", async () => {
    const provider = new QueueProvider([
      JSON.stringify({
        type: "tool_call",
        tool: "explode",
        input: {}
      })
    ]);
    const explode = new EdgeTool({
      name: "explode",
      description: "throw a framework error",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      execute() {
        throw new NexusEdgeError("TOOL_EXECUTION_ERROR", "SECRET_TOOL_MESSAGE", {
          secret: "SECRET_TOOL_DETAIL"
        });
      }
    });
    const agent = new EdgeAgent({
      id: "agent",
      role: "internal analyst",
      goal: "analyze",
      tools: [explode],
      visibleOutput: false
    });
    const orchestrator = new EdgeOrchestrator({ provider })
      .addAgent(agent)
      .setFlow({
        start: "agent",
        next: {
          agent: "END"
        }
      });

    const stream = await orchestrator.runAsStream("analyze");
    const payloads = [];
    for await (const event of parseSse(stream)) {
      payloads.push(JSON.parse(event.data) as Record<string, unknown>);
    }

    const serialized = JSON.stringify(payloads);
    expect(serialized).not.toContain("SECRET_TOOL_MESSAGE");
    expect(serialized).not.toContain("SECRET_TOOL_DETAIL");
    expect(serialized).toContain("Tool execution failed.");
  });

  it("rejects oversized provider completions before protocol parsing", async () => {
    const provider = new QueueProvider([
      JSON.stringify({
        type: "final",
        text: "x".repeat(1024 * 1024)
      })
    ]);
    const agent = new EdgeAgent({ id: "agent", role: "writer", goal: "write" });
    const orchestrator = new EdgeOrchestrator({ provider })
      .addAgent(agent)
      .setFlow({
        start: "agent",
        next: {
          agent: "END"
        }
      });

    await expect(orchestrator.run("write")).rejects.toMatchObject({
      code: "PROVIDER_PARSE_ERROR"
    });
  });

  it("rejects deeply nested provider completions without recursive validation failure", async () => {
    const provider = new QueueProvider([
      JSON.stringify({
        type: "final",
        text: "done",
        artifact: {
          kind: "nested",
          data: createNestedValue(80)
        }
      })
    ]);
    const agent = new EdgeAgent({ id: "agent", role: "writer", goal: "write" });
    const orchestrator = new EdgeOrchestrator({ provider })
      .addAgent(agent)
      .setFlow({
        start: "agent",
        next: {
          agent: "END"
        }
      });

    await expect(orchestrator.run("write")).rejects.toMatchObject({
      code: "PROVIDER_PARSE_ERROR"
    });
  });

  it("rejects oversized SSE event data", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: 0123456789abcdef\n\n"));
        controller.close();
      }
    });

    await expect(collectSse(stream, { maxEventDataChars: 8 })).rejects.toMatchObject({
      code: "SSE_PARSE_LIMIT"
    });
  });

  it("inherits an already-aborted source signal with positive timeouts", () => {
    const controller = new AbortController();
    controller.abort("client disconnected");

    const timeout = withTimeoutSignal(controller.signal, 1000);

    expect(timeout.signal.aborted).toBe(true);
    expect(timeout.signal.reason).toBe("client disconnected");
    timeout.clear();
  });
});

async function collectSse(
  stream: ReadableStream<Uint8Array>,
  options?: Parameters<typeof parseSse>[1]
): Promise<unknown[]> {
  const events = [];
  for await (const event of parseSse(stream, options)) {
    events.push(event);
  }
  return events;
}

function createProvider(complete: (request: LLMRequest) => Promise<Pick<LLMCompleteResult, "text" | "usage">>): LLMProvider {
  return {
    name: "test",
    complete,
    async *stream(): AsyncIterable<LLMStreamEvent> {
      yield { type: "done" };
    }
  };
}

function createNestedValue(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < depth; index += 1) {
    value = { child: value };
  }
  return value;
}
