import assert from "node:assert/strict";
import test from "node:test";
import { prioritySources } from "../src/research-source-selection.ts";
import { synthesisSources } from "../src/run-assembly.ts";
import type { PolymarketEvent, ResearchRun, SourceDocument } from "../src/types.ts";

test("recent relevant reporting survives a full pool of older official pages without increasing the synthesis budget", () => {
  const event: PolymarketEvent = { id: "cuba", slug: "cuba", title: "US military action against Cuba by...?", raw: null };
  const older: SourceDocument[] = Array.from({ length: 15 }, (_, index) => ({ url: `https://www.southcom.mil/${index}`, title: "Regional military exercises", text: "Regional exercises in March", publishedAt: "2026-03-01", retrievedAt: "2026-09-08" }));
  const current: SourceDocument = { url: "https://www.reuters.com/cuba", title: "Cuba says no negotiations", text: "Talks are stalled", publishedAt: "2026-09-07", retrievedAt: "2026-09-08", retrievalKind: "snippet" };
  const misleading: SourceDocument = { ...current, url: "https://unknown.example/cuba", title: "Cuba claims on an unverified site", publishedAt: "2026-09-08" };
  const sources = [...older, current, misleading];
  const decomposition = { dossiers: [{}] } as ResearchRun["decomposition"];
  const selected = synthesisSources(sources, decomposition, event);
  assert.equal(selected.length, 10);
  assert.ok(selected.some(entry => entry.number === 16 && entry.source.text === "Talks are stalled"));
  assert.ok(!selected.some(entry => entry.number === 17));
  assert.equal(prioritySources(sources, event)[0]!.number, 16);
});

test("linked resolution evidence is retained even when undated and not titled with the event subject", () => {
  const source: SourceDocument = { url: "https://english.mapn.ro/release", title: "Updated Press Information", text: "Evidence", retrievedAt: "2026-09-08" };
  const event: PolymarketEvent = { id: "nato", slug: "nato", title: "NATO Russia", raw: null, clarification: `See ${source.url}.` };
  assert.deepEqual(prioritySources([source], event).map(entry => entry.number), [1]);
});
