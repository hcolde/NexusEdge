import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  extractAnthropicDelta,
  extractOpenAIDelta,
  NexusEdgeError,
  OpenAICompatibleProvider,
  parseAnthropicComplete,
  parseOpenAIComplete,
  toAnthropicBody,
  toOpenAIMessages
} from "../src";

describe("providers", () => {
  it("parses OpenAI-compatible complete responses", () => {
    const result = parseOpenAIComplete({
      choices: [
        {
          message: {
            content: "hello"
          }
        }
      ],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5
      }
    });

    expect(result.text).toBe("hello");
    expect(result.usage?.totalTokens).toBe(5);
  });

  it("extracts OpenAI-compatible stream deltas", () => {
    expect(
      extractOpenAIDelta({
        choices: [
          {
            delta: {
              content: "hi"
            }
          }
        ]
      })
    ).toBe("hi");
  });

  it("maps NexusEdge messages to OpenAI-compatible messages", () => {
    const messages = toOpenAIMessages([
      { role: "system", content: "s" },
      { role: "tool", name: "lookup", content: "42" }
    ]);

    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.role).toBe("user");
  });

  it("redacts OpenAI-compatible provider error bodies", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("SECRET_PROVIDER_BODY", { status: 400 })) as typeof fetch;
    const provider = new OpenAICompatibleProvider({
      baseURL: "https://provider.example",
      apiKey: "test-key",
      model: "test-model"
    });

    try {
      await provider.complete({ messages: [] });
      throw new Error("Expected provider request to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(NexusEdgeError);
      const details = (error as NexusEdgeError).details;
      expect(details).toEqual({ status: 400 });
      expect(JSON.stringify(details)).not.toContain("SECRET_PROVIDER_BODY");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("parses OpenAI-compatible complete HTTP responses through bounded JSON parsing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: "hello"
          }
        }
      ]
    }))) as typeof fetch;
    const provider = new OpenAICompatibleProvider({
      baseURL: "https://provider.example",
      apiKey: "test-key",
      model: "test-model"
    });

    try {
      const result = await provider.complete({ messages: [] });
      expect(result.text).toBe("hello");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects oversized OpenAI-compatible complete HTTP responses", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: "x".repeat(1024 * 1024)
          }
        }
      ]
    }))) as typeof fetch;
    const provider = new OpenAICompatibleProvider({
      baseURL: "https://provider.example",
      apiKey: "test-key",
      model: "test-model"
    });

    try {
      await expect(provider.complete({ messages: [] })).rejects.toMatchObject({
        code: "PROVIDER_PARSE_ERROR"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("parses Anthropic complete responses", () => {
    const result = parseAnthropicComplete({
      content: [
        {
          type: "text",
          text: "hello"
        }
      ],
      usage: {
        input_tokens: 4,
        output_tokens: 2
      }
    });

    expect(result.text).toBe("hello");
    expect(result.usage?.totalTokens).toBe(6);
  });

  it("extracts Anthropic deltas", () => {
    expect(
      extractAnthropicDelta({
        type: "content_block_delta",
        delta: {
          text: "hi"
        }
      })
    ).toBe("hi");
  });

  it("maps NexusEdge messages to Anthropic request bodies", () => {
    const body = toAnthropicBody(
      {
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "task" },
          { role: "tool", name: "lookup", content: "42" }
        ],
        maxTokens: 100
      },
      false,
      "claude-test"
    );

    expect(body.system).toBe("system");
    expect(body.messages.length).toBe(2);
  });

  it("redacts Anthropic provider error bodies", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("SECRET_PROVIDER_BODY", { status: 400 })) as typeof fetch;
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "test-model"
    });

    try {
      await provider.complete({ messages: [] });
      throw new Error("Expected provider request to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(NexusEdgeError);
      const details = (error as NexusEdgeError).details;
      expect(details).toEqual({ status: 400 });
      expect(JSON.stringify(details)).not.toContain("SECRET_PROVIDER_BODY");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("parses Anthropic complete HTTP responses through bounded JSON parsing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      content: [
        {
          type: "text",
          text: "hello"
        }
      ]
    }))) as typeof fetch;
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "test-model"
    });

    try {
      const result = await provider.complete({ messages: [] });
      expect(result.text).toBe("hello");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects oversized Anthropic complete HTTP responses", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      content: [
        {
          type: "text",
          text: "x".repeat(1024 * 1024)
        }
      ]
    }))) as typeof fetch;
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      model: "test-model"
    });

    try {
      await expect(provider.complete({ messages: [] })).rejects.toMatchObject({
        code: "PROVIDER_PARSE_ERROR"
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
