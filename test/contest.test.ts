import assert from "node:assert/strict";
import test from "node:test";
import { contestOf, contestQueries } from "../src/contest.ts";
import { evidenceForWriter, marketContext } from "../src/market-policy.ts";
import { initialUnits, retrievalQueries } from "../src/market-units.ts";
import type { PolymarketEvent, PolymarketMarket, SourceDocument } from "../src/types.ts";

function market(question: string, sportsMarketType: string): PolymarketMarket {
  return { id: question, question, description: `${question} rules`, outcomes: ["Yes", "No"], sportsMarketType } as PolymarketMarket;
}

const nba: PolymarketEvent = {
  id: "1", slug: "nba-gsw-den-2026-10-26", title: "Warriors vs. Nuggets",
  markets: [market("Warriors vs. Nuggets", "moneyline"), market("Jokic: Points O/U 27.5", "points"), market("Spread: Nuggets (-6.5)", "spreads")],
  raw: { gameId: 101, teams: [{ name: "Warriors", league: "nba" }, { name: "Nuggets", league: "nba" }] },
};

const cs2: PolymarketEvent = {
  id: "2", slug: "cs2-g2-dendel-2026-10-26", title: "Counter-Strike: G2 vs DENDELE CS (BO3) - PGL Masters Bucharest Group Stage",
  markets: [market("Counter-Strike: G2 vs DENDELE CS (BO3)", "moneyline")], raw: {},
};

const politics: PolymarketEvent = { id: "3", slug: "trump-vs-harris", title: "Trump vs. Harris debate", markets: [], raw: {} };

function source(text: string): SourceDocument {
  return { url: "https://www.example.test/preview", text, retrievedAt: "2026-10-26T00:00:00Z" };
}

test("a game is read from Gamma's teams or its title, and a non-sports 'vs' title is not a game", () => {
  assert.deepEqual(contestOf(nba), { sides: ["Warriors", "Nuggets"], league: "nba" });
  assert.deepEqual(contestOf(cs2), { sides: ["G2", "DENDELE CS"], competition: "PGL Masters Bucharest Group Stage", league: "cs2" });
  assert.equal(contestOf(politics), undefined);
});

test("game research searches for previews, team news and form instead of the raw title", () => {
  const contest = contestOf(nba)!;
  assert.deepEqual(contestQueries(contest, "low"), ["Warriors vs Nuggets NBA preview", "Warriors Nuggets NBA team news injuries"]);
  const medium = retrievalQueries(nba, { slug: nba.slug, budgetUsd: 0, effort: "medium" }, false);
  assert.equal(medium.length, 4);
  assert.ok(medium.includes("Nuggets NBA team news injuries"));
  assert.ok(contestQueries(contestOf(cs2)!, "medium").includes("DENDELE CS roster news stand-in"));
  assert.ok(contestQueries(contestOf(cs2)!, "high").includes("G2 recent results PGL Masters Bucharest Group Stage"));
  assert.ok(medium.every(query => !query.includes("contrary evidence")));
  assert.equal(retrievalQueries(nba, { slug: nba.slug, budgetUsd: 0, queries: ["custom"] }, false)[0], "custom");
  assert.deepEqual(initialUnits(nba), []);
});

test("the writer sees only the winner market of a game and a count of the props left out", () => {
  const context = marketContext(nba);
  assert.deepEqual(context.markets?.map(m => m.question), ["Warriors vs. Nuggets"]);
  assert.equal(context.omittedPropMarkets, 2);
  assert.deepEqual(context.rules, ["Warriors vs. Nuggets rules"]);
  assert.equal(marketContext(politics).omittedPropMarkets, undefined);
});

test("betting lines are stripped from game evidence while team news survives", () => {
  const text = "Jokic is listed as probable with a wrist issue. The Nuggets are 6.5-point favorites at DraftKings. Denver is -250 on the moneyline. Curry shot 45% from three last week. Braun is the projected starter at guard.";
  const filtered = evidenceForWriter(source(text), nba).text;
  assert.match(filtered, /Jokic is listed as probable/);
  assert.match(filtered, /Curry shot 45% from three/);
  assert.match(filtered, /projected starter/);
  assert.doesNotMatch(filtered, /DraftKings|moneyline|favorites/);
  assert.equal(evidenceForWriter(source(text), politics).text.includes("DraftKings"), true);
});
