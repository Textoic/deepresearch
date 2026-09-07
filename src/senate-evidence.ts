import { eligibleMarket } from "./market-policy.ts";
import type { PolymarketEvent, PolymarketMarket, ResearchUnit, SourceDocument } from "./types.ts";

export interface RaceOddsSnapshot {
  race: string;
  state: string;
  url?: string;
  retrievedAt: string;
  sourceNumber?: number;
  quotes: Array<{ name: string; question: string; yesProbability: number; liquidity?: string | number }>;
  limitation?: string;
  raw?: unknown;
}

function array(value: unknown): unknown[] {
  try { const parsed = typeof value === "string" ? JSON.parse(value) : value; return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

export async function fetchRaceOdds(unit: ResearchUnit, target: PolymarketEvent, fetchFn: typeof fetch = fetch): Promise<{ snapshot: RaceOddsSnapshot; source?: SourceDocument }> {
  const state = unit.name.replace(/ (?:regular|special) Senate election 2026$/, "");
  const snapshot: RaceOddsSnapshot = { race: unit.name, state, retrievedAt: new Date().toISOString(), quotes: [] };
  if (unit.kind !== "race" || !/Senate election 2026$/.test(unit.name)) return { snapshot: { ...snapshot, limitation: "Not a supported underlying race" } };
  const slug = `${state.toLowerCase().replaceAll(" ", "-")}-senate-election-winner`;
  if (slug === target.slug) return { snapshot: { ...snapshot, limitation: "Refused target-event odds" } };
  const url = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`;
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(15000), headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Gamma ${response.status}`);
    const payload: unknown = await response.json();
    const event = Array.isArray(payload) ? payload[0] as Record<string, unknown> | undefined : undefined;
    if (!event || event.slug !== slug || typeof event.title !== "string" || !event.title.toLowerCase().includes(state.toLowerCase()) || !/senate/i.test(event.title) || !String(event.endDate).startsWith("2026-")) throw new Error("No identity-matching 2026 race event");
    if (event.active === false || event.closed === true || event.archived === true) throw new Error("Underlying event inactive, closed or archived");
    for (const m of (Array.isArray(event.markets) ? event.markets : []) as Array<PolymarketMarket & { acceptingOrders?: boolean; liquidity?: string | number }>) {
      if (!eligibleMarket(m) || m.acceptingOrders === false || !m.question?.includes("2026") || !m.question.toLowerCase().includes(state.toLowerCase()) || !/senate/i.test(m.question)) continue;
      const outcomes = array(m.outcomes), prices = array(m.outcomePrices);
      const index = outcomes.findIndex(o => typeof o === "string" && o.toLowerCase() === "yes");
      if (index < 0 || prices[index] === null || prices[index] === undefined || prices[index] === "") continue;
      const price = Number(prices[index]);
      if (!Number.isFinite(price) || price < 0 || price > 1) continue;
      snapshot.quotes.push({ name: m.groupItemTitle ?? m.question, question: m.question, yesProbability: price, liquidity: m.liquidity });
    }
    snapshot.raw = event;
    snapshot.url = url;
    if (!snapshot.quotes.length) throw new Error("No eligible priced underlying outcomes");
    const text = `Identity-checked underlying event: ${event.title}. Year: 2026. Observation time: ${snapshot.retrievedAt}. These are race-specific YES prices, not national control forecasts. Prices are unnormalized reference probabilities, not poll vote shares or guaranteed outcomes. Separate binary prices need not sum to 100%.\n` + snapshot.quotes.map(q => `${q.name}: ${q.yesProbability * 100}% YES to "${q.question}". Reported liquidity: ${q.liquidity ?? "unknown"}.`).join("\n");
    return { snapshot, source: { url, title: `Structured underlying odds: ${state} Senate 2026`, text, retrievedAt: snapshot.retrievedAt, sourceTier: 1, retrievalKind: "page", dependencyOf: target.slug } };
  } catch (error) { snapshot.limitation = String(error); return { snapshot }; }
}

export interface SenateRoster {
  sourceNumber: number;
  url: string;
  rows: Array<{ name: string; state: string; party: "Democratic" | "Republican" | "Independent"; senateClass: number; contested: boolean }>;
  current: { R: number; D: number; I: number };
  contested: { R: number; D: number; I: number };
  fixed: { R: number; D: number; I: number };
}

