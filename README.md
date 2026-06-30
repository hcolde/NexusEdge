# NexusEdge

NexusEdge is a zero-runtime-dependency TypeScript multi-agent orchestration framework designed for edge runtimes such as Cloudflare Workers, Vercel Edge Runtime, Deno Deploy, and Bun.

It uses a hybrid orchestration model:

- deterministic DAG/FSM transitions for known control flow;
- compact LLM-based routing only for semantic branch decisions;
- agent-local context shards instead of a global chat history;
- shared artifacts for cross-agent communication;
- native Web Streams/SSE output;
- provider adapters implemented directly with `fetch`.

## Why NexusEdge matters

Most agent frameworks assume a server process, a Node.js runtime, SDK dependencies, and a large shared conversation history. That is a poor fit for OSS projects that want agentic review, triage, release, or incident workflows close to users at the edge.

NexusEdge focuses on the missing edge-native layer:

- small orchestration core that can run in constrained edge runtimes;
- deterministic control flow first, with LLM routing only where semantics are needed;
- agent-local memory shards that reduce cross-agent prompt exposure;
- explicit handling for untrusted tool, artifact, and summary data;
- native streams for user-facing progress without framework adapters.

The goal is to make edge AI workflows easier to inspect, test, and maintain for open-source maintainers who need automation without carrying a server-heavy agent stack.

## Install

The npm package metadata is prepared, but this checkout is not currently authenticated to publish `nexusedge` to the npm registry. Until the npm package is published, install from a GitHub release tarball or build from source.

After the `v0.1.0` GitHub release is available:

```bash
npm install https://github.com/hcolde/NexusEdge/releases/download/v0.1.0/nexusedge-0.1.0.tgz
```

For local source usage:

```bash
git clone https://github.com/hcolde/NexusEdge.git
cd NexusEdge
npm ci
npm run build
npm pack
```

Then install the generated package tarball in another project:

```bash
npm install /path/to/nexusedge-0.1.0.tgz
```

When the package is published to npm, the standard install command will be:

```bash
npm install nexusedge
```

For local development from this repository:

```bash
npm ci
npm run ci
```

## Runtime constraints

The runtime library does not use Node.js APIs, external SDKs, file system access, dynamic code execution, or runtime dependencies.

The `scripts/` directory uses Node.js only for development-time build and verification tasks.

## Compatibility matrix

| Runtime | Status | Notes |
| --- | --- | --- |
| Cloudflare Workers | Target runtime | Uses `fetch`, `ReadableStream`, and SSE-compatible responses. |
| Vercel Edge Runtime | Target runtime | No Node.js runtime APIs required by the library. |
| Deno Deploy | Target runtime | Uses Web Platform APIs and ESM. |
| Bun | Target runtime | Example server included. |
| Node.js | Development and tests | Build, test, benchmark, and packaging scripts run on Node.js. |

Runtime constraints are enforced by `npm run check:source`, which rejects Node.js runtime imports, dynamic code execution, and other non-edge fragments in `src/`.

## Minimal example

```ts
import {
  EdgeAgent,
  EdgeTool,
  EdgeOrchestrator,
  OpenAICompatibleProvider,
  isJsonObject
} from "nexusedge";

const provider = new OpenAICompatibleProvider({
  baseURL: "https://api.openai.com/v1",
  apiKey: OPENAI_API_KEY,
  model: "gpt-4o-mini"
});

const fetchCryptoPriceTool = new EdgeTool<
  { readonly token: string },
  { readonly symbol: string; readonly price: string }
>({
  name: "fetchCryptoPrice",
  description: "Fetch the current USDT price for a crypto token.",
  inputSchema: {
    type: "object",
    properties: {
      token: {
        type: "string",
        description: "Token symbol, for example BTC."
      }
    },
    required: ["token"],
    additionalProperties: false
  },
  async execute(input, context) {
    const symbol = `${input.token.toUpperCase()}USDT`;
    const response = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`,
      { signal: context.signal }
    );

    if (!response.ok) {
      throw new Error(`Price API failed with ${response.status}`);
    }

    const payload: unknown = await response.json();
    if (!isJsonObject(payload)) {
      throw new Error("Unexpected price API response.");
    }

    return {
      symbol: typeof payload.symbol === "string" ? payload.symbol : symbol,
      price: typeof payload.price === "string" ? payload.price : ""
    };
  }
});

