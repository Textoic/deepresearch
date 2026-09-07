import type { PolymarketEvent } from "./types.ts";
import type { RaceOddsSnapshot, RaceQuote, SenateRoster } from "./senate-evidence.ts";

type RosterRow = SenateRoster["rows"][number];

function quotesCell(race: RaceOddsSnapshot): string {
  if (!race.quotes.length) return "Unavailable";
  return race.quotes.map(quote => `${quote.name.replaceAll("|", "/")}: ${(quote.yesProbability * 100).toFixed(1)}%`).join("; ");
}

function provenanceCell(race: RaceOddsSnapshot): string {
  return race.sourceNumber ? ` [Source ${race.sourceNumber}](${race.url})` : `; ${race.limitation ?? "no quote"}`;
}

function holderFor(roster: SenateRoster | undefined, state: string): RosterRow | undefined {
  return roster?.rows.find(row => row.state === state && row.contested);
}

function seatArithmetic(roster: SenateRoster): string[] {
  const { current, contested, fixed } = roster;
  return ["", "## Seat arithmetic (computed from the official roster)", "",
    `The parsed roster contains 100 seats: ${current.R} Republican, ${current.D} Democratic and ${current.I} independent. The 35 researched races comprise ${contested.R} Republican-held, ${contested.D} Democratic-held and ${contested.I} independent-held seats; the other 65 seats comprise ${fixed.R} Republican, ${fixed.D} Democratic and ${fixed.I} independent seats. [Source ${roster.sourceNumber}](${roster.url})`, "",
    `Assuming the ${current.I} current independent senators continue caucusing with Democrats and the non-contested seats keep their current affiliations: Democratic-caucus seats = ${fixed.D + fixed.I} + Democratic-caucus wins among the 35 races; Republican seats = ${fixed.R} + Republican wins. Democrats need ${51 - fixed.D - fixed.I} contested wins to reach 51. Republicans need ${50 - fixed.R} contested wins to reach 50 if they retain the vice-presidential tie-break. With a ${current.D + current.I}-seat Democratic caucus, ${51 - current.D - current.I} net gains reach 51; each Democratic-held seat lost requires one additional gain. These are conditional counting identities, not win forecasts. Unknown independent caucus intentions must remain separate.`];
}

const NO_ROSTER = ["", "Official 100-seat roster was not parsed; fixed-seat totals are withheld. Do not invent the baseline from a partial race list."];

export function renderSenateEvidence(odds: RaceOddsSnapshot[], roster?: SenateRoster): string {
  if (!odds.length) return "";
  const header = ["## Underlying race reference odds (rendered from structured data)", "", "Each percentage is the quoted YES price for that candidate/party to win its own 2026 U.S. Senate race. These are not national Senate-control probabilities or polling shares. Prices are not normalized; liquidity and contract differences can affect them. Missing quotes stay unavailable.", "", "| Race | Current holder from official roster | Candidate/party: reference YES probability | Observed UTC / source |", "| --- | --- | --- | --- |"];
  const rows = odds.map(race => {
    const holder = holderFor(roster, race.state);
    return `| ${race.race} | ${holder ? `${holder.name} (${holder.party})` : "Not verified"} | ${quotesCell(race)} | ${race.retrievedAt}${provenanceCell(race)} |`;
  });
  return [...header, ...rows, ...(roster ? seatArithmetic(roster) : NO_ROSTER)].join("\n");
}

interface Scenario { gains: string[]; losses: string[]; }

const SCENARIOS: Scenario[] = [
  { gains: ["Maine", "North Carolina", "Texas", "Ohio"], losses: [] },
  { gains: ["Maine", "North Carolina", "Alaska", "Texas"], losses: [] },
  { gains: ["Maine", "North Carolina", "Alaska", "Ohio"], losses: [] },
  { gains: ["Maine", "North Carolina", "Iowa", "Texas"], losses: [] },
  { gains: ["Maine", "North Carolina", "Alaska", "Texas", "Ohio"], losses: ["Michigan"] },
  { gains: ["Maine", "North Carolina", "Alaska", "Iowa", "Texas", "Ohio"], losses: ["Michigan", "New Hampshire"] },
  { gains: ["Maine", "North Carolina", "Texas"], losses: [] },
  { gains: ["Maine", "North Carolina", "Texas", "Ohio"], losses: ["Michigan"] },
];

