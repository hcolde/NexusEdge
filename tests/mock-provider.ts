import type { LLMCompleteResult, LLMProvider, LLMRequest, LLMStreamEvent } from "../src";

export class QueueProvider implements LLMProvider {
  readonly name = "queue";
  private readonly responses: string[];

  constructor(responses: readonly string[]) {
    this.responses = [...responses];
  }

  async complete(_request: LLMRequest): Promise<LLMCompleteResult> {
    const text = this.responses.shift();
    if (text === undefined) {
      throw new Error("QueueProvider has no remaining responses.");
    }

    return {
      text,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15
      }
    };
  }

  async *stream(_request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    yield { type: "delta", text: "streamed" };
    yield { type: "done" };
  }
}
