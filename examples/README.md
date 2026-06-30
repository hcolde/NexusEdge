# NexusEdge examples

This directory contains minimal runtime smoke examples for:

- Cloudflare Workers
- Vercel Edge Runtime
- Deno Deploy
- Bun
- edge incident triage with a hidden collector agent and visible response writer

Each example returns a native `ReadableStream<Uint8Array>` encoded as Server-Sent Events.

The runtime library itself does not read environment variables. The examples read the API key from the host runtime and pass it into `OpenAICompatibleProvider` explicitly.

## Real workflow example

`edge-incident-triage/main.ts` demonstrates a practical maintainer workflow:

- fetch a bounded public status endpoint excerpt through a tool;
- keep collection output hidden from the user-facing stream;
- pass a compact artifact to a response-writing agent;
- return a native SSE response from an edge-compatible handler.

This pattern can be adapted for OSS maintainer automation such as release status summaries, dependency incident updates, service-health triage, and support queue drafting.
