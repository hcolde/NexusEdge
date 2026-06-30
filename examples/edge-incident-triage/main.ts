import {
  EdgeAgent,
  EdgeOrchestrator,
  EdgeTool,
  OpenAICompatibleProvider,
  isJsonObject
} from "nexusedge";

interface Env {
  readonly OPENAI_API_KEY: string;
}

const fetchStatusTool = new EdgeTool<
  { readonly url: string },
  { readonly ok: boolean; readonly status: number; readonly excerpt: string }
>({
  name: "fetchStatus",
  description: "Fetch a public status or health endpoint and return a bounded text excerpt.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "HTTPS URL for a public status or health endpoint."
      }
    },
    required: ["url"],
    additionalProperties: false
  },
  async execute(input, context) {
    const url = new URL(input.url);
    if (url.protocol !== "https:") {
      throw new Error("Only HTTPS status endpoints are allowed.");
    }

    const response = await fetch(url, { signal: context.signal });
    const text = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      excerpt: text.slice(0, 1200)
    };
  }
});

const collector = new EdgeAgent({
  id: "collector",
  role: "Incident signal collector",
  goal: "Fetch the target service status and produce a compact incident artifact.",
  tools: [fetchStatusTool],
  visibleOutput: false
});

const responder = new EdgeAgent({
  id: "responder",
  role: "Incident response writer",
  goal: "Turn incident artifacts into a concise customer-facing update.",
  visibleOutput: true
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const provider = new OpenAICompatibleProvider({
      baseURL: "https://api.openai.com/v1",
      apiKey: env.OPENAI_API_KEY,
      model: "gpt-4o-mini"
    });

    const payload: unknown = await request.json().catch(() => undefined);
    const url = isJsonObject(payload) && typeof payload.url === "string"
      ? payload.url
      : "https://www.githubstatus.com/api/v2/status.json";

    const orchestrator = new EdgeOrchestrator({
      provider,
      maxSteps: 5,
      maxMemoryTokens: 3000
    })
      .addAgent(collector)
      .addAgent(responder)
      .setFlow({
        start: "collector",
        mode: "dag",
        next: {
          collector: "responder",
          responder: "END"
        }
      });

    const stream = await orchestrator.runAsStream(
      `Check this public status endpoint and draft an incident update: ${url}`
    );

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache"
      }
    });
  }
};
