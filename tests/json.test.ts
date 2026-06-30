import { describe, expect, it } from "vitest";
import { safeJsonParse } from "../src";

describe("json utilities", () => {
  it("rejects JSON that exceeds the configured maximum depth", () => {
    expect(safeJsonParse(nestedJson(3), { maxDepth: 1 })).toMatchObject({
      ok: false,
      code: "JSON_LIMIT"
    });
  });

  it("accepts JSON within the configured maximum depth", () => {
    expect(safeJsonParse(nestedJson(1), { maxDepth: 1 })).toMatchObject({
      ok: true
    });
  });
});

function nestedJson(depth: number): string {
  let value: unknown = true;
  for (let index = 0; index < depth; index += 1) {
    value = { child: value };
  }

  return JSON.stringify(value);
}
