# NexusEdge examples

This directory contains minimal runtime smoke examples for:

- Cloudflare Workers
- Vercel Edge Runtime
- Deno Deploy
- Bun

Each example returns a native `ReadableStream<Uint8Array>` encoded as Server-Sent Events.

The runtime library itself does not read environment variables. The examples read the API key from the host runtime and pass it into `OpenAICompatibleProvider` explicitly.
