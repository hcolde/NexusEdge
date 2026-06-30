import { EdgeAgent, EdgeOrchestrator, OpenAICompatibleProvider } from "nexusedge";

export const runtime = "edge";

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new Response("Missing OPENAI_API_KEY", { status: 500 });
  }

  const provider = new OpenAICompatibleProvider({
    baseURL: "https://api.openai.com/v1",
    apiKey,
    model: "gpt-4o-mini"
  });

  const writer = new EdgeAgent({
    id: "writer",
    role: "Edge brief writer",
    goal: "Write a concise answer from the user task."
  });

  const orchestrator = new EdgeOrchestrator({ provider })
    .addAgent(writer)
    .setFlow({
      start: "writer",
      next: {
        writer: "END"
      }
    });

  const input = await request.text();
  const stream = await orchestrator.runAsStream(input || "Write a one-paragraph edge AI brief.");

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache"
    }
  });
}
