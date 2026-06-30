import { describe, expect, it } from "vitest";
import { EdgeAgent, EdgeOrchestrator, EdgeTool, parseSse } from "../src";
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
});
