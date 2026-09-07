import { parseArgs } from "node:util";

export const USAGE = "Usage: budget-research market <slug> --provider ollama|openrouter --model <model> --budget <usd> [--ollama-url <url>] [--searxng-url <url>] [--eval-file <json> --eval-case <id>] [--as-of <date>] [--source <url>] [--query <query>] [--max-output-tokens <count>] [--replay-run <directory>] [--out <dir>]";

export function parseCliArgs(argv: string[]) {
  // pnpm/npm may forward a separator to the script itself.
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    help: { type: "boolean", short: "h" },
    provider: { type: "string" }, model: { type: "string" }, budget: { type: "string" },
    "ollama-url": { type: "string" }, "searxng-url": { type: "string" },
    "eval-file": { type: "string" }, "eval-case": { type: "string" },
    "as-of": { type: "string" }, "api-key": { type: "string" },
    source: { type: "string", multiple: true }, out: { type: "string" },
    query: { type: "string", multiple: true },
    "max-output-tokens": { type: "string" },
    "replay-run": { type: "string" },
  } });
  if (values.help) return { help: true as const };
  if (positionals.length !== 2 || positionals[0] !== "market") throw new Error(USAGE);
  if (values.provider !== "ollama" && values.provider !== "openrouter") throw new Error("--provider must be ollama or openrouter.");
  if (!values.model?.trim()) throw new Error("--model is required.");
  const budgetUsd = Number(values.budget);
  if (!values.budget?.trim() || !Number.isFinite(budgetUsd) || budgetUsd < 0) throw new Error("--budget must be a non-negative number.");
  const asOf = values["as-of"] ? new Date(values["as-of"]) : undefined;
  if (asOf && Number.isNaN(asOf.getTime())) throw new Error("--as-of must be a valid date.");
  if (values["eval-case"] && !values["eval-file"]) throw new Error("--eval-case requires --eval-file.");
  const maxOutputTokens = Number(values["max-output-tokens"] ?? 4096);
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 16384) throw new Error("--max-output-tokens must be between 1 and 16384.");
  return { help: false as const, slug: positionals[1], provider: values.provider, model: values.model,
    budgetUsd, asOf, ollamaUrl: values["ollama-url"], searxngUrl: values["searxng-url"],
    evalFile: values["eval-file"], evalCase: values["eval-case"], apiKey: values["api-key"],
    sources: values.source ?? [], queries: values.query, replayRun: values["replay-run"], maxOutputTokens, out: values.out ?? "runs" };
}
