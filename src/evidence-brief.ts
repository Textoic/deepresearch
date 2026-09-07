import { compareBoardDate, ENGLISH_DATE, isArenaTarget, parseEnglishDate, type ArenaSnapshot } from "./arena.ts";
import type { SourceDocument } from "./types.ts";

export interface EvidencePassage { start: number; end: number; text: string; }
export interface LabEvidence {
  lab: string;
  documents: Array<{ sourceNumber: number; url: string; kind: string; documentDate?: string; datePassage?: EvidencePassage; boardRelation: ReturnType<typeof compareBoardDate>; passages: EvidencePassage[] }>;
  gaps: string[];
}
export interface ArenaEvidenceBrief {
  labs: LabEvidence[];
  policy: Array<{ sourceNumber: number; url: string; passages: EvidencePassage[] }>;
  warnings: string[];
}

function hostname(url: string): string { try { return new URL(url).hostname; } catch { return ""; } }
const labs = [
  { name: "Anthropic", hosts: ["anthropic.com"], model: /claude|fable|mythos/i },
  { name: "OpenAI", hosts: ["openai.com"], model: /gpt|astra/i },
  { name: "Google", hosts: ["blog.google", "deepmind.google"], model: /gemini/i },
  { name: "xAI / SpaceXAI (Grok)", hosts: ["x.ai"], model: /grok/i },
];
function passage(text: string, start: number, length: number): EvidencePassage {
  const from = Math.max(0, start);
  return { start: from, end: Math.min(text.length, from + length), text: text.slice(from, from + length) };
}

// Excerpts are discovery/claim evidence, not an automatic semantic verdict.
export function buildArenaEvidenceBrief(sources: SourceDocument[], snapshot: ArenaSnapshot, asOf: string): ArenaEvidenceBrief {
  const warnings = [
    `Board data date ${snapshot.dataDate ?? "unknown"}; run cutoff ${asOf}. Retrieval time is NOT the board data date.`,
    "A document date is not automatically a public release date. Preserve access restrictions and verify which model the passage describes.",
    "A board snapshot predating a model's release cannot establish its post-release performance or listing lag. Same-day dates establish no intraday ordering.",
    "Do not treat absence from extracted rows as poor performance. No empirical release-to-first-listing lag has been measured by this extraction.",
  ];
  const policy = sources.flatMap((source, i) => {
    if (hostname(source.url) !== "arena.ai" || !/\/blog\/policy\/?$/.test(new URL(source.url).pathname) || source.retrievalKind !== "page") return [];
    const passages = ["Listing models on the leaderboard", "Evaluating publicly released models", "Evaluating unreleased models"].flatMap(term => {
      const heading = source.text.indexOf(`${term} .`);
      const offset = heading >= 0 ? heading : source.text.indexOf(term);
      if (offset < 0) return [];
      return [passage(source.text, offset, term.startsWith("Listing") ? 2700 : 1400)];
    });
    return [{ sourceNumber: i + 1, url: source.url, passages }];
  });
  return { warnings, policy, labs: labs.map(lab => {
    const candidates = sources.flatMap((source, i) => {
      const host = hostname(source.url);
      if (!lab.hosts.some(h => host === h || host.endsWith(`.${h}`))) return [];
      // Skip aggregated changelogs/category indexes: their first date need not date an announcement.
      if (/release-notes|\/migration\/|\/news\/?$/.test(source.url)) return [];
      const releases = [...source.text.matchAll(/(?:today[ ,]+)?we(?:['’]re| are) (?:releasing|introducing)|today.{0,25}(?:releasing|introducing)|(?:is|are) (?:generally )?available (?:today|now)/gi)]
        .filter(match => lab.model.test(source.text.slice(Math.max(0, match.index! - 100), match.index! + 260)));
      if (!releases.length && source.retrievalKind !== "snippet") return [];
      const anchor = releases[0]?.index ?? 0;
      const published = new RegExp(`Published\\s+(${ENGLISH_DATE.source})`, "i").exec(source.text);
      const nearbyDates = [...source.text.slice(Math.max(0, anchor - 1500), anchor).matchAll(new RegExp(ENGLISH_DATE.source, "gi"))];
      const nearby = nearbyDates.at(-1);
      const dateOffset = published?.index ?? (nearby ? Math.max(0, anchor - 1500) + nearby.index! : undefined);
      const datePassage = dateOffset === undefined ? undefined : passage(source.text, dateOffset, 100);
      const documentDate = datePassage && parseEnglishDate(datePassage.text);
      if (documentDate && documentDate > asOf.slice(0, 10)) return [];
      const passages = releases.length ? releases.slice(0, 2).map(m => passage(source.text, Math.max(0, m.index! - 100), 1100)) : [passage(source.text, 0, 500)];
      const boardRelation = compareBoardDate(snapshot.dataDate, documentDate);
      return [{ sourceNumber: i + 1, url: source.url, kind: source.retrievalKind ?? "unspecified", documentDate, datePassage, boardRelation, passages }];
    });
    // Reserve a small, bounded evidence budget per lab, preferring actual pages to snippets.
    const documents = candidates.sort((a, b) => Number(b.kind === "page") - Number(a.kind === "page") || (b.documentDate ?? "").localeCompare(a.documentDate ?? "")).slice(0, 2);
    return { lab: lab.name, documents, gaps: [
      ...(documents.some(d => d.kind === "page") ? [] : ["No primary-page release passage extracted; snippets alone do not verify release."]),
      "First Arena listing date and empirical release-to-listing lag have not been established.",
      "Future launch before cutoff and first-place potential require separate evidence, not extrapolation from a release or market price.",
    ] };
  }) };
}

export function arenaSupportingText(sources: SourceDocument[]): string {
  // Dedicated method/policy/release evidence replaces broad, repetitive discovery snippets.
  return sources.flatMap((source, i) => hostname(source.url) === "arena.ai" && !isArenaTarget(source.url) && /\/faq\/?$|\/blog\/extended-arena\/?$/.test(new URL(source.url).pathname)
    ? [`SOURCE ${i + 1} (${source.retrievalKind ?? "unspecified"}) ${source.url}\n${source.text.slice(0, 10000)}`] : []).join("\n\n");
}
