import assert from "node:assert/strict";
import test from "node:test";
import { fetchRaceOdds, parseSenateRoster, renderSenateEvidence, renderSenateReport, type SenateRoster } from "../src/senate-evidence.ts";
import type { PolymarketEvent, ResearchUnit } from "../src/types.ts";

const target: PolymarketEvent = { id: "1", slug: "senate-control", title: "Senate control 2026", raw: null };
const unit: ResearchUnit = { name: "Texas regular Senate election 2026", kind: "race", question: "Texas", queries: [] };
const payload = { slug: "texas-senate-election-winner", title: "Texas Senate Election Winner", active: true, endDate: "2026-11-03", markets: [
  { id: "1", question: "Will Democrats win the Texas Senate race in 2026?", groupItemTitle: "Candidate D", active: true, outcomes: '["No","Yes"]', outcomePrices: '["0.495","0.505"]' },
  { id: "2", question: "Will Placeholder win the Texas Senate race in 2026?", active: false, outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]' },
] };

test("underlying quotes verify identity, YES index and eligible status", async () => {
  const result = await fetchRaceOdds(unit, target, async () => new Response(JSON.stringify([payload])));
  assert.equal(result.snapshot.quotes.length, 1);
  assert.equal(result.snapshot.quotes[0]?.yesProbability, 0.505);
  assert.equal(result.source?.dependencyOf, target.slug);
  assert.doesNotMatch(result.source!.text, /Placeholder/);
  const wrong = await fetchRaceOdds(unit, target, async () => new Response(JSON.stringify([{ ...payload, slug: "national-control" }])));
  assert.equal(wrong.source, undefined);
  assert.match(wrong.snapshot.limitation!, /identity/);
});

test("scenario arithmetic retains independent caucus seats and compensates for a lost defense", () => {
  const roster: SenateRoster = {
    sourceNumber: 1, url: "https://www.senate.gov/senators/", current: { R: 53, D: 45, I: 2 }, contested: { R: 22, D: 13, I: 0 }, fixed: { R: 31, D: 32, I: 2 },
    rows: [
      ...["Maine", "North Carolina", "Texas", "Ohio", "Alaska", "Iowa"].map(state => ({ name: state, state, party: "Republican" as const, senateClass: 2, contested: true })),
      ...["Michigan", "New Hampshire"].map(state => ({ name: state, state, party: "Democratic" as const, senateClass: 2, contested: true })),
    ],
  };
  const report = renderSenateReport(target, "2026-09-07", [{ race: unit.name, state: "Texas", retrievedAt: "2026-09-07", quotes: [] }], roster);
  assert.match(report, /Democrats need 17 contested wins/);
  assert.match(report, /Republicans need 19 contested wins/);
  assert.match(report, /Maine, North Carolina, Texas, Ohio \| None \| 51 \/ 49 \| Democratic/);
  assert.match(report, /Maine, North Carolina, Texas, Ohio \| Michigan \| 50 \/ 50 \| Republican/);
  assert.match(report, /\| 1 \| 5 \| 51 D \/ 49 R/);
});

test("a complete unique roster yields exact counts; partial rosters are withheld", () => {
  const states = [...Array.from({ length: 48 }, (_, i) => `State ${i}`), "Florida", "Ohio"];
  const lines = states.flatMap((state, i) => [`A ${i} | ${state} | ${i < 20 ? "Democratic" : "Republican"} | ${i < 33 ? 2 : 3} III`, `B ${i} | ${state} | Republican | 1 I`]);
  const source = { url: "https://www.senate.gov/senators/", text: lines.join("\n"), retrievedAt: "2026-09-07", retrievalKind: "page" as const };
  const roster = parseSenateRoster([source])!;
  assert.equal(roster.rows.length, 100);
  assert.deepEqual(roster.contested, { R: 15, D: 20, I: 0 });
  assert.equal(roster.fixed.R + roster.fixed.D + roster.fixed.I, 65);
  assert.equal(parseSenateRoster([{ ...source, text: lines.slice(1).join("\n") }]), undefined);
  const table = renderSenateEvidence([{ race: unit.name, state: "Texas", retrievedAt: "2026-09-07", quotes: [{ name: "Candidate D", question: "D wins", yesProbability: 0.505 }] }], roster);
  assert.match(table, /50\.5%/);
  assert.match(table, /35 researched races/);
});
