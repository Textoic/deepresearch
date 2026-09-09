import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCliArgs } from "../src/cli-args.ts";

const slug = "which-company-has-the-best-ai-model-end-of-september-20260717143435868";
const argv = ["market", slug, "--provider", "ollama", "--model", "qwen3.8:27b", "--budget", "0", "--searxng-url", "http://127.0.0.1:8080", "--eval-file", "test/fixtures/arena-september-2026.json", "--eval-case", "pm-arena-text-overall-sept-2026-v1"];

test("user command parses identically with or without pnpm's separator", () => {
  const direct = parseCliArgs(argv);
  assert.deepEqual(parseCliArgs(["--", ...argv]), direct);
  assert.equal(direct.searxngUrl, "http://127.0.0.1:8080");
  assert.equal(direct.evalFile, "test/fixtures/arena-september-2026.json");
  assert.equal(direct.evalCase, "pm-arena-text-overall-sept-2026-v1");
  assert.equal(direct.budgetUsd, 0);
});

test("CLI rejects missing flag values and spelling mistakes", () => {
  assert.throws(() => parseCliArgs([...argv, "--out"]));
  assert.throws(() => parseCliArgs([...argv, "--searxng-urll", "http://localhost"]));
});

test("compiled CLI retrieves evidence, passes requirements to Ollama and evaluates the saved run", async () => {
  const output = await mkdtemp(join(tmpdir(), "research-cli-test-"));
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [
      "--import", new URL("./fixtures/cli-fetch.mjs", import.meta.url).href,
      "dist/cli.js", "--", ...argv, "--out", output, "--clarification-file", "test/fixtures/resolution-clarifications.json",
    ], { cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 15000 });
    assert.match(stdout, /Fixture report/);
    assert.match(stderr, /evaluation=.*pm-arena-text-overall-sept-2026-v1/);
    const [id] = await readdir(output);
    const run = JSON.parse(await readFile(join(output, id, "run.json"), "utf8"));
    assert.equal(run.stopReason, "complete");
    assert.equal(run.sources.length, 1);
    assert.equal(run.ledger.calls[0].model, "qwen3.8:27b");
    assert.equal(run.ledger.spentUsd, 0);
    assert.match(run.event.clarification, /Temporary legal measures/);
    assert.match(JSON.stringify(run.promptMessages), /Temporary legal measures/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
