import type { SourceDocument } from "./types.ts";

export interface ArenaRow {
  rank: number;
  rankLow: number;
  rankHigh: number;
  model: string;
  provider: string;
  score: number;
  scoreUncertainty: number;
  votes: number;
  preliminary: boolean;
  evidence: string;
}

export interface ArenaSnapshot {
  status: "valid" | "invalid";
  sourceUrl: string;
  sourceNumber: number;
  retrievedAt: string;
  dataDate?: string;
  declaredModels?: number;
  completeBoard: boolean;
  rows: ArenaRow[];
  issues: string[];
}

export function isArenaTarget(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "arena.ai" && parsed.pathname.replace(/\/$/, "") === "/leaderboard/text/overall-no-style-control" && !parsed.search;
  } catch { return false; }
}

const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export const ENGLISH_DATE = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})\b/gi;

export function parseEnglishDate(value: string): string | undefined {
  const match = new RegExp(ENGLISH_DATE.source, "i").exec(value);
  if (!match) return undefined;
  const month = months.indexOf(match[1]!.slice(0, 3).toLowerCase());
  const iso = `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : undefined;
}

const PROVIDERS = ["Thinking Machines", "Anthropic", "Google", "Meta", "Alibaba", "Moonshot", "OpenAI", "SpaceXAI", "xAI", "Z.ai", "Baidu", "Xiaomi", "DeepSeek", "Bytedance", "ByteDance", "Amazon", "Nvidia", "Tencent", "Thinky", "MiniMax", "Mistral", "Meituan", "StepFun", "Microsoft", "01.AI", "Cohere", "AI21 Labs", "Reka", "Allen AI", "Nexusflow", "Nous Research", "Snowflake", "Databricks"];

const TABLE_HEADER = "Rank Rank Spread Model Score Votes Price $/M Context";
const ROW_BOUNDARY = /(?:^|\s)(\d{1,4}) (\d{1,4}) (\d{1,4}) (?=[A-Za-z])/g;
const ROW = /^(\d+) (\d+) (\d+) (.+?) · (.+?) (\d{3,4}(?:\.\d+)?) ±\s*(\d+(?:\.\d+)?) (Preliminary )?((?:\d{1,3}(?:,\d{3})+|\d+)) (?:(?:\$[\d,.]+ \/ \$[\d,.]+)|N\/A) (?:[\d.]+[KM]|N\/A)(?:\s|$)/;
const MINIMUM_ROWS = 20;

function normalizeArenaText(raw: string): string {
  return raw.replace(/&nbsp;|&#160;/g, " ").replace(/&plusmn;|&#177;/g, "±").replace(/&middot;|&#183;/g, "·").replace(/\s+/g, " ").trim();
}

function readBoardMetadata(prefix: string): { dataDate?: string; declaredModels?: number } {
  const dateMatches = [...prefix.matchAll(new RegExp(ENGLISH_DATE.source, "gi"))];
  return {
    dataDate: dateMatches.length ? parseEnglishDate(dateMatches.at(-1)![0]) : undefined,
    declaredModels: Number(/([\d,]+) models\b/.exec(prefix)?.[1]?.replace(/,/g, "")) || undefined,
  };
}

function splitIdentity(identity: string): { model: string; provider: string } | undefined {
  const provider = PROVIDERS.find((candidate) => identity.endsWith(` ${candidate}`));
  if (!provider) return undefined;
  const named = identity.slice(0, -(provider.length + 1));
  const model = named.startsWith(`${provider} `) ? named.slice(provider.length + 1) : named;
  return { model, provider };
}

function isConsistentRow(row: ArenaRow, expectedRank: number): boolean {
  if (!row.model) return false;
  if (row.rank !== expectedRank) return false;
  if (row.rankLow > row.rank || row.rankHigh < row.rank) return false;
  return row.votes >= 1;
}

function parseRow(rowText: string, expectedRank: number): ArenaRow | undefined {
  const match = ROW.exec(rowText);
  if (!match) return undefined;
  const identity = splitIdentity(match[4]!);
  if (!identity) return undefined;
  const row: ArenaRow = { rank: Number(match[1]), rankLow: Number(match[2]), rankHigh: Number(match[3]), model: identity.model, provider: identity.provider, score: Number(match[6]), scoreUncertainty: Number(match[7]), preliminary: Boolean(match[8]), votes: Number(match[9]!.replace(/,/g, "")), evidence: match[0].trim() };
  return isConsistentRow(row, expectedRank) ? row : undefined;
}

function parseRows(table: string): ArenaRow[] {
  const boundaries = [...table.matchAll(ROW_BOUNDARY)];
  const rows: ArenaRow[] = [];
  for (let index = 0; index < boundaries.length; index++) {
    const rowText = table.slice(boundaries[index]!.index, boundaries[index + 1]?.index ?? table.length).trim();
    const row = parseRow(rowText, rows.length + 1);
    if (!row) break;
    rows.push(row);
  }
  return rows;
}

export function extractArenaSnapshot(source: SourceDocument, sourceNumber = 1): ArenaSnapshot {
  const snapshot: ArenaSnapshot = { status: "invalid", sourceUrl: source.url, sourceNumber, retrievedAt: source.retrievedAt, completeBoard: false, rows: [], issues: [] };
  const fail = (message: string) => { snapshot.issues.push(message); return snapshot; };
  if (!isArenaTarget(source.url) || source.retrievalKind !== "page") return fail("Target leaderboard must be a fetched page, not a snippet or different category.");
  const text = normalizeArenaText(source.text);
  const start = text.indexOf(TABLE_HEADER);
  if (start < 0) return fail("Unrecognized Arena table header; structured table withheld.");
  Object.assign(snapshot, readBoardMetadata(text.slice(0, start)));
  if (!snapshot.dataDate) return fail("Leaderboard data date unavailable or invalid; retrieval date cannot substitute for it.");
  snapshot.rows = parseRows(text.slice(start + TABLE_HEADER.length).trim());
  if (snapshot.rows.length < MINIMUM_ROWS) {
    snapshot.rows = [];
    return fail("Could not validate 20 contiguous rows with separate rank range, score uncertainty, votes and provider. No partial table published.");
  }
  snapshot.status = "valid";
  snapshot.completeBoard = snapshot.rows.length === snapshot.declaredModels;
  if (!snapshot.completeBoard) snapshot.issues.push(`Only ${snapshot.rows.length} contiguous rows parsed; absence is not evidence of absence from the full board.`);
  return snapshot;
}

export function compareBoardDate(boardDate: string | undefined, eventDate: string | undefined): "before" | "same_day" | "after" | "unknown" {
  const valid = (value?: string) => !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!valid(boardDate) || !valid(eventDate)) return "unknown";
  return boardDate! < eventDate! ? "before" : boardDate! > eventDate! ? "after" : "same_day";
}

export function renderArenaSnapshot(snapshot: ArenaSnapshot): string {
  if (snapshot.status !== "valid") return `## Leaderboard extraction unavailable\n\n${snapshot.issues.join(" ")}\n`;
  const safe = (value: string) => value.replace(/[|\r\n]/g, " ");
  const rows = snapshot.rows.slice(0, MINIMUM_ROWS).map(r => `| ${r.rank} | ${safe(r.model)} | ${safe(r.provider)} | ${r.score} | ±${r.scoreUncertainty} | ${r.rankLow}–${r.rankHigh} | ${r.votes.toLocaleString("en-US")} | ${r.preliminary ? "Preliminary" : "Not marked"} |`);
  return `## Verified extraction: top 20 leaderboard rows\n\nBoard data date: **${snapshot.dataDate}**. Retrieved: ${snapshot.retrievedAt}. [Source ${snapshot.sourceNumber}](${snapshot.sourceUrl}). This is a dated snapshot, not a claim of current live freshness.\n\n| Rank | Model | Provider | Score | Score uncertainty | Rank range | Votes | Explicit marker |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n\n“Not marked” means no Preliminary marker in the parsed row; it does not certify stability or eligibility. Score uncertainty and rank range are different fields. ${snapshot.issues.join(" ")}\n`;
}
