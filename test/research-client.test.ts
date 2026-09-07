import assert from "node:assert/strict";
import test from "node:test";
import { PolymarketClient, ResearchClient } from "../src/index.ts";
import type { ChatRequest, ChatResult, CostEstimate, InferenceProvider } from "../src/types.ts";

class FakeProvider implements InferenceProvider {
  readonly kind = "custom" as const; readonly model = "fake";
  async estimateCost(_request: ChatRequest): Promise<CostEstimate> { return { usd: 0.02, inputTokens: 10, outputTokens: 10, known: true }; }
  async complete(_request: ChatRequest): Promise<ChatResult> { return { content: "# grounded report", model: this.model, provider: this.kind, costUsd: 0.01, usage: { inputTokens: 10, outputTokens: 10 } }; }
}

test("general topics use no market fetch or Arena instructions and disclose failed searches", async () => {
  let calls = 0;
  const client = new ResearchClient({ provider: new FakeProvider(), polymarket: new PolymarketClient(async () => { throw new Error("Market network prohibited"); }), searchProvider: { async search() { calls++; throw new Error("unavailable"); } } });
  const run = await client.researchTopic({ topic: "Shipping disruptions", budgetUsd: 1, effort: "medium" });
  assert.equal(run.event, undefined);
  assert.equal(run.stopReason, "complete");
  assert.equal(calls, 4);
  assert.equal(run.retrieval?.searches.filter(s => s.status === "failed").length, 4);
  assert.ok(run.limitations.some(s => s.startsWith("Search failed:")));
  const prompt = JSON.stringify(run.promptMessages);
  assert.doesNotMatch(prompt, /requested lab|leaderboard|Elo|Polymarket/);
  assert.match(prompt, /Shipping disruptions/);
});

test("missing rules skip both search and source adapters", async () => {
  const forbidden = async () => { throw new Error("Must not retrieve"); };
  const run = await new ResearchClient({ provider: new FakeProvider(), polymarket: market(""), searchProvider: { search: forbidden } }).researchMarket({ slug: "market", budgetUsd: 1 });
  assert.equal(run.retrieval?.searches.length, 0);
  assert.equal(run.stopReason, "missing_resolution_rules");
});

test("source adapters coexist with broad search and are not called on replay", async () => {
  let calls = 0;
  const client = new ResearchClient({ provider: new FakeProvider(), polymarket: market("https://example.test/official"), searchProvider: { async search() { return []; } }, sourceAdapters: [{ id: "fixture", domains: ["example.test"], async fetch() { calls++; return { documents: [{ url: "https://example.test/data", text: "official observation", retrievedAt: "2026-01-01", publishedAt: "2026-01-01", retrievalKind: "page" }], limitations: [] }; } }] });
  const first = await client.researchMarket({ slug: "market", budgetUsd: 1 });
  assert.equal(first.sources.length, 1);
  assert.equal(first.retrieval?.searches.length, 2);
  const replay = await client.rewriteRun(first, { slug: "market", budgetUsd: 1 });
  assert.equal(calls, 1);
  assert.deepEqual(replay.sources, first.sources);
});

test("blank and truncated outputs preserve token costs but cannot complete", async () => {
  for (const [content, finishReason, expected] of [["", "length", "empty_response"], ["partial", "length", "output_truncated"]]) {
    const provider = new FakeProvider();
    provider.complete = async () => ({ content, finishReason, model: "fake", provider: "custom", costUsd: 0.01, usage: { inputTokens: 100, outputTokens: 1200 } });
    const run = await new ResearchClient({ provider, polymarket: market() }).researchMarket({ slug: "market", budgetUsd: 1 });
    assert.equal(run.stopReason, expected);
    assert.equal(run.ledger.spentUsd, 0.01);
    assert.equal(run.generation?.finishReason, "length");
  }
});

function market(resolutionSource = "Official source") {
  return new PolymarketClient(async () => new Response(JSON.stringify([{ id: "1", slug: "market", title: "Market", resolutionSource, markets: [] }])));
}

test("snapshot rewrite preserves cutoff and never invokes retrieval", async () => {
  const first = await new ResearchClient({ provider: new FakeProvider(), polymarket: market() }).researchMarket({ slug: "market", budgetUsd: 1 });
  const forbidden = async () => { throw new Error("Network must not be used during replay"); };
  const client = new ResearchClient({ provider: new FakeProvider(), polymarket: new PolymarketClient(forbidden), searchProvider: { search: forbidden } });
  const replay = await client.rewriteRun(first, { slug: "market", budgetUsd: 1 });
  assert.equal(replay.parentRunId, first.id);
  assert.equal(replay.asOf, first.asOf);
  assert.deepEqual(replay.sources, first.sources);
  assert.equal(replay.stopReason, "complete");
});

test("long early sources cannot exclude later release evidence from the prompt", async () => {
  const sources = Array.from({ length: 30 }, (_, i) => ({ url: `https://example.test/${i}`, text: `source-${i} release ` + "background ".repeat(3000), retrievedAt: "2026-09-01T00:00:00Z" }));
  const run = await new ResearchClient({ provider: new FakeProvider(), polymarket: market() }).researchMarket({ slug: "market", budgetUsd: 1, sources });
  const prompt = run.promptMessages?.map(m => m.content).join("\n") ?? "";
  assert.match(prompt, /source-29 release/);
  assert.ok(prompt.length < 65000);
});

test("client emits a grounded report and actual ledger cost", async () => {
  const client = new ResearchClient({ provider: new FakeProvider(), polymarket: market() });
  const run = await client.researchMarket({ slug: "market", budgetUsd: 0.05 });
  assert.equal(run.stopReason, "complete"); assert.equal(run.reportMarkdown, "# grounded report"); assert.equal(run.ledger.spentUsd, 0.01);
});

test("client fails closed when resolution rules are absent", async () => {
  const client = new ResearchClient({ provider: new FakeProvider(), polymarket: market("") });
  const run = await client.researchMarket({ slug: "market", budgetUsd: 1 });
  assert.equal(run.stopReason, "missing_resolution_rules"); assert.equal(run.ledger.calls.length, 0);
});

test("client deduplicates retrieved evidence and excludes post-cutoff sources", async () => {
  const client = new ResearchClient({ provider: new FakeProvider(), polymarket: market(), searchProvider: {
    async search() { return [
      { url: "https://example.test/a", text: "in cutoff", publishedAt: "2026-01-01T00:00:00Z", retrievedAt: "2026-01-01T00:00:00Z" },
      { url: "https://example.test/a/", text: "duplicate", retrievedAt: "2026-01-01T00:00:00Z" },
      { url: "https://example.test/future", text: "future", publishedAt: "2027-01-01T00:00:00Z", retrievedAt: "2026-01-01T00:00:00Z" },
    ];
  } }});
  const run = await client.researchMarket({ slug: "market", budgetUsd: 1, asOf: new Date("2026-06-01T00:00:00Z") });
  assert.equal(run.sources.length, 1);
  assert.equal(run.sources[0]?.url, "https://example.test/a");
});
