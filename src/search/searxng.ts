import { deadline, PageContentFetcher, validWebUrl, type SearchHit } from "./page-content.ts";
import { excludedFromRetrieval } from "./excluded-hosts.ts";
import type { SearchProvider, SourceDocument } from "../types.ts";

interface SearxngResult { url?: string; title?: string; content?: string; publishedDate?: string; }
interface SearxngResponse { results?: SearxngResult[]; unresponsive_engines?: unknown[]; }

const SEARCH_TIMEOUT_MS = 30000;
const EMPTY_RETRY_DELAYS_MS = [2000, 6000];

function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

function starvedByEngines(payload: SearxngResponse): boolean {
  return !payload.results?.length && !!payload.unresponsive_engines?.length;
}

function toHit(result: SearxngResult): SearchHit {
  return { url: result.url!, title: result.title, snippet: result.content, publishedAt: result.publishedDate };
}

export class SearxngSearchProvider implements SearchProvider {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly pages: PageContentFetcher;
  private readonly retryDelaysMs: number[];

  constructor(options: { baseUrl: string; fetchPages?: boolean; fetchFn?: typeof fetch; retryDelaysMs?: number[] }) {
    this.baseUrl = options.baseUrl;
    this.fetchFn = options.fetchFn ?? fetch;
    this.pages = new PageContentFetcher(options);
    this.retryDelaysMs = options.retryDelaysMs ?? EMPTY_RETRY_DELAYS_MS;
  }

  async search(query: string, options: { limit: number; signal?: AbortSignal }): Promise<SourceDocument[]> {
    const payload = await this.resilientQuery(query, options.signal);
    const results = (payload.results ?? []).filter((result) => validWebUrl(result.url) && !excludedFromRetrieval(result.url!)).slice(0, options.limit);
    return Promise.all(results.map((result) => this.pages.toSource(toHit(result), options.signal)));
  }

  private async requestOnce(query: string, signal?: AbortSignal): Promise<SearxngResponse> {
    const endpoint = new URL("/search", this.baseUrl);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("format", "json");
    const response = await this.fetchFn(endpoint, { headers: { accept: "application/json" }, signal: deadline(signal, SEARCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`SearXNG returned ${response.status}. Ensure its JSON format is enabled.`);
    return await response.json() as SearxngResponse;
  }

  private async resilientQuery(query: string, signal?: AbortSignal): Promise<SearxngResponse> {
    let payload = await this.requestOnce(query, signal);
    for (const delay of this.retryDelaysMs) {
      if (!starvedByEngines(payload)) return payload;
      await pause(delay, signal);
      payload = await this.requestOnce(query, signal);
    }
    if (starvedByEngines(payload)) throw new Error(`SearXNG returned no results; every engine was unavailable: ${JSON.stringify(payload.unresponsive_engines)}`);
    return payload;
  }
}
