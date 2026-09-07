import assert from "node:assert/strict";
import test from "node:test";
import { BudgetExceededError, BudgetGuard } from "../src/budget.ts";

test("budget guard blocks a reservation that crosses its hard cap", () => {
  const guard = new BudgetGuard(0.10);
  guard.reserve({ usd: 0.08, inputTokens: 1, outputTokens: 1, known: true });
  assert.throws(() => guard.reserve({ usd: 0.03, inputTokens: 1, outputTokens: 1, known: true }), BudgetExceededError);
});
