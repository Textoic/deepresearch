import { classifySourceTier } from "../source-tier.ts";
import type { SourceDocument } from "../types.ts";

export interface SearchHit {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
  publishedHint?: string;
}

const PAGE_TIMEOUT_MS = 20000;
const MAX_RAW_CHARACTERS = 1_000_000;
const MAX_PLAIN_CHARACTERS = 200_000;
const SHORT_PAGE_CHARACTERS = 120;
const CHALLENGE = /prove your humanity|verify you are human|access denied|enable javascript and cookies/i;
const SHORT_PAGE_HOSTS = /(?:facebook|reddit)\.com/i;
const PUBLISHED_META = /<meta[^>]+(?:property|name)=["'](?:article:published_time|datePublished|pubdate)["'][^>]+content=["']([^"']+)/i;
const RELATIVE_HINT = /^(\d+)\s+(hour|day|week|month|year)s?\s+ago$/i;
const RELATIVE_DAYS: Record<string, number> = { hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 };
const MILLISECONDS_PER_DAY = 86_400_000;

export function deadline(signal: AbortSignal | undefined, milliseconds: number): AbortSignal {
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function validWebUrl(value: unknown): value is string {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" || url.protocol === "http:";
  } catch { return false; }
}

function stripHtml(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function isBlocked(text: string, url: string): boolean {
  if (!text.trim()) return true;
  if (text.length < SHORT_PAGE_CHARACTERS && SHORT_PAGE_HOSTS.test(url)) return true;
  return CHALLENGE.test(text.slice(0, 1500));
}

function wallClockDate(value: string): string | undefined {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate())).toISOString().slice(0, 10);
}

export function absoluteFromHint(hint: string | undefined, observedAt: string): string | undefined {
  if (!hint) return undefined;
  const relative = RELATIVE_HINT.exec(hint.trim());
  if (!relative) return wallClockDate(hint);
  const days = RELATIVE_DAYS[relative[2]!.toLowerCase()]! * Number(relative[1]);
  return new Date(Date.parse(observedAt) - days * MILLISECONDS_PER_DAY).toISOString().slice(0, 10);
}

async function readPageText(response: Response): Promise<{ raw: string; text: string }> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("text/")) throw new Error(`Unsupported page type: ${contentType}`);
  const raw = (await response.text()).slice(0, MAX_RAW_CHARACTERS);
  return { raw, text: contentType.includes("text/html") ? stripHtml(raw) : raw.slice(0, MAX_PLAIN_CHARACTERS) };
}

function publishedFromPage(raw: string, hit: SearchHit, retrievedAt: string): string | undefined {
  if (hit.publishedAt) return hit.publishedAt;
  const declared = PUBLISHED_META.exec(raw)?.[1];
  if (declared && Number.isFinite(Date.parse(declared))) return new Date(declared).toISOString();
  return absoluteFromHint(hit.publishedHint, retrievedAt);
}

export class PageContentFetcher {
  private readonly fetchFn: typeof fetch;
  private readonly fetchPages: boolean;

  constructor(options: { fetchFn?: typeof fetch; fetchPages?: boolean }) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.fetchPages = options.fetchPages ?? true;
  }

  snippetSource(hit: SearchHit, retrievedAt: string, retrievalError?: string): SourceDocument {
    return {
      url: hit.url, title: hit.title, text: hit.snippet ?? "",
      publishedAt: hit.publishedAt ?? absoluteFromHint(hit.publishedHint, retrievedAt),
      retrievedAt, sourceTier: classifySourceTier(hit.url), retrievalKind: "snippet",
      ...(retrievalError ? { retrievalError } : {}),
    };
  }

  async toSource(hit: SearchHit, signal?: AbortSignal): Promise<SourceDocument> {
    const retrievedAt = new Date().toISOString();
    if (!this.fetchPages) return this.snippetSource(hit, retrievedAt);
    try {
      return await this.fetchPage(hit, retrievedAt, signal);
    } catch (error) {
      return this.snippetSource(hit, retrievedAt, String(error));
    }
  }

  private async fetchPage(hit: SearchHit, retrievedAt: string, signal?: AbortSignal): Promise<SourceDocument> {
    const response = await this.fetchFn(hit.url, { headers: { accept: "text/html,text/plain" }, signal: deadline(signal, PAGE_TIMEOUT_MS) });
    if (!response.ok) throw new Error(String(response.status));
    const { raw, text } = await readPageText(response);
    if (isBlocked(text, hit.url)) throw new Error("Blocked or empty page; preserving discovery snippet only");
    return {
      url: hit.url, title: hit.title, text: text || hit.snippet || "",
      publishedAt: publishedFromPage(raw, hit, retrievedAt),
      retrievedAt, sourceTier: classifySourceTier(hit.url), retrievalKind: "page",
    };
  }
}
