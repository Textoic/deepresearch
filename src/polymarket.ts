import type { PolymarketEvent } from "./types.ts";

export type FetchLike = typeof fetch;

export class PolymarketClient {
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;
  constructor(fetchFn: FetchLike = fetch, baseUrl = "https://gamma-api.polymarket.com") {
    this.fetchFn = fetchFn;
    this.baseUrl = baseUrl;
  }

  async getEventBySlug(slug: string): Promise<PolymarketEvent> {
    if (!slug.trim()) throw new Error("A Polymarket slug is required.");
    const url = new URL("/events", this.baseUrl);
    url.searchParams.set("slug", slug);
    const response = await this.fetchFn(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Polymarket Gamma API returned ${response.status}.`);
    const payload: unknown = await response.json();
    const item = Array.isArray(payload) ? payload[0] : undefined;
    if (!item || typeof item !== "object") throw new Error(`No Polymarket event found for slug '${slug}'.`);
    const event = item as Record<string, unknown>;
    if (typeof event.title !== "string" || typeof event.slug !== "string") {
      throw new Error("Polymarket response is missing event title or slug.");
    }
    return {
      id: String(event.id ?? ""), slug: event.slug, title: event.title,
      description: stringOrUndefined(event.description), resolutionSource: stringOrUndefined(event.resolutionSource),
      endDate: stringOrUndefined(event.endDate), closed: booleanOrUndefined(event.closed),
      active: booleanOrUndefined(event.active), volume: numberOrString(event.volume), liquidity: numberOrString(event.liquidity),
      markets: Array.isArray(event.markets) ? event.markets as PolymarketEvent["markets"] : [], raw: item,
    };
  }
}

function stringOrUndefined(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function booleanOrUndefined(value: unknown): boolean | undefined { return typeof value === "boolean" ? value : undefined; }
function numberOrString(value: unknown): number | string | undefined {
  return typeof value === "number" || typeof value === "string" ? value : undefined;
}