const CONTROL_INTRO = "Each row assumes all other seats keep their current caucus alignment, including all unlisted Democratic defenses. A Democratic win in a Republican-held seat is a flip even when its quoted probability is high; it is never a Democratic hold. These examples illustrate alternative paths rather than an exhaustive enumeration of all 35-race combinations.";
const FLIP_INTRO = "The following screen selects individual Democratic race-win quotes between 10% and 90%, plus higher-priced Democratic chances in Republican-held seats. It is a transparent way to find scenarios to inspect, not a national forecast or a claim that other races cannot matter. Named outcomes without a party label remain in the full table and dossiers rather than being assigned a party by guesswork.";
const GAPS = ["", "## Dependencies, counterevidence and gaps", "", "- The Texas and Ohio quotes describe each state's election. They are not combined into a national probability. Shared turnout, economic conditions, polling errors and campaign developments can move several races together; multiplying their marginal probabilities would assume independence without evidence.", "- The full table includes Alaska's named candidate quotes and Nebraska's independent outcome. An independent win must be evaluated using evidence of the winner's caucus intentions. Do not automatically credit independent-win odds to Democrats, and do not remove independent voting seats from the chamber's denominator. If ordinary majority and VP criteria fail, apply the contract's President Pro Tempore fallback.", "- Polling shares, primary results, forecast-model outputs and prediction-market prices measure different things. The component dossiers supply candidate and polling context; a poll share must not replace a win-probability quote.", "- General-election procedures require state-specific sources. A primary runoff or a market's generic reference to runoffs does not prove that a general-election runoff is possible. Individual model-written dossiers remain subject to factual review on this point and on candidate biographies.", "- The roster is a current snapshot. Party changes before Election Day, qualifying special elections scheduled by the contract's cutoff, and independently elected senators' caucus decisions can change the counting inputs.", "- API quotes are displayed only for eligible, priced outcomes with verified state/year identity. A missing quote is an evidence gap, not a zero probability. The JSON artifacts preserve raw snapshots and liquidity. Dates describe retrieval/observation, not authenticated historical availability.", "", "## Individual race evidence", "", "Every researched race has a separate dossier below. These model-written analyses are retained for review; the structured odds and seat arithmetic above are rendered from the saved inputs rather than regenerated by the writer."];

function holdsSeat(roster: SenateRoster, state: string, party: RosterRow["party"]): boolean {
  return roster.rows.some(row => row.state === state && row.contested && row.party === party);
}

function scenarioRow(scenario: Scenario, roster: SenateRoster, dBase: number, rBase: number): string[] {
  const supported = scenario.gains.every(state => holdsSeat(roster, state, "Republican")) && scenario.losses.every(state => holdsSeat(roster, state, "Democratic"));
  if (!supported) return [];
  const gain = scenario.gains.length - scenario.losses.length;
  const democratic = dBase + gain;
  const republican = rBase - gain;
  const control = democratic >= 51 ? "Democratic" : republican >= 50 ? "Republican" : "Apply contract fallback";
  return [`| ${scenario.gains.join(", ")} | ${scenario.losses.join(", ") || "None"} | ${democratic} / ${republican} | ${control} |`];
}

function democraticQuote(race: RaceOddsSnapshot): RaceQuote | undefined {
  return race.quotes.find(quote => /Democrat|\(D\)/i.test(`${quote.name} ${quote.question}`));
}

function flipRow(race: RaceOddsSnapshot, roster: SenateRoster): string[] {
  const holder = holderFor(roster, race.state);
  const quote = democraticQuote(race);
  if (!holder || !quote || quote.yesProbability < 0.1) return [];
  if (holder.party === "Democratic" && quote.yesProbability > 0.9) return [];
  const role = holder.party === "Republican" ? "Potential Democratic flip" : "Democratic defense; a loss raises the required flips by one";
  return [`| ${race.state} | ${holder.party} | ${(quote.yesProbability * 100).toFixed(1)}% [Source ${race.sourceNumber}](${race.url}) | ${role} |`];
}

function controlPaths(roster: SenateRoster): string[] {
  const dBase = roster.current.D + roster.current.I;
  const rBase = roster.current.R;
  const requiredNetGains = 51 - dBase;
  const thresholds = [0, 1, 2, 3].map(losses => `| ${losses} | ${requiredNetGains + losses} | 51 D / 49 R |`);
  return ["## Paths to control", "",
    `Under the stated assumption that the current independents stay in the Democratic caucus and no new independent winner remains outside both caucuses, let G be Democratic gains from currently Republican-held seats and L be losses of currently Democratic-held seats. The resulting caucus counts are D = ${dBase} + G − L and R = ${rBase} − G + L. Democratic outright control requires G − L ≥ ${requiredNetGains}. Republican control with a Republican vice-presidential tie-break requires G − L ≤ ${requiredNetGains - 1}. These are counting conditions, not forecasts.`, "",
    "| Democratic-held seats lost | Gains needed from Republican-held seats for 51 D-caucus seats | Result at that threshold |", "| --- | --- | --- |", ...thresholds,
    "", "### Concrete conditional examples", "", CONTROL_INTRO, "",
    "| Democratic gains in currently Republican-held seats | Democratic-held seats lost | D / R caucus seats | Control under Republican VP assumption |", "| --- | --- | --- | --- |",
    ...SCENARIOS.flatMap(scenario => scenarioRow(scenario, roster, dBase, rBase)),
    "", "### Reference odds for potential flips and exposed defenses", "", FLIP_INTRO, "",
    "| State | Current holder's party | Exact Democratic win quote | Scenario role |", "| --- | --- | --- | --- |"];
}

export function renderSenateReport(event: PolymarketEvent, asOf: string, odds: RaceOddsSnapshot[], roster: SenateRoster): string {
  const heading = [`# ${event.title}`, "", `**Market metadata cutoff:** ${asOf}. Evidence was retrieved during the run; individual observation timestamps are shown below.`, "", "## Resolution contract", "",
    event.description ?? "See frozen event metadata.", "", `[Market contract](https://polymarket.com/event/${event.slug})`, "", renderSenateEvidence(odds, roster), ""];
  return [...heading, ...controlPaths(roster), ...odds.flatMap(race => flipRow(race, roster)), ...GAPS].join("\n");
}