export function parseSenateRoster(sources: SourceDocument[]): SenateRoster | undefined {
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i]!;
    if (!/^https:\/\/www\.senate\.gov\/senators\/?(?:[?#].*)?$/.test(source.url) || source.retrievalKind !== "page") continue;
    const rows: SenateRoster["rows"] = [];
    for (const line of source.text.split("\n")) {
      const fields = line.split("|").map(f => f.trim());
      if (fields.length < 4 || !/^(Democratic|Republican|Independent)$/.test(fields[2]!)) continue;
      const senateClass = Number(fields[3]!.match(/^[123]/)?.[0]);
      if (!senateClass) continue;
      rows.push({ name: fields[0]!, state: fields[1]!, party: fields[2] as SenateRoster["rows"][number]["party"], senateClass, contested: senateClass === 2 || (senateClass === 3 && ["Florida", "Ohio"].includes(fields[1]!)) });
    }
    if (rows.length !== 100 || new Set(rows.map(r => r.state + r.senateClass)).size !== 100 || rows.filter(r => r.contested).length !== 35) continue;
    const count = (items: typeof rows) => ({ R: items.filter(r => r.party === "Republican").length, D: items.filter(r => r.party === "Democratic").length, I: items.filter(r => r.party === "Independent").length });
    return { sourceNumber: i + 1, url: source.url, rows, current: count(rows), contested: count(rows.filter(r => r.contested)), fixed: count(rows.filter(r => !r.contested)) };
  }
  return undefined;
}

export function renderSenateEvidence(odds: RaceOddsSnapshot[], roster?: SenateRoster): string {
  if (!odds.length) return "";
  const out = ["## Underlying race reference odds (rendered from structured data)", "", "Each percentage is the quoted YES price for that candidate/party to win its own 2026 U.S. Senate race. These are not national Senate-control probabilities or polling shares. Prices are not normalized; liquidity and contract differences can affect them. Missing quotes stay unavailable.", "", "| Race | Current holder from official roster | Candidate/party: reference YES probability | Observed UTC / source |", "| --- | --- | --- | --- |"];
  for (const race of odds) {
    const holder = roster?.rows.find(r => r.state === race.state && r.contested);
    out.push(`| ${race.race} | ${holder ? `${holder.name} (${holder.party})` : "Not verified"} | ${race.quotes.length ? race.quotes.map(q => `${q.name.replaceAll("|", "/")}: ${(q.yesProbability * 100).toFixed(1)}%`).join("; ") : "Unavailable"} | ${race.retrievedAt}${race.sourceNumber ? ` [Source ${race.sourceNumber}](${race.url})` : `; ${race.limitation ?? "no quote"}`} |`);
  }
  if (roster) {
    const { current, contested, fixed } = roster;
    out.push("", "## Seat arithmetic (computed from the official roster)", "", `The parsed roster contains 100 seats: ${current.R} Republican, ${current.D} Democratic and ${current.I} independent. The 35 researched races comprise ${contested.R} Republican-held, ${contested.D} Democratic-held and ${contested.I} independent-held seats; the other 65 seats comprise ${fixed.R} Republican, ${fixed.D} Democratic and ${fixed.I} independent seats. [Source ${roster.sourceNumber}](${roster.url})`, "", `Assuming the ${current.I} current independent senators continue caucusing with Democrats and the non-contested seats keep their current affiliations: Democratic-caucus seats = ${fixed.D + fixed.I} + Democratic-caucus wins among the 35 races; Republican seats = ${fixed.R} + Republican wins. Democrats need ${51 - fixed.D - fixed.I} contested wins to reach 51. Republicans need ${50 - fixed.R} contested wins to reach 50 if they retain the vice-presidential tie-break. With a ${current.D + current.I}-seat Democratic caucus, ${51 - current.D - current.I} net gains reach 51; each Democratic-held seat lost requires one additional gain. These are conditional counting identities, not win forecasts. Unknown independent caucus intentions must remain separate.`);
  } else out.push("", "Official 100-seat roster was not parsed; fixed-seat totals are withheld. Do not invent the baseline from a partial race list.");
  return out.join("\n");
}

/** Assemble the Senate synthesis from validated counts, preserving model dossiers separately. */
export function renderSenateReport(event: PolymarketEvent, asOf: string, odds: RaceOddsSnapshot[], roster: SenateRoster): string {
  const dBase = roster.current.D + roster.current.I;
  const rBase = roster.current.R;
  const requiredNetGains = 51 - dBase;
  const out = [`# ${event.title}`, "", `**Market metadata cutoff:** ${asOf}. Evidence was retrieved during the run; individual observation timestamps are shown below.`, "", "## Resolution contract", "", event.description ?? "See frozen event metadata.", "", `[Market contract](https://polymarket.com/event/${event.slug})`, "", renderSenateEvidence(odds, roster), "", "## Paths to control", "", `Under the stated assumption that the current independents stay in the Democratic caucus and no new independent winner remains outside both caucuses, let G be Democratic gains from currently Republican-held seats and L be losses of currently Democratic-held seats. The resulting caucus counts are D = ${dBase} + G − L and R = ${rBase} − G + L. Democratic outright control requires G − L ≥ ${requiredNetGains}. Republican control with a Republican vice-presidential tie-break requires G − L ≤ ${requiredNetGains - 1}. These are counting conditions, not forecasts.`, "", "| Democratic-held seats lost | Gains needed from Republican-held seats for 51 D-caucus seats | Result at that threshold |", "| --- | --- | --- |"];
  for (let losses = 0; losses <= 3; losses++) out.push(`| ${losses} | ${requiredNetGains + losses} | 51 D / 49 R |`);
  out.push("", "### Concrete conditional examples", "", "Each row assumes all other seats keep their current caucus alignment, including all unlisted Democratic defenses. A Democratic win in a Republican-held seat is a flip even when its quoted probability is high; it is never a Democratic hold. These examples illustrate alternative paths rather than an exhaustive enumeration of all 35-race combinations.", "", "| Democratic gains in currently Republican-held seats | Democratic-held seats lost | D / R caucus seats | Control under Republican VP assumption |", "| --- | --- | --- | --- |");
  const scenarios = [
    { gains: ["Maine", "North Carolina", "Texas", "Ohio"], losses: [] },
    { gains: ["Maine", "North Carolina", "Alaska", "Texas"], losses: [] },
    { gains: ["Maine", "North Carolina", "Alaska", "Ohio"], losses: [] },
    { gains: ["Maine", "North Carolina", "Iowa", "Texas"], losses: [] },
    { gains: ["Maine", "North Carolina", "Alaska", "Texas", "Ohio"], losses: ["Michigan"] },
    { gains: ["Maine", "North Carolina", "Alaska", "Iowa", "Texas", "Ohio"], losses: ["Michigan", "New Hampshire"] },
    { gains: ["Maine", "North Carolina", "Texas"], losses: [] },
    { gains: ["Maine", "North Carolina", "Texas", "Ohio"], losses: ["Michigan"] },
  ];
  for (const scenario of scenarios) {
    if (!scenario.gains.every(state => roster.rows.some(r => r.state === state && r.contested && r.party === "Republican")) || !scenario.losses.every(state => roster.rows.some(r => r.state === state && r.contested && r.party === "Democratic"))) continue;
    const gain = scenario.gains.length - scenario.losses.length;
    const d = dBase + gain, r = rBase - gain;
    out.push(`| ${scenario.gains.join(", ")} | ${scenario.losses.join(", ") || "None"} | ${d} / ${r} | ${d >= 51 ? "Democratic" : r >= 50 ? "Republican" : "Apply contract fallback"} |`);
  }
  out.push("", "### Reference odds for potential flips and exposed defenses", "", "The following screen selects individual Democratic race-win quotes between 10% and 90%, plus higher-priced Democratic chances in Republican-held seats. It is a transparent way to find scenarios to inspect, not a national forecast or a claim that other races cannot matter. Named outcomes without a party label remain in the full table and dossiers rather than being assigned a party by guesswork.", "", "| State | Current holder's party | Exact Democratic win quote | Scenario role |", "| --- | --- | --- | --- |");
  for (const race of odds) {
    const holder = roster.rows.find(r => r.state === race.state && r.contested);
    const quote = race.quotes.find(q => /Democrat|\(D\)/i.test(q.name + " " + q.question));
    if (!holder || !quote || quote.yesProbability < 0.1 || (holder.party === "Democratic" && quote.yesProbability > 0.9)) continue;
    out.push(`| ${race.state} | ${holder.party} | ${(quote.yesProbability * 100).toFixed(1)}% [Source ${race.sourceNumber}](${race.url}) | ${holder.party === "Republican" ? "Potential Democratic flip" : "Democratic defense; a loss raises the required flips by one"} |`);
  }
  out.push("", "## Dependencies, counterevidence and gaps", "", "- The Texas and Ohio quotes describe each state's election. They are not combined into a national probability. Shared turnout, economic conditions, polling errors and campaign developments can move several races together; multiplying their marginal probabilities would assume independence without evidence.", "- The full table includes Alaska's named candidate quotes and Nebraska's independent outcome. An independent win must be evaluated using evidence of the winner's caucus intentions. Do not automatically credit independent-win odds to Democrats, and do not remove independent voting seats from the chamber's denominator. If ordinary majority and VP criteria fail, apply the contract's President Pro Tempore fallback.", "- Polling shares, primary results, forecast-model outputs and prediction-market prices measure different things. The component dossiers supply candidate and polling context; a poll share must not replace a win-probability quote.", "- General-election procedures require state-specific sources. A primary runoff or a market's generic reference to runoffs does not prove that a general-election runoff is possible. Individual model-written dossiers remain subject to factual review on this point and on candidate biographies.", "- The roster is a current snapshot. Party changes before Election Day, qualifying special elections scheduled by the contract's cutoff, and independently elected senators' caucus decisions can change the counting inputs.", "- API quotes are displayed only for eligible, priced outcomes with verified state/year identity. A missing quote is an evidence gap, not a zero probability. The JSON artifacts preserve raw snapshots and liquidity. Dates describe retrieval/observation, not authenticated historical availability.", "", "## Individual race evidence", "", "Every researched race has a separate dossier below. These model-written analyses are retained for review; the structured odds and seat arithmetic above are rendered from the saved inputs rather than regenerated by the writer.");
  return out.join("\n");
}
