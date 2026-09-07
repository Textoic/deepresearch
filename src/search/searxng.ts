import type { SearchProvider, SourceDocument } from "../types.ts";

interface SearxngResult { url?: string; title?: string; content?: string; publishedDate?: string; }
interface SearxngResponse { results?: SearxngResult[]; }

/**
 * A no-vendor-lock-in retrieval adapter for a self-hosted SearXNG instance.
 * Its instance must enable the JSON output format. By default this returns
 * search snippets; set fetchPages to retain a bounded plain-text page snapshot.
 */
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
    endpoint.searchParams.set("q", query); endpoint.searchParams.set("format", "json");
    const response = await this.fetchFn(endpoint, { headers: { accept: "application/json" }, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`SearXNG returned ${response.status}. Ensure its JSON format is enabled.`);
    const payload = await response.json() as SearxngResponse;
    const results = (payload.results ?? []).slice(0, options.limit).filter((result) => validWebUrl(result.url));
    return Promise.all(results.map((result) => this.toSource(result, options.signal)));
  }

  private async toSource(result: SearxngResult, signal?: AbortSignal): Promise<SourceDocument> {
    const retrievedAt = new Date().toISOString();
    if (!this.fetchPages) return { url: result.url!, title: result.title, text: result.content ?? "", publishedAt: result.publishedDate, retrievedAt, sourceTier: 2, retrievalKind: "snippet" };
    try {
      const response = await this.fetchFn(result.url!, { headers: { accept: "text/html,text/plain" }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(String(response.status));
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.startsWith("text/")) throw new Error(`Unsupported page type: ${contentType}`);
      const text = contentType.includes("text/html") ? stripHtml((await response.text()).slice(0, 1_000_000)) : (await response.text()).slice(0, 200_000);
      return { url: result.url!, title: result.title, text: text || result.content || "", publishedAt: result.publishedDate, retrievedAt, sourceTier: 2, retrievalKind: "page" };
    } catch (error) {
      // Search snippets are still useful discovery evidence; the report must label the limitation.
      return { url: result.url!, title: result.title, text: result.content ?? "", publishedAt: result.publishedDate, retrievedAt, sourceTier: 2, retrievalKind: "snippet", retrievalError: String(error) };
    }
  }
}

function validWebUrl(value: unknown): value is string { try { const url = new URL(String(value)); return url.protocol === "https:" || url.protocol === "http:"; } catch { return false; } }
function stripHtml(html: string): string { return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
