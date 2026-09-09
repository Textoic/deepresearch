import assert from "node:assert/strict";
import test from "node:test";
import { coherenceDirective, referencePrice, unretrievedResolutionSource, unsettledContracts } from "../src/market-coherence.ts";
import { excludedFromRetrieval, isPredictionMarketHost } from "../src/search/excluded-hosts.ts";
import { buildMessages } from "../src/report-prompt.ts";
import type { PolymarketEvent } from "../src/types.ts";

const event = (markets: PolymarketEvent["markets"]): PolymarketEvent => ({
  id: "1", slug: "aws-service-disrupted", title: "AWS service disrupted by...?",
  resolutionSource: "AWS Health Dashboard", markets, raw: null,
});

test("gamma's stringified price array is read, and a missing price yields nothing", () => {
  assert.equal(referencePrice({ id: "a", outcomePrices: '["0.5", "0.5"]' }), 0.5);
  assert.equal(referencePrice({ id: "b", outcomePrices: ["0.93", "0.07"] }), 0.93);
  assert.equal(referencePrice({ id: "c" }), undefined);
  assert.equal(referencePrice({ id: "d", outcomePrices: "not json" }), undefined);
});

test("only open contracts priced below the settled level are listed", () => {
  const listed = unsettledContracts(event([
    { id: "a", question: "AWS service disrupted by September 30?", outcomePrices: '["0.5", "0.5"]' },
    { id: "b", question: "Settled high", outcomePrices: '["0.97", "0.03"]' },
    { id: "c", question: "Already closed", outcomePrices: '["0.2", "0.8"]', closed: true },
    { id: "d", question: "No price at all" },
  ]));
  assert.deepEqual(listed, ["AWS service disrupted by September 30?"]);
});

test("the directive names the unsettled contract and never carries a number", () => {
  const directive = coherenceDirective(event([{ id: "a", question: "AWS service disrupted by September 30?", outcomePrices: '["0.5", "0.5"]' }]));
  assert.ok(directive);
  assert.match(directive, /AWS service disrupted by September 30\?/);
  assert.ok(!/\d+(?:\.\d+)?\s*%|0\.\d+/.test(directive), directive);
});

test("a fully settled event gets no directive", () => {
  assert.equal(coherenceDirective(event([{ id: "a", question: "Settled", outcomePrices: '["0.99", "0.01"]' }])), undefined);
  assert.equal(coherenceDirective(event([{ id: "a", question: "Unpriced" }])), undefined);
});

test("the system prompt carries the cross-check but the writer prompt carries no price", () => {
  const target = event([{ id: "a", question: "AWS service disrupted by September 30?", outcomePrices: '["0.5", "0.5"]' }]);
  const [system, user] = buildMessages({ event: target, asOf: "2026-09-09T00:00:00.000Z", sources: [], requirements: [], topicMode: false });
  assert.match(system!.content, /RESOLVED-CLAIM CROSS-CHECK/);
  assert.ok(!user!.content.includes("0.5"), "no price may reach the writer's context");
  assert.ok(!user!.content.includes("outcomePrices"));
});

test("prediction-market and odds-tracker hosts are dropped before retrieval", () => {
  for (const url of [
    "https://polymarket.com/event/israel-withdraws-from-lebanon-before-february",
    "https://www.polymarket.com/event/x",
    "https://polymarketanalytics.com/event/israel-withdraws-from-lebanon-before-july",
    "https://kalshi.com/markets/abc",
    "https://www.electionbettingodds.com/",
    "https://manifold.markets/question/x",
  ]) {
    assert.ok(isPredictionMarketHost(url), url);
    assert.ok(excludedFromRetrieval(url), url);
  }
});

test("ordinary reporting hosts and lookalikes are not excluded", () => {
  for (const url of ["https://www.cnn.com/2026/06/26/middleeast/a", "https://www.reuters.com/world/", "https://notpolymarket.com/x", "https://polymarket.com.example.org/x"]) {
    assert.ok(!excludedFromRetrieval(url), url);
  }
});

test("an unread resolution source is reported as a factual limitation, not an instruction", () => {
  const target: PolymarketEvent = { id: "1", slug: "aws", title: "AWS", resolutionSource: "See https://health.aws.amazon.com/health/status", markets: [], raw: null };
  const snippetOnly = unretrievedResolutionSource(target, [
    { url: "https://health.aws.amazon.com/health/status?eventID=x", text: "Disrupted (1 service)", retrievedAt: "2026-09-09T00:00:00.000Z", retrievalKind: "snippet" },
  ]);
  assert.ok(snippetOnly);
  assert.match(snippetOnly, /was not retrieved as a page/);
  assert.ok(!/\bReport\b|\bstate that\b|\bVerify\b/.test(snippetOnly), snippetOnly);

  const fetched = unretrievedResolutionSource(target, [
    { url: "https://health.aws.amazon.com/health/status", text: "full page", retrievedAt: "2026-09-09T00:00:00.000Z", retrievalKind: "page" },
  ]);
  assert.equal(fetched, undefined);
  assert.equal(unretrievedResolutionSource({ ...target, resolutionSource: "consensus of credible reporting" }, []), undefined);
});
