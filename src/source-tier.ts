import type { SourceDocument } from "./types.ts";

export type SourceTier = 1 | 2 | 3 | 4;

export const TIER_LABELS: Record<SourceTier, string> = {
  1: "primary/official",
  2: "established newsroom",
  3: "derivative or self-published",
  4: "unverified provenance",
};

export const PROVENANCE_POLICY = `SOURCE PROVENANCE: every source carries a provenance tier. Tier 1 is a primary or official record, tier 2 an established newsroom, tier 3 a derivative, syndicated or self-published page, tier 4 a page of unverified provenance. Weight claims by tier. A load-bearing factual claim needs tier 1 or tier 2 support; when only tier 3 or tier 4 pages support it, say so in the same sentence that makes the claim and treat it as a reporting lead rather than an established fact. Several tier 3 or tier 4 pages carrying the same story are not independent corroboration. When such a page attributes its claim to another outlet, credit that outlet, state that the original was not retrieved, and do not count the rewrite as a second source. Never raise confidence because many low-tier pages repeat a claim.`;

const OFFICIAL_SUFFIXES = [".gov", ".mil", ".int", ".gov.uk", ".gc.ca", ".gov.au", ".govt.nz", ".europa.eu"];

const OFFICIAL_HOSTS = new Set([
  "mapn.ro", "presidencia.gob.ve", "en.mfa.gov.ir", "commonslibrary.parliament.uk",
  "un.org", "imf.org", "worldbank.org", "oecd.org", "who.int", "wto.org", "iaea.org", "nato.int",
  "arxiv.org", "ssrn.com", "doi.org", "nature.com", "science.org", "pnas.org", "thelancet.com",
  "courtlistener.com", "supremecourt.gov", "federalregister.gov", "sec.gov", "eur-lex.europa.eu",
  "openai.com", "anthropic.com", "deepmind.google", "ai.meta.com", "mistral.ai", "x.ai",
]);

const NEWSROOM_HOSTS = new Set([
  "reuters.com", "apnews.com", "afp.com", "bloomberg.com", "ft.com", "economist.com", "wsj.com",
  "nytimes.com", "washingtonpost.com", "latimes.com", "chicagotribune.com", "bostonglobe.com",
  "bbc.com", "bbc.co.uk", "theguardian.com", "telegraph.co.uk", "thetimes.co.uk", "independent.co.uk",
  "npr.org", "pbs.org", "cnn.com", "nbcnews.com", "cbsnews.com", "abcnews.go.com", "foxnews.com",
  "usatoday.com", "politico.com", "axios.com", "thehill.com", "semafor.com", "propublica.org",
  "nypost.com", "newsweek.com", "time.com", "theatlantic.com", "vox.com", "cnbc.com", "forbes.com",
  "businessinsider.com", "wired.com", "theverge.com", "techcrunch.com", "arstechnica.com",
  "aljazeera.com", "dw.com", "lemonde.fr", "spiegel.de", "nikkei.com", "scmp.com", "straitstimes.com",
  "statnews.com", "nj.com", "mlive.com", "baltimoresun.com", "justthenews.com", "washingtontimes.com",
]);

const DERIVATIVE_HOSTS = new Set([
  "wikipedia.org", "wikimedia.org", "wikiwand.com", "britannica.com", "ballotpedia.org",
  "msn.com", "yahoo.com", "news.yahoo.com", "inkl.com", "newsbreak.com", "ground.news", "flipboard.com",
  "x.com", "twitter.com", "facebook.com", "instagram.com", "threads.net", "bsky.app", "truthsocial.com",
  "reddit.com", "youtube.com", "medium.com", "substack.com", "linkedin.com", "quora.com",
  "mediaite.com", "realclearpolitics.com", "legistorm.com", "newsmax.com", "thedailybeast.com",
]);

function registrableDomain(hostname: string): string {
  const labels = hostname.split(".");
  return labels.length <= 2 ? hostname : labels.slice(-2).join(".");
}

function hostnameOf(url: string): string | undefined {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return undefined; }
}

function matches(hosts: Set<string>, hostname: string): boolean {
  return hosts.has(hostname) || hosts.has(registrableDomain(hostname));
}

export function classifySourceTier(url: string): SourceTier {
  const hostname = hostnameOf(url);
  if (!hostname) return 4;
  if (OFFICIAL_SUFFIXES.some(suffix => hostname === suffix.slice(1) || hostname.endsWith(suffix))) return 1;
  if (matches(OFFICIAL_HOSTS, hostname)) return 1;
  if (matches(NEWSROOM_HOSTS, hostname)) return 2;
  if (matches(DERIVATIVE_HOSTS, hostname)) return 3;
  return 4;
}

export function tierOf(source: SourceDocument): SourceTier {
  return source.sourceTier ?? classifySourceTier(source.url);
}

const ATTRIBUTION = /\b(?:according to|first reported by|as reported by|reported by|citing|cited by)\s+(?:the\s+)?((?:[A-Z][\w'’-]*)(?:\s+(?:[A-Z][\w'’-]*|of|and))*)/;
const ATTRIBUTION_SCAN_CHARACTERS = 4000;
const ATTRIBUTION_MAX_WORDS = 5;

export function attributedOrigin(source: SourceDocument): string | undefined {
  if (tierOf(source) <= 2) return undefined;
  const match = ATTRIBUTION.exec(source.text.slice(0, ATTRIBUTION_SCAN_CHARACTERS));
  const name = match?.[1]?.trim();
  if (!name || name.split(/\s+/).length > ATTRIBUTION_MAX_WORDS) return undefined;
  return name;
}

export function provenanceLine(source: SourceDocument): string {
  const tier = tierOf(source);
  const origin = attributedOrigin(source);
  const attribution = origin ? `; attributes its claims to ${origin} (original not retrieved)` : "";
  return `provenance: tier ${tier} (${TIER_LABELS[tier]})${attribution}`;
}

export function evidenceBaseSummary(sources: SourceDocument[]): string {
  const counts = sources.reduce<Record<number, number>>((tally, source) => {
    const tier = tierOf(source);
    return { ...tally, [tier]: (tally[tier] ?? 0) + 1 };
  }, {});
  const parts = ([1, 2, 3, 4] as SourceTier[]).map(tier => `${counts[tier] ?? 0} tier-${tier} (${TIER_LABELS[tier]})`);
  return `Evidence base provenance: ${parts.join(", ")}. Claims resting only on tier 3 or tier 4 pages are reporting leads, not established facts.`;
}

export function byProvenance(a: SourceDocument, b: SourceDocument): number {
  return tierOf(a) - tierOf(b) || Number(a.retrievalKind === "snippet") - Number(b.retrievalKind === "snippet");
}
