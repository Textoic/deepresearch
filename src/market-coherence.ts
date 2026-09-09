import { eligibleMarket } from "./market-policy.ts";
import { extractSourceUrls } from "./source-adapters.ts";
import { hostnameOfUrl } from "./search/excluded-hosts.ts";
import type { PolymarketEvent, PolymarketMarket, SourceDocument } from "./types.ts";

const SETTLED_PRICE = 0.9;
const MAX_LISTED_CONTRACTS = 6;

const COHERENCE_DIRECTIVE = `RESOLVED-CLAIM CROSS-CHECK: independent trading in the contracts listed below has NOT settled them, so a claim that the outcome has already occurred is, on the balance of outside information, more likely to be a misread source than a scoop. Treat any evidence that appears to settle one of these contracts as a contradiction to resolve before you rely on it. Verify, and state in the report which of these you checked: the date the described event occurred, not the date the page was retrieved or last modified, and never a date taken from a page title or search result heading, which for a live dashboard is the day it was crawled; whether a status, incident or tracker page describes a live situation or an archived historical record whose closure is stated only in its body text; whether the occurrence falls inside this contract's own window rather than an earlier one; and whether an ongoing state is asserted anywhere by a dated source rather than inferred from the absence of a closing update. An undated snippet, or a page that could not be retrieved, cannot establish that an event occurred on any particular date, however official the host. Where the evidence survives these checks, report it as it stands and say which checks it passed. Where it does not, report what the source actually establishes and on what date. Never state, quote, approximate, rank or otherwise reveal any market price, odds, probability or implied likelihood in the report, and never cite this cross-check, the listed contracts or trading activity as evidence: it is a prompt to verify dates, not a finding and not an input to any estimate.`;

function parsePriceList(value: PolymarketMarket["outcomePrices"]): number[] {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

export function referencePrice(market: PolymarketMarket): number | undefined {
  return parsePriceList(market.outcomePrices)[0];
}

export function unsettledContracts(event: PolymarketEvent): string[] {
  return (event.markets ?? [])
    .filter(eligibleMarket)
    .filter(market => {
      const price = referencePrice(market);
      return price !== undefined && price < SETTLED_PRICE;
    })
    .map(market => market.question ?? market.slug ?? market.id);
}

export function coherenceDirective(event: PolymarketEvent): string | undefined {
  const unsettled = unsettledContracts(event);
  if (!unsettled.length) return undefined;
  const listed = unsettled.slice(0, MAX_LISTED_CONTRACTS).map(question => `- ${question}`).join("\n");
  return `${COHERENCE_DIRECTIVE}\nContracts not settled by independent trading:\n${listed}`;
}

function registrableHost(url: string): string | undefined {
  return hostnameOfUrl(url)?.replace(/^www\./, "");
}

function resolutionSourceHosts(event: PolymarketEvent): Set<string> {
  const urls = extractSourceUrls(event.resolutionSource ?? "");
  return new Set(urls.map(registrableHost).filter((host): host is string => !!host));
}

export function unretrievedResolutionSource(event: PolymarketEvent, sources: SourceDocument[]): string | undefined {
  const hosts = resolutionSourceHosts(event);
  if (!hosts.size) return undefined;
  const retrieved = sources.some(source => source.retrievalKind === "page" && hosts.has(registrableHost(source.url) ?? ""));
  if (retrieved) return undefined;
  return `The designated resolution source (${[...hosts].join(", ")}) was not retrieved as a page in this run; any statement about what it currently shows, lists or classifies rests on search snippets and their titles, which are not verified page evidence. A status-page title carries the date it was crawled, not the date of the event it describes.`;
}
