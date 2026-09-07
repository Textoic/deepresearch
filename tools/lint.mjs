import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const LIMITS = {
  complexity: 8,
  functionLines: 40,
  nestingDepth: 3,
  parameters: 4,
  fileLines: 220,
};

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const LINTED_DIRS = ["src", "test"];
const SKIPPED_DIRS = new Set(["node_modules", "dist", "runs", "reviews", ".git", "fixtures", ".pnpm-store"]);

export function collectFiles(root = ROOT, dirs = LINTED_DIRS) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (SKIPPED_DIRS.has(entry)) continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|mts|tsx)$/.test(entry)) out.push(full);
    }
  };
  for (const dir of dirs) walk(join(root, dir));
  return out.sort();
}

const DECISION_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CatchClause,
]);

const LOGICAL_OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

const NESTING_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.TryStatement,
]);

const FUNCTION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

function isDecision(node) {
  if (DECISION_KINDS.has(node.kind)) return true;
  if (ts.isCaseClause(node)) return true;
  if (ts.isBinaryExpression(node) && LOGICAL_OPERATORS.has(node.operatorToken.kind)) return true;
  return false;
}

function measure(fn) {
  let complexity = 1;
  let maxDepth = 0;
  const visit = (node, depth) => {
    if (node !== fn && FUNCTION_KINDS.has(node.kind)) return;
    if (isDecision(node)) complexity += 1;
    const next = NESTING_KINDS.has(node.kind) ? depth + 1 : depth;
    if (next > maxDepth) maxDepth = next;
    ts.forEachChild(node, (child) => visit(child, next));
  };
  ts.forEachChild(fn, (child) => visit(child, 0));
  return { complexity, maxDepth };
}

function functionName(fn, source) {
  if (fn.name) return fn.name.getText(source);
  const parent = fn.parent;
  if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) && parent.name) return parent.name.getText(source);
  if (ts.isConstructorDeclaration(fn)) return "constructor";
  return "<anonymous>";
}

function lineOf(source, pos) {
  return source.getLineAndCharacterOfPosition(pos).line + 1;
}

function commentViolations(source, text, file) {
  const found = [];
  const scanRanges = (ranges) => {
    for (const range of ranges ?? []) {
      if (range.pos === 0 && text.startsWith("#!")) continue;
      found.push({ file, line: lineOf(source, range.pos), rule: "no-comments", message: "Comments are banned; record rationale in architecture.md instead." });
    }
  };
  const visit = (node) => {
    scanRanges(ts.getLeadingCommentRanges(text, node.pos));
    scanRanges(ts.getTrailingCommentRanges(text, node.end));
    ts.forEachChild(node, visit);
  };
  visit(source);
  scanRanges(ts.getTrailingCommentRanges(text, source.end));
  const unique = new Map();
  for (const item of found) unique.set(item.line, item);
  return [...unique.values()];
}

function functionViolations(source, file) {
  const found = [];
  const visit = (node) => {
    if (FUNCTION_KINDS.has(node.kind) && node.body) {
      const name = functionName(node, source);
      const line = lineOf(source, node.getStart(source));
      const { complexity, maxDepth } = measure(node);
      const start = lineOf(source, node.getStart(source));
      const lines = lineOf(source, node.end) - start + 1;
      const at = { file, line };
      if (complexity > LIMITS.complexity) found.push({ ...at, rule: "max-complexity", message: `${name} has cyclomatic complexity ${complexity} (max ${LIMITS.complexity}); extract named helpers or a lookup table.` });
      if (lines > LIMITS.functionLines) found.push({ ...at, rule: "max-function-lines", message: `${name} spans ${lines} lines (max ${LIMITS.functionLines}); split it.` });
      if (maxDepth > LIMITS.nestingDepth) found.push({ ...at, rule: "max-nesting-depth", message: `${name} nests ${maxDepth} levels (max ${LIMITS.nestingDepth}); use early returns or helpers.` });
      if (node.parameters.length > LIMITS.parameters) found.push({ ...at, rule: "max-parameters", message: `${name} takes ${node.parameters.length} parameters (max ${LIMITS.parameters}); pass one options object.` });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function lintFile(file) {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const violations = [...commentViolations(source, text, file), ...functionViolations(source, file)];
  const lines = text.split("\n").length;
  if (lines > LIMITS.fileLines) violations.push({ file, line: 1, rule: "max-file-lines", message: `File has ${lines} lines (max ${LIMITS.fileLines}); split it by responsibility.` });
  return violations.sort((a, b) => a.line - b.line);
}

export function lint(files) {
  return files.flatMap(lintFile);
}

function isLinted(file) {
  const rel = relative(ROOT, file);
  if (rel.startsWith("..")) return false;
  const parts = rel.split(sep);
  if (!LINTED_DIRS.includes(parts[0])) return false;
  if (parts.some((part) => SKIPPED_DIRS.has(part))) return false;
  return /\.(ts|mts|tsx)$/.test(file);
}

function main(argv) {
  const explicit = argv.filter((arg) => !arg.startsWith("-")).map((arg) => resolve(arg));
  const targets = explicit.length ? explicit.filter(isLinted) : collectFiles();
  if (!targets.length) return 0;
  const violations = lint(targets);
  for (const violation of violations) {
    process.stderr.write(`${relative(ROOT, violation.file)}:${violation.line}  ${violation.rule}  ${violation.message}\n`);
  }
  if (violations.length) {
    process.stderr.write(`\n${violations.length} violation(s). Rules: tools/lint.mjs. Rationale belongs in architecture.md, never in code comments.\n`);
    return 1;
  }
  process.stdout.write(`lint: ${targets.length} file(s) clean\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]).endsWith(`tools${sep}lint.mjs`)) {
  process.exit(main(process.argv.slice(2)));
}
