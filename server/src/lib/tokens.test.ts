import { describe, expect, it } from "vitest";
import { estimateMessagesTokens, truncateMessagesToTokenBudget } from "./tokens.js";

describe("token helpers", () => {
  it("estimates message tokens deterministically", () => {
    const tokens = estimateMessagesTokens([{ role: "user", content: "hello world" }]);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBe(estimateMessagesTokens([{ role: "user", content: "hello world" }]));
  });

  it("truncates oldest content to fit a token budget", () => {
    const truncated = truncateMessagesToTokenBudget([
      { role: "system", content: "system instructions" },
      { role: "user", content: "a".repeat(200) }
    ], 10);

    expect(truncated.length).toBe(1);
    expect(truncated[0].role).toBe("user");
    expect(truncated[0].content.length).toBeLessThan(200);
  });
});
