import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src";

describe("estimateTokens", () => {
  it("estimates ascii text conservatively", () => {
    expect(estimateTokens("hello world")).toBeGreaterThan(1);
  });

  it("estimates CJK text with a higher density", () => {
    expect(estimateTokens("分析比特币价格走势")).toBeGreaterThanOrEqual(8);
  });
});
