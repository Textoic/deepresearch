import { readFile } from "node:fs/promises";
import type { ResearchRun } from "./types.ts";

export type EvaluationKind = "evergreen" | "temporal_live" | "resolved_temporal" | "adversarial";

export interface EvaluationCriterion {
  id: string;
  assertion: string;
  weight: number;
  requiredPhrases: string[];
  minSourceTier?: 1 | 2 | 3 | 4;
}

export interface EvaluationCase {
  id: string;
  kind: EvaluationKind;
  topic: string;
  asOf: string;
  budgetUsd: number;
  mustCover: EvaluationCriterion[];
  forbiddenPhrases?: string[];
  outcome?: { resolvedAt: string; value: string };
}

export interface CriterionResult {
  id: string;
  passed: boolean;
  score: number;
  reason: string;
}

export interface EvaluationResult {
  caseId: string;
  coverage: number;
  budgetCompliant: boolean;
  citationSignal: number;
  forbiddenContentFound: string[];
  score: number;
  criteria: CriterionResult[];
}

export async function loadEvaluationCases(path: string): Promise<EvaluationCase[]> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(value)) throw new Error("Evaluation file must contain a JSON array.");
  for (const testCase of value) validateEvaluationCase(testCase);
  return value as EvaluationCase[];
}

export function evaluateRun(run: ResearchRun, testCase: EvaluationCase): EvaluationResult {
  validateEvaluationCase(testCase);
  const report = run.reportMarkdown.toLocaleLowerCase();
  const totalWeight = testCase.mustCover.reduce((sum, criterion) => sum + criterion.weight, 0);
  const criteria = testCase.mustCover.map((criterion) => scoreCriterion(report, run, criterion));
  const coverage = totalWeight === 0 ? 0 : criteria.reduce((sum, result, index) => sum + result.score * testCase.mustCover[index]!.weight, 0) / totalWeight;
  const forbiddenContentFound = (testCase.forbiddenPhrases ?? []).filter((phrase) => report.includes(phrase.toLocaleLowerCase()));
  const budgetCompliant = run.ledger.spentUsd <= testCase.budgetUsd + 1e-9;
  const citationSignal = /\[[^\]]+\]\(https?:\/\//.test(run.reportMarkdown) ? 1 : 0;
  const score = run.stopReason !== "complete" || !report.trim() ? 0 : Math.max(0, coverage * 0.75 + citationSignal * 0.15 + (budgetCompliant ? 0.10 : 0) - forbiddenContentFound.length * 0.10);
  return { caseId: testCase.id, coverage, budgetCompliant, citationSignal, forbiddenContentFound, score, criteria };
}

function scoreCriterion(report: string, run: ResearchRun, criterion: EvaluationCriterion): CriterionResult {
  const phrases = criterion.requiredPhrases.map((phrase) => phrase.toLocaleLowerCase());
  const missing = phrases.filter((phrase) => !report.includes(phrase));
  const tierOk = criterion.minSourceTier === undefined || run.sources.some((source) => (source.sourceTier ?? 4) <= criterion.minSourceTier!);
  const passed = missing.length === 0 && tierOk;
  return { id: criterion.id, passed, score: passed ? 1 : 0, reason: missing.length ? `Missing required phrases: ${missing.join(", ")}` : tierOk ? "Covered" : `No evidence source at tier ${criterion.minSourceTier} or better` };
}

function isValidCriterion(criterion: EvaluationCriterion): boolean {
  if (!criterion.id || !Array.isArray(criterion.requiredPhrases)) return false;
  return Number.isFinite(criterion.weight) && criterion.weight > 0;
}

function hasRequiredCaseFields(testCase: Partial<EvaluationCase>): boolean {
  if (!testCase.id || !testCase.topic || !testCase.asOf) return false;
  return Number.isFinite(testCase.budgetUsd) && Array.isArray(testCase.mustCover);
}

function validateEvaluationCase(value: unknown): asserts value is EvaluationCase {
  if (!value || typeof value !== "object") throw new Error("Evaluation case must be an object.");
  const testCase = value as Partial<EvaluationCase>;
  if (!hasRequiredCaseFields(testCase)) throw new Error("Evaluation case requires id, topic, asOf, budgetUsd, and mustCover.");
  for (const criterion of testCase.mustCover!) {
    if (!isValidCriterion(criterion)) throw new Error(`Invalid criterion in evaluation case '${testCase.id}'.`);
  }
}
