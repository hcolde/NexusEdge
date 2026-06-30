import { describe, expect, it } from "vitest";
import { EdgeTool, NexusEdgeError } from "../src";

describe("EdgeTool", () => {
  it("validates required input fields", async () => {
    const tool = new EdgeTool<{ readonly token: string }, string>({
      name: "price",
      description: "price tool",
      inputSchema: {
        type: "object",
        properties: {
          token: { type: "string" }
        },
        required: ["token"],
        additionalProperties: false
      },
      execute(input) {
        return input.token;
      }
    });

    await expect(
      tool.run({}, {
        requestId: "r",
        signal: new AbortController().signal,
        metadata: {}
      })
    ).rejects.toBeInstanceOf(NexusEdgeError);
  });
});
