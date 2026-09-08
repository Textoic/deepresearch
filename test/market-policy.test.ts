import assert from "node:assert/strict";
import test from "node:test";
import { PolymarketClient, ResearchClient } from "../src/index.ts";
import { evidenceForWriter, normalizeMarketEvent } from "../src/market-policy.ts";
import { initialUnits } from "../src/market-units.ts";
import type { ChatRequest, InferenceProvider, PolymarketEvent } from "../src/types.ts";

const event: PolymarketEvent = { id: "e", slug: "next-person", title: "Who will Trump pick as the next Press Secretary?", negRisk: true,
  description: 'Resolves to the next announced person. The primary resolution source is official White House information.', resolutionSource: "", raw: {},
  markets: [
    { id: "1", groupItemTitle: "Alice Example", question: "Will Alice Example be the next Press Secretary?", active: true, outcomePrices: '["0.237891","0.762109"]' },
    { id: "2", groupItemTitle: "Bob Example", question: "Will Bob Example be the next Press Secretary?", active: true },
    { id: "3", groupItemTitle: "Inactive Person", active: false },
    { id: "4", groupItemTitle: "Closed Person", closed: true },
    { id: "5", groupItemTitle: "Archived Person", archived: true },
  ] };

function provider(): InferenceProvider {
  return { kind: "custom", model: "fake", async estimateCost() { return { usd: 0.01, inputTokens: 10, outputTokens: 10, known: true }; },
    async complete(request: ChatRequest) { return { content: request.messages.some(m => m.content.includes('Return JSON only')) ? '{"units":[]}' : 'Evidence dossier without target odds.', usage: { inputTokens: 10, outputTokens: 10 }, model: "fake", provider: "custom", costUsd: 0.01, finishReason: "stop" }; } };
}

test("prose authorities enable research; flagged records never enter normalized roster", () => {
  const normalized = normalizeMarketEvent(event);
  assert.match(normalized.resolutionSource!, /official White House/);
  assert.deepEqual(normalized.markets?.map(m => m.id), ["1", "2"]);
  assert.equal(event.markets?.length, 5);
  assert.equal(initialUnits(normalized).length, 2);
});

test("target forecasts are withheld while underlying state race probabilities survive", () => {
  const senate = { ...event, title: "Which party will win the Senate in 2026?" };
  const source = { url: "https://example.test/forecasts", retrievedAt: "2026-09-01", text: "Democrats have a 62% chance of Senate control. Texas Senate race: Democrat win probability 51%. Ohio Senate race: Democrat win probability 56%." };
  const filtered = evidenceForWriter(source, senate);
  assert.doesNotMatch(filtered.text, /62%/);
  assert.match(filtered.text, /51%/); assert.match(filtered.text, /56%/);
  assert.equal(initialUnits(senate).length, 35);
  assert.ok(initialUnits(senate).some(u => u.name.includes("Ohio special")));
});

test("high effort separately researches every eligible candidate, stores stages, and replays without retrieval", async () => {
  const queries: string[] = [];
  const found = { url: "https://www.axios.com/press-office", text: "Reporting on the press office succession.", retrievedAt: "2026-09-01T00:00:00Z" };
  const client = new ResearchClient({ provider: provider(), polymarket: new PolymarketClient(async () => new Response(JSON.stringify([event]))), searchProvider: { async search(q) { queries.push(q); return [found]; } } });
  const run = await client.researchMarket({ slug: event.slug, budgetUsd: 1, effort: "high" });
  assert.equal(run.stopReason, "complete");
  assert.equal(run.decomposition?.dossiers.filter(d => d.unit.kind === "candidate").length, 2);
  assert.ok(queries.some(q => q.includes('"Alice Example"')));
  assert.ok(queries.some(q => q.includes('"Bob Example"')));
  const allPrompts = JSON.stringify([run.promptMessages, run.decomposition?.dossiers.map(d => d.promptMessages)]);
  assert.doesNotMatch(allPrompts, /0\.237891|outcomePrices|Inactive Person|Closed Person|Archived Person/);
  assert.match(allPrompts, /DEPENDENCY EXCEPTION/);
  assert.equal(run.ledger.calls.length, 5);
  const count = queries.length;
  const replay = await client.rewriteRun(run, { slug: event.slug, budgetUsd: 1, effort: "high" });
  assert.equal(queries.length, count);
  assert.deepEqual(replay.decomposition, run.decomposition);
  assert.equal(replay.ledger.calls.length, 1);
});

