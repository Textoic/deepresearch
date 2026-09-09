import { deadline, PageContentFetcher, validWebUrl, type SearchHit } from "./page-content.ts";
import { excludedFromRetrieval } from "./excluded-hosts.ts";
import type { SearchProvider, SourceDocument } from "../types.ts";

interface SerperOrganic { title?: string; link?: string; snippet?: string; date?: string; }
interface SerperResponse { organic?: SerperOrganic[]; credits?: number; message?: string; }

const SEARCH_ENDPOINT = "https://google.serper.dev/search";
const SEARCH_TIMEOUT_MS = 20000;
const MAX_RESULTS = 100;
const CHEAP_RESULT_LIMIT = 10;

export interface SerperOptions {
  apiKey: string;
  fetchPages?: boolean;
  fetchFn?: typeof fetch;
  endpoint?: string;
  country?: string;
  language?: string;
  freshness?: "qdr:h" | "qdr:d" | "qdr:w" | "qdr:m" | "qdr:y";
}

function toHit(result: SerperOrganic): SearchHit {
  return { url: result.link!, title: result.title, snippet: result.snippet, publishedHint: result.date };
}

const STATUS_ERRORS: Array<{ status: number; message: string }> = [
  { status: 401, message: "Serper rejected the API key. Check SERPER_API_KEY." },
  { status: 403, message: "Serper rejected the API key. Check SERPER_API_KEY." },
  { status: 429, message: "Serper credits exhausted or rate limited; top up at serper.dev or fall back to SearXNG." },
];

function assertUsable(response: Response): void {
  const known = STATUS_ERRORS.find((entry) => entry.status === response.status);
  if (known) throw new Error(known.message);
  if (!response.ok) throw new Error(`Serper returned ${response.status}.`);
}

function organicOf(payload: SerperResponse): SerperOrganic[] {
  if (payload.message && !payload.organic) throw new Error(`Serper error: ${payload.message}`);
  return payload.organic ?? [];
}

function billedResults(limit: number): number {
  return Math.min(MAX_RESULTS, Math.max(1, limit <= CHEAP_RESULT_LIMIT ? CHEAP_RESULT_LIMIT : limit));
}

export class SerperSearchProvider implements SearchProvider {
  private readonly options: SerperOptions;
  private readonly fetchFn: typeof fetch;
  private readonly pages: PageContentFetcher;

  constructor(options: SerperOptions) {
    if (!options.apiKey.trim()) throw new Error("Serper requires an API key. Set SERPER_API_KEY or pass --serper-key.");
    this.options = options;
    this.fetchFn = options.fetchFn ?? fetch;
    this.pages = new PageContentFetcher(options);
  }

  async search(query: string, options: { limit: number; signal?: AbortSignal }): Promise<SourceDocument[]> {
    const organic = await this.query(query, options.limit, options.signal);
    const results = organic.filter((result) => validWebUrl(result.link) && !excludedFromRetrieval(result.link!)).slice(0, options.limit);
    return Promise.all(results.map((result) => this.pages.toSource(toHit(result), options.signal)));
  }

  private get endpoint(): string {
    return this.options.endpoint ?? SEARCH_ENDPOINT;
  }

  private body(query: string, limit: number): string {
    return JSON.stringify({
      q: query,
      num: billedResults(limit),
      gl: this.options.country ?? "us",
      hl: this.options.language ?? "en",
      ...(this.options.freshness ? { tbs: this.options.freshness } : {}),
    });
  }

  private async query(query: string, limit: number, signal?: AbortSignal): Promise<SerperOrganic[]> {
    const request = {
      method: "POST",
      headers: { "X-API-KEY": this.options.apiKey, "content-type": "application/json" },
      body: this.body(query, limit),
      signal: deadline(signal, SEARCH_TIMEOUT_MS),
    };
    const response = await this.fetchFn(this.endpoint, request);
    assertUsable(response);
    return organicOf(await response.json() as SerperResponse);
  }
}
