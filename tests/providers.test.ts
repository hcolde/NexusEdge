import { describe, expect, it } from "vitest";
import { extractAnthropicDelta, extractOpenAIDelta, parseAnthropicComplete, parseOpenAIComplete, toAnthropicBody, toOpenAIMessages } from "../src";

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
});