test("market directory navigation cannot leak overall odds into a state dossier", () => {
  const target = { ...event, title: "Which party will win the Senate in 2026?" };
  const filtered = evidenceForWriter({ url: "https://polymarket.com/politics/senate-elections", retrievedAt: "2026-09-07", text: "Which party will win the Senate in 2026? Democrats 52%. Ohio margin: Yes 54%." }, target);
  assert.doesNotMatch(filtered.text, /52%|54%/);
});

test("component generation respects the shared budget and reports incomplete work", async () => {
  const run = await new ResearchClient({ provider: provider(), polymarket: new PolymarketClient(async () => new Response(JSON.stringify([event]))) }).researchMarket({ slug: event.slug, budgetUsd: 0.015, effort: "high" });
  assert.notEqual(run.stopReason, "complete");
  assert.equal(run.ledger.spentUsd, 0.01);
  assert.ok(run.decomposition?.dossiers.some(d => d.status === "budget_exhausted"));
});

test("expanded-evidence audit adds and researches unlisted people but rejects excluded names", async () => {
  const p = provider();
  const baseComplete = p.complete;
  p.complete = async request => request.messages.some(m => m.content.includes("Final unlisted-candidate audit"))
    ? { content: '{"units":[{"name":"Charlie Example","question":"Named in consideration by Source 1"},{"name":"Inactive Person","question":"Also named by Source 1"}]}', model: "fake", provider: "custom", costUsd: 0.01, usage: { inputTokens: 10, outputTokens: 10 }, finishReason: "stop" }
    : baseComplete(request);
  const queries: string[] = [];
  const run = await new ResearchClient({ provider: p, polymarket: new PolymarketClient(async () => new Response(JSON.stringify([{ ...event, raw: undefined }]))), searchProvider: { async search(query) {
    queries.push(query);
    return [{ url: "https://example.test/news", title: "Next press secretary contenders", text: "Charlie Example is reported to be under consideration.", retrievedAt: "2026-09-01", retrievalKind: "page" }];
  } } }).researchMarket({ slug: event.slug, budgetUsd: 1, effort: "high" });
  assert.ok(run.decomposition?.dossiers.some(d => d.unit.name === "Charlie Example" && d.unit.kind === "unlisted_candidate"));
  assert.ok(queries.some(q => q.includes('"Charlie Example"')));
  assert.ok(!run.decomposition?.units.some(u => u.name === "Inactive Person"));
});

test("a truncated dossier gets one budgeted retry with a larger output allowance", async () => {
  const p = provider();
  const baseComplete = p.complete;
  const limits: number[] = [];
  p.complete = async request => {
    if (request.messages.some(m => m.content.includes("UNIT: Alice Example"))) {
      limits.push(request.maxOutputTokens);
      if (request.maxOutputTokens === 1600) return { content: "Partial", model: "fake", provider: "custom", costUsd: 0.01, usage: { inputTokens: 10, outputTokens: 1600 }, finishReason: "length" };
    }
    return baseComplete(request);
  };
  const run = await new ResearchClient({ provider: p, polymarket: new PolymarketClient(async () => new Response(JSON.stringify([event]))) }).researchMarket({ slug: event.slug, budgetUsd: 1, effort: "high" });
  assert.deepEqual(limits, [1600, 2400]);
  assert.equal(run.stopReason, "complete");
  assert.equal(run.ledger.calls.length, 6);
  assert.ok(Math.abs(run.ledger.spentUsd - 0.06) < 1e-9);
});

function truncating(unit: string, times: number): InferenceProvider {
  const p = provider();
  const base = p.complete;
  let seen = 0;
  p.complete = async request => {
    if (request.messages.some(m => m.content.includes(`UNIT: ${unit}`)) && seen++ < times) {
      return { content: `Partial dossier for ${unit} citing [Source 1](https://example.test/a)`, model: "fake", provider: "custom", costUsd: 0.01, usage: { inputTokens: 10, outputTokens: request.maxOutputTokens }, finishReason: "length" };
    }
    return base(request);
  };
  return p;
}

