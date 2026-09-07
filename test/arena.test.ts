import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compareBoardDate, extractArenaSnapshot, renderArenaSnapshot, parseEnglishDate } from "../src/arena.ts";
import { buildArenaEvidenceBrief } from "../src/evidence-brief.ts";
import { PolymarketClient, ResearchClient } from "../src/index.ts";
import type { SourceDocument, InferenceProvider } from "../src/types.ts";

const fixture = JSON.parse(await readFile(new URL("./fixtures/arena-sept2-text.json", import.meta.url), "utf8")) as SourceDocument;

test("frozen Arena table preserves 20 rows, rank range, score uncertainty and explicit labels", () => {
  const snapshot = extractArenaSnapshot(fixture);
  assert.equal(snapshot.status, "valid", snapshot.issues.join(" "));
  assert.equal(snapshot.dataDate, "2026-09-02");
  assert.equal(snapshot.retrievedAt, fixture.retrievedAt);
  assert.equal(snapshot.rows.length, 20);
  assert.equal(snapshot.completeBoard, false);
  const first = snapshot.rows[0]!;
  assert.deepEqual([first.model, first.provider, first.score, first.scoreUncertainty, first.rankLow, first.rankHigh, first.votes, first.preliminary], ["claude-fable-5.1-max", "Anthropic", 1514, 11, 1, 5, 2906, false]);
  assert.equal(snapshot.rows[5]?.preliminary, true);
  assert.equal(snapshot.rows[7]?.preliminary, true);
  assert.equal(snapshot.rows[9]?.model, "muse-spark-1.2 (xHigh)");
  assert.equal(snapshot.rows[18]?.provider, "Moonshot");
  assert.equal(snapshot.rows[19]?.votes, 3710);
  assert.match(renderArenaSnapshot(snapshot), /1514 \| ±11 \| 1–5 \| 2,906 \| Not marked/);
});

test("Arena parser withholds ambiguous, truncated, undated, snippet and wrong-category tables", () => {
  for (const source of [
    { ...fixture, text: fixture.text.replace("Rank Rank Spread", "Rank Confidence") },
    { ...fixture, text: fixture.text.replace("Sep 2, 2026", "Unknown date") },
    { ...fixture, text: fixture.text.replace("±11", "uncertain") },
    { ...fixture, text: fixture.text.replace("2,906", "2,90") },
    { ...fixture, text: fixture.text.slice(0, -80) },
    { ...fixture, text: fixture.text.replace("20 9 33", "21 9 33") },
    { ...fixture, text: fixture.text.replace("Anthropic ·", "Unknown Lab ·") },
    { ...fixture, retrievalKind: "snippet" as const },
    { ...fixture, url: "https://arena.ai/leaderboard/code" },
    { ...fixture, url: "https://arena.ai/leaderboard/text/overall-no-style-control?category=coding" },
  ]) {
    const result = extractArenaSnapshot(source);
    assert.equal(result.status, "invalid");
    assert.equal(result.rows.length, 0);
    assert.doesNotMatch(renderArenaSnapshot(result), /\| 1 \|/);
  }
});

test("date-only comparisons distinguish before, after, same day, missing and invalid dates", () => {
  assert.equal(compareBoardDate("2026-09-02", "2026-09-03"), "before");
  assert.equal(compareBoardDate("2026-09-02", "2026-08-12"), "after");
  assert.equal(compareBoardDate("2026-09-02", "2026-09-02"), "same_day");
  assert.equal(compareBoardDate(undefined, "2026-09-03"), "unknown");
  assert.equal(compareBoardDate("2026-02-30", "2026-09-03"), "unknown");
  assert.equal(parseEnglishDate("Feb 30, 2026"), undefined);
  assert.equal(parseEnglishDate("Sep 02, 2026"), "2026-09-02");
});

const launch: SourceDocument = { url: "https://openai.com/index/nova", retrievalKind: "page", retrievedAt: "2026-09-06T00:00:00Z", text: "Navigation ".repeat(500) + "Published September 3, 2026 " + "Contents ".repeat(500) + "Today, we are releasing GPT-Nova. Access is limited initially. This is not evidence of Arena performance." };

