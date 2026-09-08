import { readFile } from "node:fs/promises";
import type { ResearchRun } from "./types.ts";

const SCORABLE_STOP_REASONS = new Set(["complete", "partial"]);
const PARTIAL_COVERAGE_PENALTY = 0.10;

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
  const score = scoreRun({ run, report, coverage, citationSignal, budgetCompliant, forbidden: forbiddenContentFound.length });
  return { caseId: testCase.id, coverage, budgetCompliant, citationSignal, forbiddenContentFound, score, criteria };
}

interface ScoreInputs { run: ResearchRun; report: string; coverage: number; citationSignal: number; budgetCompliant: boolean; forbidden: number; }

function scoreRun(inputs: ScoreInputs): number {
  const { run, coverage, citationSignal, budgetCompliant, forbidden } = inputs;
  if (!SCORABLE_STOP_REASONS.has(run.stopReason) || !inputs.report.trim()) return 0;
  const penalty = forbidden * 0.10 + (run.stopReason === "partial" ? PARTIAL_COVERAGE_PENALTY : 0);
  return Math.max(0, coverage * 0.75 + citationSignal * 0.15 + (budgetCompliant ? 0.10 : 0) - penalty);
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
