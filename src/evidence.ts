import type { SourceDocument } from "./types.ts";

export type EvidencePolicy = "disclose" | "strict";
export interface EvidenceDecision { url: string; reason: string; }
export interface EvidenceSelection {
  sources: SourceDocument[];
  excluded: EvidenceDecision[];
  warnings: string[];
}

/** Preserve semantic query parameters; only remove fragments and known tracking parameters. */
export function canonicalSourceUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString().replace(/\/$/, "");
  } catch { return value; }
}

/** Filter before deduplication so an ineligible duplicate cannot hide valid evidence. */
export function selectEvidence(input: SourceDocument[], asOf: string, policy: EvidencePolicy = "disclose"): EvidenceSelection {
  const cutoff = Date.parse(asOf);
  if (!Number.isFinite(cutoff)) throw new Error("Invalid evidence cutoff.");
  const excluded: EvidenceDecision[] = [];
  const warnings = new Set<string>();
  const selected = new Map<string, SourceDocument>();
  for (const source of input) {
    const published = Date.parse(source.publishedAt ?? "");
    const retrieved = Date.parse(source.retrievedAt);
    let reason: string | undefined;
    if (!source.text.trim()) reason = "Empty evidence";
    else if (published > cutoff) reason = "Publication is after cutoff";
    else if (policy === "strict" && (!Number.isFinite(retrieved) || retrieved > cutoff)) reason = "No snapshot retrieved by cutoff";
    else if (policy === "strict" && !Number.isFinite(published)) reason = "Publication date is missing or invalid";
    if (reason) { excluded.push({ url: source.url, reason }); continue; }
    if (!Number.isFinite(published)) warnings.add("Some evidence has unknown or invalid publication dates; historical availability is unverified.");
    if (!Number.isFinite(retrieved) || retrieved > cutoff) warnings.add("Some snapshots were retrieved after the cutoff or lack a valid retrieval time; they may include later revisions.");
    if (source.retrievalKind === "snippet") warnings.add("Search snippets are discovery clues, not verified page evidence.");
    const key = canonicalSourceUrl(source.url);
    const previous = selected.get(key);
    const quality = (s: SourceDocument) => (s.retrievalKind === "page" ? 2 : s.retrievalKind === "snippet" ? 0 : 1);
    if (!previous || quality(source) > quality(previous)) {
      if (previous) excluded.push({ url: previous.url, reason: "Replaced by a fuller snapshot of the same URL" });
      selected.set(key, source);
    } else excluded.push({ url: source.url, reason: "Duplicate URL" });
  }
  return { sources: [...selected.values()], excluded, warnings: [...warnings] };
}
