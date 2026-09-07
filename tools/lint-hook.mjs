import { lint } from "./lint.mjs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const LINTABLE = /\.(ts|mts|tsx)$/;

function readStdin() {
  return new Promise((done) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => done(raw));
    process.stdin.on("error", () => done(""));
  });
}

function pathsFrom(payload) {
  const input = payload?.tool_input ?? {};
  const candidates = [input.file_path, input.notebook_path, ...(input.file_paths ?? []), ...(input.edits ?? []).map((edit) => edit.file_path)];
  return [...new Set(candidates.filter((value) => typeof value === "string" && LINTABLE.test(value)))].map((value) => resolve(value)).filter(existsSync);
}

function parse(raw) {
  try { return JSON.parse(raw); } catch { return undefined; }
}

const files = pathsFrom(parse(await readStdin()));
if (!files.length) process.exit(0);

const violations = lint(files);
if (!violations.length) process.exit(0);

const lines = violations.map((violation) => `${violation.file}:${violation.line}  ${violation.rule}  ${violation.message}`);
process.stderr.write(`Lint failed (see AGENTS.md). Fix these now, in this turn:\n${lines.join("\n")}\n`);
process.exit(2);
