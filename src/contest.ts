import type { PolymarketEvent, PolymarketMarket } from "./types.ts";

export interface Contest {
  sides: [string, string];
  competition?: string;
  league?: string;
}

const MAIN_MARKET_TYPES = new Set(["moneyline"]);
const NAMED_LEAGUES = new Set(["nba", "wnba", "nfl", "mlb", "nhl", "ufc"]);
const ESPORTS = new Set(["lol", "cs2", "csgo", "dota2", "val", "valorant", "mlbb", "r6"]);
const TITLE_SIDES = /^(?:[^:]{1,40}:\s*)?(.+?)\s+(?:vs\.?|v\.?|@)\s+(.+?)(?:\s*\(BO\d\))?(?:\s+-\s+(.+))?$/i;
const MAX_SIDE_LENGTH = 60;

export const CONTEST_BETTING = /\b(?:odds|moneyline|money line|sportsbooks?|bookmakers?|implied (?:probability|chance)|point spread|spread|over\/under|o\/u|totals? line|betting|bets?|wagers?|parlay|picks?|prediction|predicted|favou?red|favou?rites?|underdogs?|draftkings|fanduel|bet365|betmgm|caesars)\b|(?:^|\s)[+-]\d{3,4}\b/i;

function rawRecord(event: PolymarketEvent): Record<string, unknown> {
  return event.raw && typeof event.raw === "object" ? event.raw as Record<string, unknown> : {};
}

function teamNames(raw: Record<string, unknown>): [string, string] | undefined {
  if (!Array.isArray(raw.teams)) return undefined;
  const names = raw.teams
    .map(team => (team as { name?: unknown } | null)?.name)
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0);
  return names.length === 2 ? [names[0]!.trim(), names[1]!.trim()] : undefined;
}

function leagueOf(raw: Record<string, unknown>, slug: string): string | undefined {
  const team = Array.isArray(raw.teams) ? raw.teams[0] as { league?: unknown } | undefined : undefined;
  const league = typeof team?.league === "string" ? team.league.toLowerCase() : slug.split("-")[0];
  return league || undefined;
}

function sportsMarketType(market: PolymarketMarket): string | undefined {
  const value = (market as { sportsMarketType?: unknown }).sportsMarketType;
  return typeof value === "string" ? value : undefined;
}

export function isSportsEvent(event: PolymarketEvent): boolean {
  const raw = rawRecord(event);
  const hasGameId = raw.gameId !== undefined && raw.gameId !== null;
  return hasGameId || (event.markets ?? []).some(m => sportsMarketType(m) !== undefined);
}

function titleContest(title: string): Contest | undefined {
  const match = TITLE_SIDES.exec(title.trim());
  const [first, second, competition] = [match?.[1]?.trim(), match?.[2]?.trim(), match?.[3]?.trim()];
  if (!first || !second || first.length > MAX_SIDE_LENGTH || second.length > MAX_SIDE_LENGTH) return undefined;
  return competition ? { sides: [first, second], competition } : { sides: [first, second] };
}

export function contestOf(event: PolymarketEvent): Contest | undefined {
  if (!isSportsEvent(event)) return undefined;
  const raw = rawRecord(event);
  const fromTitle = titleContest(event.title);
  const sides = teamNames(raw) ?? fromTitle?.sides;
  if (!sides) return undefined;
  const league = leagueOf(raw, event.slug);
  return { sides, ...(fromTitle?.competition ? { competition: fromTitle.competition } : {}), ...(league ? { league } : {}) };
}

function newsTerms(contest: Contest): string {
  return ESPORTS.has(contest.league ?? "") ? "roster news stand-in" : "team news injuries";
}

function leagueLabel(contest: Contest): string {
  return NAMED_LEAGUES.has(contest.league ?? "") ? ` ${contest.league!.toUpperCase()}` : "";
}

export function contestQueries(contest: Contest, effort: "low" | "medium" | "high"): string[] {
  const [a, b] = contest.sides;
  const label = leagueLabel(contest);
  const news = newsTerms(contest);
  const preview = `${a} vs ${b}${label} preview`;
  if (effort === "low") return [preview, `${a} ${b}${label} ${news}`];
  const queries = [preview, `${a}${label} ${news}`, `${b}${label} ${news}`, `${a} vs ${b} head to head recent form`];
  if (effort !== "high") return queries;
  const scope = contest.competition ?? label.trim();
  return [...queries, `${a} recent results ${scope}`.trim(), `${b} recent results ${scope}`.trim()];
}

export function mainContestMarkets(markets: PolymarketMarket[]): PolymarketMarket[] {
  const main = markets.filter(m => MAIN_MARKET_TYPES.has(sportsMarketType(m) ?? ""));
  return main.length > 0 ? main : markets;
}
