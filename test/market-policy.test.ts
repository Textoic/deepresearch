import assert from "node:assert/strict";
import test from "node:test";
import { PolymarketClient, ResearchClient } from "../src/index.ts";
import { evidenceForWriter, normalizeMarketEvent } from "../src/market-policy.ts";
import { initialUnits } from "../src/market-decomposition.ts";
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
  const client = new ResearchClient({ provider: provider(), polymarket: new PolymarketClient(async () => new Response(JSON.stringify([event]))), searchProvider: { async search(q) { queries.push(q); return []; } } });
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
