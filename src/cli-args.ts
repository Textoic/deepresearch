import { parseArgs } from "node:util";

export const USAGE = "Usage: budget-research market <slug> --provider ollama|openrouter --model <model> --budget <usd> [--ollama-url <url>] [--searxng-url <url>] [--eval-file <json> --eval-case <id>] [--as-of <date>] [--source <url>] [--query <query>] [--max-output-tokens <count>] [--effort low|medium|high] [--evidence-policy disclose|strict] [--replay-run <directory>] [--out <dir>]";

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  provider: { type: "string" }, model: { type: "string" }, budget: { type: "string" },
  "ollama-url": { type: "string" }, "searxng-url": { type: "string" },
  "eval-file": { type: "string" }, "eval-case": { type: "string" },
  "as-of": { type: "string" }, "api-key": { type: "string" },
  source: { type: "string", multiple: true }, out: { type: "string" },
  query: { type: "string", multiple: true },
  effort: { type: "string" },
  "evidence-policy": { type: "string" },
  "max-output-tokens": { type: "string" },
  "replay-run": { type: "string" },
} as const;

const PROVIDERS = ["ollama", "openrouter"] as const;
const EFFORTS = ["low", "medium", "high"] as const;
const EVIDENCE_POLICIES = ["disclose", "strict"] as const;

function oneOf<T extends string>(allowed: readonly T[], value: string | undefined, fallback: T | undefined, error: string): T {
  const candidate = value ?? fallback;
  if (!allowed.includes(candidate as T)) throw new Error(error);
  return candidate as T;
}

function requireModel(value: string | undefined): string {
  if (!value?.trim()) throw new Error("--model is required.");
  return value;
}

function parseBudget(value: string | undefined): number {
  const budgetUsd = Number(value);
  if (!value?.trim() || !Number.isFinite(budgetUsd) || budgetUsd < 0) throw new Error("--budget must be a non-negative number.");
  return budgetUsd;
}

function parseAsOf(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const asOf = new Date(value);
  if (Number.isNaN(asOf.getTime())) throw new Error("--as-of must be a valid date.");
  return asOf;
}

function parseMaxOutputTokens(value: string | undefined): number {
  const maxOutputTokens = Number(value ?? 4096);
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 16384) throw new Error("--max-output-tokens must be between 1 and 16384.");
  return maxOutputTokens;
}

function requireMarketSlug(positionals: string[]): string {
  if (positionals.length !== 2 || positionals[0] !== "market") throw new Error(USAGE);
  return positionals[1]!;
}

function requireEvalPair(values: { "eval-file"?: string; "eval-case"?: string }): void {
  if (values["eval-case"] && !values["eval-file"]) throw new Error("--eval-case requires --eval-file.");
}

export function parseCliArgs(argv: string[]) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: OPTIONS });
  if (values.help) return { help: true as const };
  const slug = requireMarketSlug(positionals);
  requireEvalPair(values);
  return { help: false as const, slug,
    provider: oneOf(PROVIDERS, values.provider, undefined, "--provider must be ollama or openrouter."),
    model: requireModel(values.model),
    budgetUsd: parseBudget(values.budget),
    asOf: parseAsOf(values["as-of"]),
    effort: oneOf(EFFORTS, values.effort, "low", "--effort must be low, medium, or high."),
    evidencePolicy: oneOf(EVIDENCE_POLICIES, values["evidence-policy"], "disclose", "--evidence-policy must be disclose or strict."),
    maxOutputTokens: parseMaxOutputTokens(values["max-output-tokens"]),
    ollamaUrl: values["ollama-url"], searxngUrl: values["searxng-url"],
    evalFile: values["eval-file"], evalCase: values["eval-case"], apiKey: values["api-key"],
    sources: values.source ?? [], queries: values.query, replayRun: values["replay-run"],
    out: values.out ?? "runs" } as const;
}
