import type { SourceDocument } from "./types.ts";

export type EvidencePolicy = "disclose" | "strict";
export interface EvidenceDecision { url: string; reason: string; }
export interface EvidenceSelection {
  sources: SourceDocument[];
  excluded: EvidenceDecision[];
  warnings: string[];
}

const UNKNOWN_PUBLICATION_WARNING = "Some evidence has unknown or invalid publication dates; historical availability is unverified.";
const LATE_SNAPSHOT_WARNING = "Some snapshots were retrieved after the cutoff or lack a valid retrieval time; they may include later revisions.";
const SNIPPET_WARNING = "Search snippets are discovery clues, not verified page evidence.";
const TRACKING_PARAMETER = /^utm_|^(fbclid|gclid)$/i;

export function canonicalSourceUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMETER.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString().replace(/\/$/, "");
  } catch { return value; }
}

interface SourceTiming { published: number; retrieved: number; cutoff: number; }

function timingOf(source: SourceDocument, cutoff: number): SourceTiming {
  return { published: Date.parse(source.publishedAt ?? ""), retrieved: Date.parse(source.retrievedAt), cutoff };
}

function ineligibilityReason(source: SourceDocument, timing: SourceTiming, policy: EvidencePolicy): string | undefined {
  if (!source.text.trim()) return "Empty evidence";
  if (timing.published > timing.cutoff) return "Publication is after cutoff";
  if (policy !== "strict") return undefined;
  if (!Number.isFinite(timing.retrieved) || timing.retrieved > timing.cutoff) return "No snapshot retrieved by cutoff";
  if (!Number.isFinite(timing.published)) return "Publication date is missing or invalid";
  return undefined;
}

function warningsFor(source: SourceDocument, timing: SourceTiming): string[] {
  const warnings: string[] = [];
  if (!Number.isFinite(timing.published)) warnings.push(UNKNOWN_PUBLICATION_WARNING);
  if (!Number.isFinite(timing.retrieved) || timing.retrieved > timing.cutoff) warnings.push(LATE_SNAPSHOT_WARNING);
  if (source.retrievalKind === "snippet") warnings.push(SNIPPET_WARNING);
  return warnings;
}

const RETRIEVAL_QUALITY = { page: 2, snippet: 0 } as const;

function retrievalQuality(source: SourceDocument): number {
  return RETRIEVAL_QUALITY[source.retrievalKind as keyof typeof RETRIEVAL_QUALITY] ?? 1;
}

function keep(selected: Map<string, SourceDocument>, source: SourceDocument, excluded: EvidenceDecision[]): void {
  const key = canonicalSourceUrl(source.url);
  const previous = selected.get(key);
  if (previous && retrievalQuality(source) <= retrievalQuality(previous)) {
    excluded.push({ url: source.url, reason: "Duplicate URL" });
    return;
  }
  if (previous) excluded.push({ url: previous.url, reason: "Replaced by a fuller snapshot of the same URL" });
  selected.set(key, source);
}

export function selectEvidence(input: SourceDocument[], asOf: string, policy: EvidencePolicy = "disclose"): EvidenceSelection {
  const cutoff = Date.parse(asOf);
  if (!Number.isFinite(cutoff)) throw new Error("Invalid evidence cutoff.");
  const excluded: EvidenceDecision[] = [];
  const warnings = new Set<string>();
  const selected = new Map<string, SourceDocument>();
  for (const source of input) {
    const timing = timingOf(source, cutoff);
    const reason = ineligibilityReason(source, timing, policy);
    if (reason) { excluded.push({ url: source.url, reason }); continue; }
    for (const warning of warningsFor(source, timing)) warnings.add(warning);
    keep(selected, source, excluded);
  }
  return { sources: [...selected.values()], excluded, warnings: [...warnings] };
}