test("per-lab packet preserves verbatim launch and date evidence beyond navigation and flags stale board", () => {
  const brief = buildArenaEvidenceBrief([fixture, launch], extractArenaSnapshot(fixture), "2026-09-06T00:00:00Z");
  assert.equal(brief.labs.length, 4);
  const document = brief.labs.find(l => l.lab === "OpenAI")?.documents[0]!;
  assert.equal(document.sourceNumber, 2);
  assert.equal(document.documentDate, "2026-09-03");
  assert.equal(document.boardRelation, "before");
  assert.match(document.passages[0]!.text, /releasing GPT-Nova.*limited initially/);
  for (const p of [...document.passages, document.datePassage!]) assert.equal(launch.text.slice(p.start, p.end), p.text);
  assert.ok(brief.labs.find(l => l.lab === "Google")?.gaps.some(g => g.includes("No primary-page")));
});

test("announcement date is not a roundup month and snippets do not verify a launch", () => {
  const google: SourceDocument = { ...launch, url: "https://blog.google/models/next", text: "August roundup navigation. Sep 02, 2026 Introducing Gemini Next. Today we're introducing Gemini Next. It is available today in a limited preview." };
  const snippet = { ...launch, url: "https://x.ai/news/grok-next", retrievalKind: "snippet" as const, text: "Grok next release expected soon." };
  const brief = buildArenaEvidenceBrief([google, snippet, { ...launch, url: "https://openai.com.evil.test/launch" }], extractArenaSnapshot(fixture), "2026-09-06T00:00:00Z");
  assert.equal(brief.labs.find(l => l.lab === "Google")?.documents[0]?.documentDate, "2026-09-02");
  assert.equal(brief.labs.find(l => l.lab === "Google")?.documents[0]?.boardRelation, "same_day");
  assert.equal(brief.labs.find(l => l.lab === "OpenAI")?.documents.length, 0);
  assert.ok(brief.labs.find(l => l.lab.startsWith("xAI"))?.gaps.some(g => g.includes("snippets alone")));
});

test("future-dated announcements are omitted from the cutoff packet", () => {
  const brief = buildArenaEvidenceBrief([{ ...launch, text: launch.text.replace("September 3", "September 7") }], extractArenaSnapshot(fixture), "2026-09-06T00:00:00Z");
  assert.equal(brief.labs.find(l => l.lab === "OpenAI")?.documents.length, 0);
});

test("Arena report uses deterministic table while retaining original narrative and failure status", async () => {
  const provider: InferenceProvider = { kind: "custom", model: "fixture", async estimateCost() { return { usd: 0, inputTokens: 1, outputTokens: 1, known: true }; }, async complete(request) {
    assert.match(request.messages[1]!.content, /NARRATIVE ONLY/);
    assert.match(request.messages[1]!.content, /boardRelation.*before/s);
    return { content: "Draft narrative", model: "fixture", provider: "custom", finishReason: "length", usage: { inputTokens: 1, outputTokens: 100 } };
  } };
  const polymarket = new PolymarketClient(async () => new Response(JSON.stringify([{ id: "1", slug: "arena", title: "Arena test", resolutionSource: fixture.url }])));
  const run = await new ResearchClient({ provider, polymarket }).researchMarket({ slug: "arena", budgetUsd: 0, asOf: new Date("2026-09-06T00:00:00Z"), sources: [fixture, launch] });
  assert.equal(run.stopReason, "output_truncated");
  assert.equal(run.narrativeMarkdown, "Draft narrative");
  assert.match(run.reportMarkdown, /1514 \| ±11 \| 1–5/);
  assert.match(run.reportMarkdown, /board predates this document/);
  assert.equal(run.arenaEvidence?.snapshot.status, "valid");
});

test("board rows newer than the research cutoff cannot enter the prompt or report", async () => {
  const provider: InferenceProvider = { kind: "custom", model: "fixture", async estimateCost() { return { usd: 0, inputTokens: 1, outputTokens: 1, known: true }; }, async complete(request) {
    assert.doesNotMatch(request.messages.map(m => m.content).join("\n"), /1514/);
    return { content: "No eligible table available.", model: "fixture", provider: "custom", usage: { inputTokens: 1, outputTokens: 1 } };
  } };
  const polymarket = new PolymarketClient(async () => new Response(JSON.stringify([{ id: "1", slug: "arena", title: "Arena test", resolutionSource: fixture.url }])));
  const run = await new ResearchClient({ provider, polymarket }).researchMarket({ slug: "arena", budgetUsd: 0, asOf: new Date("2026-09-01T00:00:00Z"), sources: [fixture] });
  assert.equal(run.arenaEvidence?.snapshot.status, "invalid");
  assert.equal(run.arenaEvidence?.snapshot.rows.length, 0);
  assert.doesNotMatch(run.reportMarkdown, /1514/);
});
