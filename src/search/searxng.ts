import type { SearchProvider, SourceDocument } from "../types.ts";

interface SearxngResult { url?: string; title?: string; content?: string; publishedDate?: string; }
interface SearxngResponse { results?: SearxngResult[]; }

const SEARCH_TIMEOUT_MS = 30000;
const PAGE_TIMEOUT_MS = 20000;
const MAX_RAW_CHARACTERS = 1_000_000;
const MAX_PLAIN_CHARACTERS = 200_000;
const SHORT_PAGE_CHARACTERS = 120;
const CHALLENGE = /prove your humanity|verify you are human|access denied|enable javascript and cookies/i;
const SHORT_PAGE_HOSTS = /(?:facebook|reddit)\.com/i;
const PUBLISHED_META = /<meta[^>]+(?:property|name)=["'](?:article:published_time|datePublished|pubdate)["'][^>]+content=["']([^"']+)/i;

function deadline(signal: AbortSignal | undefined, milliseconds: number): AbortSignal {
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function validWebUrl(value: unknown): value is string {
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

function publishedAtOf(raw: string, result: SearxngResult): string | undefined {
  if (result.publishedDate) return result.publishedDate;
  const declared = PUBLISHED_META.exec(raw)?.[1];
  return declared && Number.isFinite(Date.parse(declared)) ? new Date(declared).toISOString() : undefined;
}

function snippetSource(result: SearxngResult, retrievedAt: string, retrievalError?: string): SourceDocument {
  return { url: result.url!, title: result.title, text: result.content ?? "", publishedAt: result.publishedDate, retrievedAt, sourceTier: 2, retrievalKind: "snippet", ...(retrievalError ? { retrievalError } : {}) };
}

async function readPageText(response: Response): Promise<{ raw: string; text: string }> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("text/")) throw new Error(`Unsupported page type: ${contentType}`);
  const raw = (await response.text()).slice(0, MAX_RAW_CHARACTERS);
  return { raw, text: contentType.includes("text/html") ? stripHtml(raw) : raw.slice(0, MAX_PLAIN_CHARACTERS) };
}

export class SearxngSearchProvider implements SearchProvider {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly fetchPages: boolean;
  constructor(options: { baseUrl: string; fetchPages?: boolean; fetchFn?: typeof fetch }) {
    this.baseUrl = options.baseUrl;
    this.fetchPages = options.fetchPages ?? true;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async search(query: string, options: { limit: number; signal?: AbortSignal }): Promise<SourceDocument[]> {
    const endpoint = new URL("/search", this.baseUrl);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("format", "json");
    const response = await this.fetchFn(endpoint, { headers: { accept: "application/json" }, signal: deadline(options.signal, SEARCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`SearXNG returned ${response.status}. Ensure its JSON format is enabled.`);
    const payload = await response.json() as SearxngResponse;
    const results = (payload.results ?? []).slice(0, options.limit).filter((result) => validWebUrl(result.url));
    return Promise.all(results.map((result) => this.toSource(result, options.signal)));
  }

  private async toSource(result: SearxngResult, signal?: AbortSignal): Promise<SourceDocument> {
    const retrievedAt = new Date().toISOString();
    if (!this.fetchPages) return snippetSource(result, retrievedAt);
    try {
      return await this.fetchPage(result, retrievedAt, signal);
    } catch (error) {
      return snippetSource(result, retrievedAt, String(error));
    }
  }

  private async fetchPage(result: SearxngResult, retrievedAt: string, signal?: AbortSignal): Promise<SourceDocument> {
    const response = await this.fetchFn(result.url!, { headers: { accept: "text/html,text/plain" }, signal: deadline(signal, PAGE_TIMEOUT_MS) });
    if (!response.ok) throw new Error(String(response.status));
    const { raw, text } = await readPageText(response);
    if (isBlocked(text, result.url!)) throw new Error("Blocked or empty page; preserving discovery snippet only");
    return { url: result.url!, title: result.title, text: text || result.content || "", publishedAt: publishedAtOf(raw, result), retrievedAt, sourceTier: 2, retrievalKind: "page" };
  }
}
