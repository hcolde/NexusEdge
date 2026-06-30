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

  it("recursively validates nested object schemas", async () => {
    const tool = new EdgeTool<
      { readonly cfg: { readonly mode: string } },
      { readonly mode: string }
    >({
      name: "configure",
      description: "configure tool",
      inputSchema: {
        type: "object",
        properties: {
          cfg: {
            type: "object",
            properties: {
              mode: { type: "string" }
            },
            required: ["mode"],
            additionalProperties: false
          }
        },
        required: ["cfg"],
        additionalProperties: false
      },
      execute(input) {
        return { mode: input.cfg.mode };
      }
    });
    const context = {
      requestId: "r",
      signal: new AbortController().signal,
      metadata: {}
    };

    await expect(
      tool.run({ cfg: { admin: true } } as never, context)
    ).rejects.toBeInstanceOf(NexusEdgeError);
    await expect(tool.run({ cfg: { mode: "safe" } }, context)).resolves.toEqual({
      mode: "safe"
    });
  });
});
