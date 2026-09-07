import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateRun, loadEvaluationCases } from "../src/eval.ts";
import type { ResearchRun } from "../src/types.ts";

const run: ResearchRun = {
  id: "run", topic: "Example", asOf: "2026-09-06T00:00:00Z", createdAt: "2026-09-06T00:00:00Z", stopReason: "complete",
  reportMarkdown: "## Resolution rules\n[Official](https://example.test)\n## Unknowns", sources: [{ url: "https://example.test", text: "x", retrievedAt: "2026-09-06T00:00:00Z", sourceTier: 1 }],
  ledger: { hardCapUsd: 1, spentUsd: 0.5, reservedUsd: 0, calls: [], startedAt: "2026-09-06T00:00:00Z" }, limitations: [],
};

test("empty reports do not earn points for zero spend", async () => {
  const [testCase] = await loadEvaluationCases(fileURLToPath(new URL("./fixtures/eval-cases.json", import.meta.url)));
  assert.equal(evaluateRun({ ...run, reportMarkdown: "", stopReason: "empty_response" }, testCase).score, 0);
});

test("evaluation scores weighted coverage and budget compliance", async () => {
  const [testCase] = await loadEvaluationCases(fileURLToPath(new URL("./fixtures/eval-cases.json", import.meta.url)));
  assert.ok(testCase);
  const result = evaluateRun(run, testCase);
  assert.equal(result.coverage, 1); assert.equal(result.budgetCompliant, true); assert.equal(result.score, 1);
});

test("Arena September temporal rubric is valid and retains its high-weight gates", async () => {
  const cases = await loadEvaluationCases(fileURLToPath(new URL("./fixtures/arena-september-2026.json", import.meta.url)));
  assert.equal(cases.length, 1);
  assert.equal(cases[0]?.mustCover.find((criterion) => criterion.id === "entry-lag")?.weight, 12);
});
