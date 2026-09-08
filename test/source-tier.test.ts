import assert from "node:assert/strict";
import test from "node:test";
import { attributedOrigin, byProvenance, classifySourceTier, evidenceBaseSummary, provenanceLine, tierOf } from "../src/source-tier.ts";
import type { SourceDocument } from "../src/types.ts";

function source(url: string, text = "", extra: Partial<SourceDocument> = {}): SourceDocument {
  return { url, text, retrievedAt: "2026-09-07T00:00:00Z", ...extra };
}

test("provenance tiers separate official records, newsrooms, derivatives and unknown hosts", () => {
  assert.equal(classifySourceTier("https://www.whitehouse.gov/briefing"), 1);
  assert.equal(classifySourceTier("https://www.gov.uk/government/news"), 1);
  assert.equal(classifySourceTier("https://arxiv.org/abs/2601.00001"), 1);
  assert.equal(classifySourceTier("https://www.reuters.com/world/story"), 2);
  assert.equal(classifySourceTier("https://www.nypost.com/2026/08/12/media/story"), 2);
  assert.equal(classifySourceTier("https://en.wikipedia.org/wiki/Margo_Martin"), 3);
  assert.equal(classifySourceTier("https://x.com/PILFoundation/status/1"), 3);
  assert.equal(classifySourceTier("https://www.analyzingamerica.org/trump-weighs-next-press-secretary"), 4);
  assert.equal(classifySourceTier("https://patriot.university/knowledge-base/people"), 4);
  assert.equal(classifySourceTier("not a url"), 4);
});

test("a lookalike subdomain of an unrelated host does not inherit a newsroom tier", () => {
  assert.equal(classifySourceTier("https://reuters.com.example.test/story"), 4);
  assert.equal(classifySourceTier("https://uk.reuters.com/story"), 2);
  assert.equal(classifySourceTier("https://notgov.example/story"), 4);
});

test("an explicitly assigned tier survives classification", () => {
  assert.equal(tierOf(source("https://patriot.university/x", "", { sourceTier: 1 })), 1);
  assert.equal(tierOf(source("https://patriot.university/x")), 4);
});

test("low-tier pages disclose the outlet they are rewriting; sourced outlets do not", () => {
  const rewrite = source("https://news.meaww.com/who-could-replace", "Trump is weighing options, according to the New York Post, after the resignation.");
  assert.equal(attributedOrigin(rewrite), "New York Post");
  assert.match(provenanceLine(rewrite), /tier 4 .*attributes its claims to New York Post \(original not retrieved\)/);
  const original = source("https://www.nypost.com/story", "Trump is weighing options, according to the New York Post.");
  assert.equal(attributedOrigin(original), undefined);
  assert.equal(provenanceLine(original), "provenance: tier 2 (established newsroom)");
});

test("an attribution phrase running past a plausible outlet name is not reported as an origin", () => {
  const rambling = source("https://example.test/a", "according to Several People Familiar With The Deliberations Inside The West Wing");
  assert.equal(attributedOrigin(rambling), undefined);
});

test("the evidence base summary counts every tier so an all-derivative bundle is visible", () => {
  const summary = evidenceBaseSummary([
    source("https://www.whitehouse.gov/a"),
    source("https://www.axios.com/b"),
    source("https://news.meaww.com/c"),
    source("https://realtalkdigest.com/d"),
  ]);
  assert.match(summary, /1 tier-1 \(primary\/official\)/);
  assert.match(summary, /1 tier-2 \(established newsroom\)/);
  assert.match(summary, /0 tier-3 \(derivative or self-published\)/);
  assert.match(summary, /2 tier-4 \(unverified provenance\)/);
});

test("provenance ordering prefers a better tier and, within a tier, a fetched page over a snippet", () => {
  const officialSnippet = source("https://www.whitehouse.gov/a", "", { retrievalKind: "snippet" });
  const newsroomPage = source("https://www.axios.com/b", "", { retrievalKind: "page" });
  const farmPage = source("https://patriot.university/c", "", { retrievalKind: "page" });
  const newsroomSnippet = source("https://www.reuters.com/d", "", { retrievalKind: "snippet" });
  const ordered = [farmPage, newsroomSnippet, newsroomPage, officialSnippet].sort(byProvenance);
  assert.deepEqual(ordered.map(entry => entry.url), [officialSnippet.url, newsroomPage.url, newsroomSnippet.url, farmPage.url]);
});

test("a weak attribution verb and a trailing period do not manufacture an outlet name", () => {
  assert.equal(attributedOrigin(source("https://example.test/a", "The board met per Task Force guidance this quarter.")), undefined);
  assert.equal(attributedOrigin(source("https://example.test/b", "The figure was reported by TIME. It was later revised.")), "TIME");
});
