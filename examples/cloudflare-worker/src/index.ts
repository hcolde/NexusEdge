import { EdgeAgent, EdgeOrchestrator, OpenAICompatibleProvider } from "nexusedge";

interface Env {
  readonly OPENAI_API_KEY: string;
}

function createOrchestrator(apiKey: string): EdgeOrchestrator<"writer"> {
  const provider = new OpenAICompatibleProvider({
    baseURL: "https://api.openai.com/v1",
    apiKey,
    model: "gpt-4o-mini"
  });

  const writer = new EdgeAgent({
    id: "writer",
    role: "Edge brief writer",
    goal: "Write a concise answer from the user task.",
    maxOutputTokens: 500
  });

  return new EdgeOrchestrator({
    provider,
    maxMemoryTokens: 3000,
    maxSteps: 3
  })
    .addAgent(writer)
    .setFlow({
      start: "writer",
      next: {
        writer: "END"
      }
    });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const input = await request.text();
    const orchestrator = createOrchestrator(env.OPENAI_API_KEY);
    const stream = await orchestrator.runAsStream(input || "Write a one-paragraph edge AI brief.");

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache"
      }
    });
  }
};
