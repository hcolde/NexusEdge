import { performance } from "node:perf_hooks";
import { EdgeAgent, EdgeOrchestrator } from "../dist/index.mjs";

const iterations = Number.parseInt(process.env.NEXUSEDGE_BENCH_ITERATIONS ?? "100", 10);

class FixedProvider {
  name = "fixed";

  async complete() {
    return {
      text: JSON.stringify({
        type: "final",
        text: "ok",
        artifact: {
          kind: "benchmark",
          summary: "completed",
          data: {
            status: "ok"
          }
        }
      }),
      usage: {
        inputTokens: 32,
        outputTokens: 12,
        totalTokens: 44
      }
    };
  }

  async *stream() {
    yield { type: "delta", text: "ok" };
    yield { type: "done" };
  }
}

const provider = new FixedProvider();
const collector = new EdgeAgent({
  id: "collector",
  role: "Signal collector",
  goal: "Collect the input signal and produce a compact artifact.",
  visibleOutput: false
});
const writer = new EdgeAgent({
  id: "writer",
  role: "Brief writer",
  goal: "Write a concise result from collected artifacts."
});

const orchestrator = new EdgeOrchestrator({
  provider,
  maxSteps: 4,
  maxMemoryTokens: 2000
})
  .addAgent(collector)
  .addAgent(writer)
  .setFlow({
    start: "collector",
    mode: "dag",
    next: {
      collector: "writer",
      writer: "END"
    }
  });

const started = performance.now();

for (let index = 0; index < iterations; index += 1) {
  await orchestrator.run(`Benchmark request ${index}`);
}

const elapsedMs = performance.now() - started;
const perRunMs = elapsedMs / iterations;

console.log(`iterations: ${iterations}`);
console.log(`total: ${elapsedMs.toFixed(2)} ms`);
console.log(`per run: ${perRunMs.toFixed(2)} ms`);

if (!Number.isFinite(perRunMs) || perRunMs > 25) {
  throw new Error(`Benchmark smoke test exceeded overhead budget: ${perRunMs.toFixed(2)} ms/run`);
}