const analystAgent = new EdgeAgent({
  id: "analyst",
  role: "Data analyst",
  goal: "Analyze market data and produce a compact risk artifact.",
  tools: [fetchCryptoPriceTool],
  visibleOutput: false
});

const writerAgent = new EdgeAgent({
  id: "writer",
  role: "Executive brief writer",
  goal: "Convert analysis artifacts into a concise user-facing brief.",
  visibleOutput: true
});

const orchestrator = new EdgeOrchestrator({
  provider,
  maxMemoryTokens: 4000,
  maxSteps: 6
})
  .addAgent(analystAgent)
  .addAgent(writerAgent)
  .setFlow({
    start: "analyst",
    mode: "dag",
    next: {
      analyst: "writer",
      writer: "END"
    }
  });

export default {
  async fetch(request: Request): Promise<Response> {
    const prompt = await request.text();
    const stream = await orchestrator.runAsStream(prompt || "Analyze BTC.");

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache"
      }
    });
  }
};
```

## Agent output protocol

By default, agents are instructed to return compact JSON.

Final output:

```json
{
  "type": "final",
  "text": "Concise user-facing text.",
  "artifact": {
    "kind": "analysis",
    "summary": "Short summary for downstream agents.",
    "data": {
      "risk": "medium"
    }
  }
}
```

Tool call:

```json
{
  "type": "tool_call",
  "tool": "fetchCryptoPrice",
  "input": {
    "token": "BTC"
  }
}
```

NexusEdge validates the tool name, validates the input against the registered schema, truncates the tool output, stores the result in the current agent shard, and asks the same agent to continue.

## LLM router example

```ts
.setFlow({
  start: "analyst",
  mode: "fsm",
  next: {
    analyst: {
      type: "llm",
      candidates: ["riskReviewer", "writer", "END"],
      fallback: "writer",
      instruction:
        "Route to riskReviewer if the artifacts indicate high market risk. Route to writer when a final brief is required."
    },
    riskReviewer: "writer",
    writer: "END"
  }
});
```

The router must return:

```json
{"next":"writer"}
```

Invalid routes are rejected. If router output remains invalid after retry, the configured fallback is used.

## Real examples

The `examples/` directory includes smoke examples for Cloudflare Workers, Vercel Edge Runtime, Deno Deploy, and Bun.

It also includes `examples/edge-incident-triage/main.ts`, a realistic edge workflow where:

- a hidden collector agent fetches a bounded public status endpoint excerpt;
- a visible responder agent writes the customer-facing update;
- shared artifacts pass between agents without exposing hidden agent output directly;
- the response streams as native SSE from the edge runtime.

## Benchmark

Run the local orchestration overhead smoke benchmark:

```bash
npm run benchmark
```

The benchmark builds the package, runs a deterministic two-agent DAG with a fixed provider, and fails if orchestration overhead exceeds the smoke-test budget. It is meant to catch accidental core-runtime regressions, not to measure provider latency.

## Public API

Main exports:

- `EdgeAgent`
- `EdgeTool`
- `EdgeOrchestrator`
- `EdgeContextManager`
- `OpenAICompatibleProvider`
- `AnthropicProvider`
- `NexusEdgeError`
- `estimateTokens`
- `parseSse`
- `createSseStream`
- JSON helpers and core types

## Development

```bash
npm ci
npm run ci
npm run benchmark
npm pack --dry-run
```

Individual checks:

```bash
npm run typecheck
npm test
npm run build
npm run size
```

The production runtime bundle is emitted to `dist/index.mjs`. The size check fails if the core bundle exceeds 50 KiB gzip.
