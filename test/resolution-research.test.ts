import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PolymarketClient, ResearchClient } from "../src/index.ts";
import { parseCliArgs } from "../src/cli-args.ts";
import { initialUnits, discoveryQueries } from "../src/market-units.ts";
import { marketContext } from "../src/market-policy.ts";
import { clarificationAdapters } from "../src/clarification-adapter.ts";
import { collectAdapterSources, extractSourceUrls } from "../src/source-adapters.ts";
import { classifySourceTier } from "../src/source-tier.ts";
import type { ChatRequest, PolymarketEvent } from "../src/types.ts";

const clarifications = JSON.parse(await readFile(new URL("./fixtures/resolution-clarifications.json", import.meta.url), "utf8")) as Record<string, string>;
const slug = "venezuela-leader-end-of-2026";
const description = "Official holder at Dec 31, 2026 at 12 PM ET. The primary resolution source is official government information.";
const document = { url: "https://example.test/evidence", text: "Evidence fixture for formal office and temporary powers", retrievedAt: "2026-09-01T00:00:00Z", publishedAt: "2026-09-01T00:00:00Z" };

function clientFor(prompts: ChatRequest[]) {
  const provider = {
    kind: "custom" as const, model: "fixture",
    async estimateCost() { return { usd: 0, inputTokens: 10, outputTokens: 10, known: true }; },
    async complete(request: ChatRequest) {
      prompts.push(request);
      return { content: "Evidence fixture report", model: "fixture", provider: "custom" as const, usage: { inputTokens: 10, outputTokens: 10 }, costUsd: 0 };
    },
  };
  const polymarket = new PolymarketClient(async () => new Response(JSON.stringify([{ id: "fixture", slug, title: "Venezuela leader end of 2026?", description, markets: [{ id: "a", question: "Maduro?", description, outcomePrices: ["0.837", "0.163"] }] }])));
  return new ResearchClient({ provider, polymarket, searchProvider: { async search() { return [document]; } } });
}

test("the exact supplied Maduro clarification reaches every dossier and synthesis and survives replay", async () => {
  const prompts: ChatRequest[] = [];
  const client = clientFor(prompts);
  const run = await client.researchMarket({ slug, budgetUsd: 0, effort: "high", clarification: clarifications[slug] });
  assert.equal(run.decomposition?.dossiers.length, 2);
  assert.equal(prompts.length, 3);
  for (const prompt of prompts) {
    const text = prompt.messages.map(message => message.content).join("\n");
    assert.ok(text.includes(clarifications[slug]!));
    assert.ok(text.includes(description));
    assert.doesNotMatch(text, /0\.837|0\.163|outcomePrices/);
  }
  assert.equal(run.event?.clarification, clarifications[slug]);
  assert.ok(run.limitations.some(value => value.includes("authenticity")));
  const replay = await client.rewriteRun(run, { slug, budgetUsd: 0 });
  assert.equal(replay.event?.clarification, clarifications[slug]);
  assert.deepEqual(replay.decomposition, run.decomposition);
  const changed = await client.rewriteRun(run, { slug, budgetUsd: 0, clarification: "Replacement clarification" });
  assert.equal(changed.decomposition, undefined);
  assert.doesNotMatch(JSON.stringify(changed.promptMessages), /Temporary legal measures/);
});

test("all five resolution cases plan factual dependencies rather than biographies of outcome labels", () => {
  const slugs = [...Object.keys(clarifications), "maduro-prison-time-527", "us-strike-on-cuba-by", "us-iran-final-nuclear-deal-by-20260621201254412"];
  for (const value of slugs) {
    const event: PolymarketEvent = { id: value, slug: value, title: value, raw: null, markets: [{ id: "a", groupItemTitle: "No prison time" }, { id: "b", groupItemTitle: "October 31" }] };
    assert.ok(initialUnits(event).every(unit => unit.kind === "dependency"));
    assert.equal(initialUnits(event).length, 2);
    assert.equal(discoveryQueries(event).length, 4);
    assert.doesNotMatch(JSON.stringify(initialUnits(event)), /White House September|specific qualifications/);
  }
});

test("NATO clarification order and distinct nested deadlines survive compact price-free context", () => {
  const event: PolymarketEvent = { id: "nato", slug: "nato", title: "NATO", raw: null, description: "Old 2025 summary", clarification: clarifications["nato-x-russia-military-clash-in-2025"], markets: [{ id: "a", description: "October 2026 rules" }, { id: "b", description: "December 2026 rules" }, { id: "c", description: "October 2026 rules" }] };
  const context = marketContext(event);
  assert.deepEqual(context.rules, ["Old 2025 summary", "October 2026 rules", "December 2026 rules"]);
  assert.deepEqual(context.markets?.map(market => market.ruleIndex), [1, 2, 1]);
  assert.equal(context.clarification?.split("\n\n===\n\n").length, 4);
  assert.ok(context.clarification?.endsWith("regardless of whether a clarification is made."));
});

test("clarification CLI parameters are optional and preserve multiline text", () => {
  const args = ["market", slug, "--provider", "ollama", "--model", "fixture", "--budget", "0"];
  const plain = parseCliArgs(args);
  const inline = parseCliArgs([...args, "--clarification", clarifications[slug]!]);
  const file = parseCliArgs([...args, "--clarification-file", "clarification.txt"]);
  assert.equal(plain.clarification, undefined);
  assert.equal(inline.clarification, clarifications[slug]);
  assert.equal(file.clarificationFile, "clarification.txt");
  assert.throws(() => parseCliArgs([...args, "--clarification", "text", "--clarification-file", "file"]), /only one/);
});

test("clarification links fetch exact releases, preserve evidence and diagnose failed pages", async () => {
  const text = clarifications["nato-x-russia-military-clash-in-2025"]!;
  const fetched: string[] = [];
  const fetchFn: typeof fetch = async input => {
    fetched.push(String(input));
    if (String(input).includes("6846")) return new Response("Unavailable", { status: 503 });
    return new Response("Press release No. 170 20.08.2026. Romanian aircraft fired its cannon at a drifting maritime drone.", { headers: { "content-type": "text/plain" } });
  };
  const result = await collectAdapterSources(clarificationAdapters(text, fetchFn), { topic: "NATO", rules: text, urls: extractSourceUrls(text), asOf: "2026-09-08", signal: AbortSignal.timeout(1000) });
  assert.equal(fetched.length, 2);
  assert.equal(result.documents.length, 1);
  assert.match(result.documents[0]!.text, /20\.08\.2026/);
  assert.equal(result.documents[0]!.sourceTier, 1);
  assert.match(result.diagnostics[0]!.limitations.join(" "), /6846.*503/);
  assert.equal(clarificationAdapters(undefined).length, 0);
  assert.equal(classifySourceTier("https://mapn.ro.example.test"), 4);
});
