import type { PolymarketEvent, PolymarketMarket, SourceDocument } from "./types.ts";

export const MARKET_RESEARCH_POLICY = `ANTI-ANCHORING POLICY: Exclude ALL prediction-market and expert odds, probabilities, price movements, favorites, rankings and forecasts of the TARGET event, including its named candidate outcomes. Do not quote, summarize, use as a baseline, or reverse-engineer these forecasts. This applies even if they occur in retrieved text. Do not produce a target-event probability yourself: this report supplies evidence for a subsequent independent forecast.
DEPENDENCY EXCEPTION: Reference odds and forecasts for DISTINCT underlying events that causally determine the target outcome are encouraged. For Senate control, state Senate races are dependencies; national Senate-control odds are forbidden. For a candidate-selection event, selection odds for each named candidate are TARGET odds and remain forbidden. Label each permitted estimate with the exact underlying proposition, source URL, observation date, available freshness and methodology/liquidity limitations. Poll vote shares are not win probabilities. Do not invent numerical odds from qualitative ratings or multiply correlated race probabilities as if independent.
Analyze causal paths, counterevidence, and missing evidence. Preserve the literal resolution rules without inventing a formal press-release requirement or new restrictions on credible reporting. An absence of qualifying evidence in this bundle is not proof no announcement occurred. The pipeline retrieved these sources; the writer uses the supplied evidence only.`;

export function eligibleMarket(m: PolymarketMarket): boolean {
  return m.active !== false && m.closed !== true && m.archived !== true;
}

export function normalizeMarketEvent(event: PolymarketEvent): PolymarketEvent {
  const markets = event.markets?.filter(eligibleMarket);
  const descriptions = [event.description, ...(markets ?? []).map(m => m.description)].filter(Boolean) as string[];
  const authorities = [...new Set(descriptions.flatMap(d => d.split(/\n\s*\n/).filter(p => /resolution sources?\b/i.test(p))))];
  return { ...event, markets, resolutionSource: event.resolutionSource?.trim() || authorities.join("\n\n") || undefined };
}

export function marketContext(event: PolymarketEvent) {
  // Raw prices and excluded markets remain only in the audit snapshot, never writer metadata.
  return { title: event.title, description: event.description, resolutionSource: event.resolutionSource, endDate: event.endDate,
    markets: event.markets?.filter(eligibleMarket).map(m => ({ question: m.question, description: m.description, endDate: m.endDate, outcomes: m.outcomes })) };
}

export function candidateName(m: PolymarketMarket): string {
  return m.groupItemTitle?.trim() || m.question?.match(/^Will (.+?) (?:be|become) (?:the )?next /i)?.[1]?.trim() || "";
}

/** Conservative sentence filtering complements the semantic prompt policy; it is not a semantic guarantee. */
export function evidenceForWriter(source: SourceDocument, event: PolymarketEvent): SourceDocument {
  if (source.dependencyOf === event.slug && /^https:\/\/gamma-api\.polymarket\.com\/events\?slug=/.test(source.url)) return source;
  const marketSite = /(?:^|\.)(?:polymarket\.com|polymarket\.us|kalshi\.com|polymarketanalytics\.com|polyrama\.io)$/.test(new URL(source.url).hostname);
  if (marketSite) return { ...source, title: "Prediction-market page withheld", text: "[Market UI withheld to avoid target-odds leakage from navigation and related markets. Use identity-checked structured underlying quotes when supplied, and frozen target resolution rules.]" };
  const targetUrl = source.url.includes(`/event/${event.slug}`) || source.url.includes(`/markets/${event.slug}`);
  const sentences = source.text.split(/(?<=[.!?])\s+|\n+/);
  const text = sentences.filter(sentence => {
    if (targetUrl) return false; // Rules are supplied from the frozen, price-free metadata.
    const forecast = /\b(?:odds|probabilit\w*|chance\w*|predict\w*|forecast\w*|favorite\w*|favourite\w*|betting|priced?|percent)\b|\d\s*%/i.test(sentence);
    if (!forecast) return true;
    const senateTarget = /senate/i.test(event.title) && /(?:control|majority|win the senate)/i.test(event.title);
    if (senateTarget && /(?:control (?:of )?(?:the )?senate|senate (?:control|majority)|win (?:the )?senate|chamber|balance of power)/i.test(sentence + " " + (source.title ?? ""))) return false;
    if (/press secretary/i.test(event.title) && /(?:odds|probabilit\w*|chance\w*|favorite\w*|favourite\w*|betting|priced?)\b|\d\s*%/i.test(sentence)) return false;
    if (/\bAGI\b/i.test(event.title) && /\bAGI\b|artificial general intelligence/i.test(sentence) && /\b(?:odds|probabilit\w*|chance\w*|betting|priced?)\b|\d\s*%/i.test(sentence)) return false;
    return true;
  }).join("\n");
  return { ...source, title: targetUrl ? "Target market: pricing withheld" : source.title, text: text || "[Target forecast content withheld; use resolution metadata.]" };
}