async function runWith(p: InferenceProvider) {
  return new ResearchClient({ provider: p, polymarket: new PolymarketClient(async () => new Response(JSON.stringify([event]))) }).researchMarket({ slug: event.slug, budgetUsd: 1, effort: "high" });
}

test("a dossier truncated past its retry keeps its researched text and downgrades the run to partial", async () => {
  const run = await runWith(truncating("Alice Example", 2));
  assert.equal(run.stopReason, "partial");
  const alice = run.decomposition?.dossiers.find(d => d.unit.name === "Alice Example");
  assert.equal(alice?.status, "output_truncated");
  assert.match(alice!.reportMarkdown, /Partial dossier for Alice Example/);
  assert.match(alice!.reportMarkdown, /Coverage of this subject stops here/);
  assert.doesNotMatch(alice!.reportMarkdown, /Research incomplete/);
  assert.equal(run.decomposition?.dossiers.find(d => d.unit.name === "Bob Example")?.status, "complete");
});

test("an internal length limit reaches the operator but never the writer's disclosed limitations", async () => {
  const run = await runWith(truncating("Alice Example", 2));
  assert.ok(run.limitations.some(l => l.startsWith("Operational: ") && l.includes("Alice Example")));
  const disclosed = run.promptMessages![1]!.content.split("Retrieval limitations (disclose relevant gaps):")[1]!;
  assert.doesNotMatch(disclosed, /Operational:|Alice Example|length limit/i);
  const userMessage = run.promptMessages![1]!.content;
  assert.doesNotMatch(userMessage, /output_truncated/);
  assert.match(userMessage, /Alice Example \(candidate; partial coverage\)/);
});

test("a failed dossier still fails the run, so truncation is not a licence for a broken unit", async () => {
  const p = provider();
  const base = p.complete;
  p.complete = async request => {
    if (request.messages.some(m => m.content.includes("UNIT: Alice Example"))) throw new Error("provider exploded");
    return base(request);
  };
  const run = await runWith(p);
  assert.equal(run.stopReason, "error");
});

test("the writer is given the best-provenance sources with their global citation numbers intact", async () => {
  const sources = [
    { url: "https://patriot.university/one", text: "farm rewrite one", retrievedAt: "2026-09-01T00:00:00Z" },
    { url: "https://realtalkdigest.com/two", text: "farm rewrite two", retrievedAt: "2026-09-01T00:00:00Z" },
    ...Array.from({ length: 12 }, (_, i) => ({ url: `https://news.meaww.com/${i}`, text: `farm rewrite ${i}`, retrievedAt: "2026-09-01T00:00:00Z" })),
    { url: "https://www.whitehouse.gov/briefing", text: "official announcement text", retrievedAt: "2026-09-01T00:00:00Z" },
    { url: "https://www.reuters.com/story", text: "newsroom reporting text", retrievedAt: "2026-09-01T00:00:00Z" },
  ];
  const found = { url: "https://www.senate.gov/late-discovery", text: "official record found during unit research", retrievedAt: "2026-09-01T00:00:00Z" };
  const run = await new ResearchClient({ provider: provider(), polymarket: new PolymarketClient(async () => new Response(JSON.stringify([event]))), searchProvider: { async search() { return [found]; } } })
    .researchMarket({ slug: event.slug, budgetUsd: 1, effort: "high", sources });
  const prompt = run.promptMessages!.map(m => m.content).join("\n");
  assert.match(prompt, /SOURCE 15\ntitle: Untitled\nurl: https:\/\/www\.whitehouse\.gov\/briefing/);
  assert.match(prompt, /SOURCE 16\ntitle: Untitled\nurl: https:\/\/www\.reuters\.com\/story/);
  assert.match(prompt, /url: https:\/\/www\.whitehouse\.gov\/briefing\n[\s\S]*?provenance: tier 1 \(primary\/official\)/);
  assert.doesNotMatch(prompt, /SOURCE \d+\ntitle: Untitled\nurl: https:\/\/news\.meaww\.com\/11/);
  const summary = run.limitations.filter(l => l.startsWith("Evidence base provenance:"));
  assert.equal(summary.length, 1);
  assert.equal(run.sources.length, 17);
  assert.match(summary[0]!, /2 tier-1[\s\S]*?1 tier-2[\s\S]*?0 tier-3[\s\S]*?14 tier-4/);
  assert.match(prompt, /Evidence base provenance: 2 tier-1/);
});
