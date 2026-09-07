import { eligibleMarket } from "./market-policy.ts";
import type { PolymarketEvent, PolymarketMarket, ResearchUnit, SourceDocument } from "./types.ts";

export interface RaceQuote { name: string; question: string; yesProbability: number; liquidity?: string | number; }

export interface RaceOddsSnapshot {
  race: string;
  state: string;
  url?: string;
  retrievedAt: string;
  sourceNumber?: number;
  quotes: RaceQuote[];
  limitation?: string;
  raw?: unknown;
}

type PricedMarket = PolymarketMarket & { acceptingOrders?: boolean; liquidity?: string | number };

const GAMMA_TIMEOUT_MS = 15000;
const SPECIAL_ELECTION_STATES = ["Florida", "Ohio"];
const CONTESTED_SEATS = 35;
const SENATE_SEATS = 100;

function array(value: unknown): unknown[] {
  try { const parsed = typeof value === "string" ? JSON.parse(value) : value; return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function identifiesRace(event: Record<string, unknown> | undefined, slug: string, state: string): boolean {
  const title = typeof event?.title === "string" ? event.title : "";
  if (event?.slug !== slug || !/senate/i.test(title)) return false;
  return title.toLowerCase().includes(state.toLowerCase()) && String(event.endDate).startsWith("2026-");
}

function isRetired(event: Record<string, unknown>): boolean {
  return event.active === false || event.closed === true || event.archived === true;
}

function assertRaceIdentity(event: Record<string, unknown> | undefined, slug: string, state: string): asserts event is Record<string, unknown> {
  if (!identifiesRace(event, slug, state)) throw new Error("No identity-matching 2026 race event");
  if (isRetired(event!)) throw new Error("Underlying event inactive, closed or archived");
}

function describesRace(market: PricedMarket, state: string): boolean {
  if (!eligibleMarket(market) || market.acceptingOrders === false) return false;
  const question = market.question ?? "";
  return question.includes("2026") && question.toLowerCase().includes(state.toLowerCase()) && /senate/i.test(question);
}

function yesPrice(market: PricedMarket): number | undefined {
  const outcomes = array(market.outcomes);
  const prices = array(market.outcomePrices);
  const index = outcomes.findIndex(outcome => typeof outcome === "string" && outcome.toLowerCase() === "yes");
  if (index < 0) return undefined;
  const raw = prices[index];
  if (raw === null || raw === undefined || raw === "") return undefined;
  const price = Number(raw);
  return Number.isFinite(price) && price >= 0 && price <= 1 ? price : undefined;
}

function raceQuotes(event: Record<string, unknown>, state: string): RaceQuote[] {
  const markets = (Array.isArray(event.markets) ? event.markets : []) as PricedMarket[];
  return markets.filter(market => describesRace(market, state)).flatMap(market => {
    const price = yesPrice(market);
    return price === undefined ? [] : [{ name: market.groupItemTitle ?? market.question!, question: market.question!, yesProbability: price, liquidity: market.liquidity }];
  });
}

function quotesText(title: string, snapshot: RaceOddsSnapshot): string {
  const preamble = `Identity-checked underlying event: ${title}. Year: 2026. Observation time: ${snapshot.retrievedAt}. These are race-specific YES prices, not national control forecasts. Prices are unnormalized reference probabilities, not poll vote shares or guaranteed outcomes. Separate binary prices need not sum to 100%.`;
  return `${preamble}\n${snapshot.quotes.map(quote => `${quote.name}: ${quote.yesProbability * 100}% YES to "${quote.question}". Reported liquidity: ${quote.liquidity ?? "unknown"}.`).join("\n")}`;
}

async function loadRaceEvent(url: string, fetchFn: typeof fetch): Promise<Record<string, unknown> | undefined> {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(GAMMA_TIMEOUT_MS), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Gamma ${response.status}`);
  const payload: unknown = await response.json();
  return Array.isArray(payload) ? payload[0] as Record<string, unknown> | undefined : undefined;
}

export async function fetchRaceOdds(unit: ResearchUnit, target: PolymarketEvent, fetchFn: typeof fetch = fetch): Promise<{ snapshot: RaceOddsSnapshot; source?: SourceDocument }> {
  const state = unit.name.replace(/ (?:regular|special) Senate election 2026$/, "");
  const snapshot: RaceOddsSnapshot = { race: unit.name, state, retrievedAt: new Date().toISOString(), quotes: [] };
  if (unit.kind !== "race" || !/Senate election 2026$/.test(unit.name)) return { snapshot: { ...snapshot, limitation: "Not a supported underlying race" } };
  const slug = `${state.toLowerCase().replaceAll(" ", "-")}-senate-election-winner`;
  if (slug === target.slug) return { snapshot: { ...snapshot, limitation: "Refused target-event odds" } };
  const url = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`;
  try {
    const event = await loadRaceEvent(url, fetchFn);
    assertRaceIdentity(event, slug, state);
    snapshot.quotes = raceQuotes(event, state);
    snapshot.raw = event;
    snapshot.url = url;
    if (!snapshot.quotes.length) throw new Error("No eligible priced underlying outcomes");
    const text = quotesText(String(event.title), snapshot);
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

type RosterRow = SenateRoster["rows"][number];

const ROSTER_URL = /^https:\/\/www\.senate\.gov\/senators\/?(?:[?#].*)?$/;

function parseRosterRow(line: string): RosterRow[] {
  const fields = line.split("|").map(field => field.trim());
  if (fields.length < 4 || !/^(Democratic|Republican|Independent)$/.test(fields[2]!)) return [];
  const senateClass = Number(fields[3]!.match(/^[123]/)?.[0]);
  if (!senateClass) return [];
  const contested = senateClass === 2 || (senateClass === 3 && SPECIAL_ELECTION_STATES.includes(fields[1]!));
  return [{ name: fields[0]!, state: fields[1]!, party: fields[2] as RosterRow["party"], senateClass, contested }];
}

function isCompleteRoster(rows: RosterRow[]): boolean {
  if (rows.length !== SENATE_SEATS) return false;
  if (new Set(rows.map(row => row.state + row.senateClass)).size !== SENATE_SEATS) return false;
  return rows.filter(row => row.contested).length === CONTESTED_SEATS;
}

function countParties(rows: RosterRow[]) {
  return { R: rows.filter(row => row.party === "Republican").length, D: rows.filter(row => row.party === "Democratic").length, I: rows.filter(row => row.party === "Independent").length };
}

function rosterFrom(source: SourceDocument, sourceNumber: number): SenateRoster | undefined {
  if (!ROSTER_URL.test(source.url) || source.retrievalKind !== "page") return undefined;
  const rows = source.text.split("\n").flatMap(parseRosterRow);
  if (!isCompleteRoster(rows)) return undefined;
  return { sourceNumber, url: source.url, rows, current: countParties(rows), contested: countParties(rows.filter(row => row.contested)), fixed: countParties(rows.filter(row => !row.contested)) };
}

export function parseSenateRoster(sources: SourceDocument[]): SenateRoster | undefined {
  for (const [index, source] of sources.entries()) {
    const roster = rosterFrom(source, index + 1);
    if (roster) return roster;
  }
  return undefined;
}

