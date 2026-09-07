import type { SourceDocument } from "./types.ts";

export interface SourceAdapterContext {
  topic: string;
  rules: string;
  urls: string[];
  asOf: string;
  signal: AbortSignal;
}
export interface SourceAdapterResult {
  documents: SourceDocument[];
  limitations: string[];
}
export interface SourceAdapter {
  id: string;
  domains: readonly string[];
  fetch(context: SourceAdapterContext): Promise<SourceAdapterResult>;
}
export interface AdapterDiagnostic { id: string; status: "complete" | "failed"; documents: number; limitations: string[]; }

export function extractSourceUrls(text: string): string[] {
  return [...new Set((text.match(/https?:\/\/[^\s<>"']+/gi) ?? []).map(value => value.replace(/[),.;]+$/, "")))];
}

function normalizedHost(value: string): string[] {
  try { return [new URL(value).hostname.toLowerCase().replace(/^www\./, "")]; } catch { return []; }
}

function matchesHosts(adapter: SourceAdapter, hosts: Set<string>): boolean {
  return adapter.domains.some(host => hosts.has(host.toLowerCase().replace(/^www\./, "")));
}

const ADAPTER_FAILURE = "Adapter retrieval failed or timed out; ordinary search remains available.";

export async function collectAdapterSources(adapters: SourceAdapter[], context: SourceAdapterContext) {
  const hosts = new Set(context.urls.flatMap(normalizedHost));
  const documents: SourceDocument[] = [];
  const diagnostics: AdapterDiagnostic[] = [];
  const seen = new Set<string>();
  for (const adapter of adapters) {
    if (seen.has(adapter.id) || !matchesHosts(adapter, hosts)) continue;
    seen.add(adapter.id);
    try {
      context.signal.throwIfAborted();
      const result = await adapter.fetch(context);
      documents.push(...result.documents);
      diagnostics.push({ id: adapter.id, status: "complete", documents: result.documents.length, limitations: result.limitations });
    } catch {
      diagnostics.push({ id: adapter.id, status: "failed", documents: 0, limitations: [ADAPTER_FAILURE] });
    }
  }
  return { documents, diagnostics };
}

export function scalePrice(value: string, exponent: number): string {
  if (!/^-?\d+$/.test(value) || !Number.isInteger(exponent) || Math.abs(exponent) > 30) throw new Error("Invalid oracle price.");
  const sign = value.startsWith("-") ? "-" : "";
  const digits = value.replace(/^-/, "");
  if (exponent >= 0) return sign + digits + "0".repeat(exponent);
  const padded = digits.padStart(1 - exponent, "0");
  return sign + padded.slice(0, exponent) + "." + padded.slice(exponent);
}

interface PythPrice { price: string; conf: string; expo: number; publish_time: number; }
interface PythResponse { parsed?: Array<{ id: string; price: PythPrice }>; }

const DEFAULT_PYTH_MAX_AGE_SECONDS = 300;

function sameFeed(left: string, right: string): boolean {
  const normalize = (id: string) => id.replace(/^0x/i, "").toLowerCase();
  return normalize(left) === normalize(right);
}

function onlyMatchingPrice(data: PythResponse, feedId: string): PythPrice {
  const records = data.parsed?.filter(row => sameFeed(row.id, feedId)) ?? [];
  if (records.length !== 1) throw new Error("Pyth did not return exactly one matching feed.");
  const price = records[0]!.price;
  if (!Number.isSafeInteger(price.publish_time) || price.publish_time < 0 || !/^\d+$/.test(price.conf)) throw new Error("Invalid Pyth timestamp or confidence.");
  return price;
}

function pythDocumentText(feedId: string, price: PythPrice, publishedAt: string): string {
  return `Pyth feed ID: ${feedId}\nPrice: ${scalePrice(price.price, price.expo)}\nConfidence interval magnitude: ${scalePrice(price.conf, price.expo)}\nPublish time: ${publishedAt}\nRaw price record: ${JSON.stringify(price)}\nThis is an oracle observation, not proof of market resolution or a historical threshold crossing. Confirm the feed's asset, currency, and contract against the resolution rules.`;
}

export class PythSourceAdapter implements SourceAdapter {
  readonly id = "pyth-price";
  readonly domains = ["app.pyth.com", "pyth.network", "www.pyth.network"];
  constructor(private readonly options: { feedId: string; apiKey: string; fetchFn?: typeof fetch; maxAgeSeconds?: number }) {
    if (!/^(?:0x)?[0-9a-f]{64}$/i.test(options.feedId)) throw new Error("Pyth requires an exact 32-byte feed ID.");
    if (!options.apiKey.trim()) throw new Error("Pyth requires an API key.");
    if (!Number.isFinite(options.maxAgeSeconds ?? DEFAULT_PYTH_MAX_AGE_SECONDS) || (options.maxAgeSeconds ?? DEFAULT_PYTH_MAX_AGE_SECONDS) < 0) throw new Error("Invalid Pyth freshness limit.");
  }

  private get maxAgeSeconds(): number {
    return this.options.maxAgeSeconds ?? DEFAULT_PYTH_MAX_AGE_SECONDS;
  }

  async fetch(context: SourceAdapterContext): Promise<SourceAdapterResult> {
    const endpoint = new URL("https://pyth.dourolabs.app/hermes/v2/updates/price/latest");
    endpoint.searchParams.set("ids[]", this.options.feedId);
    const response = await (this.options.fetchFn ?? fetch)(endpoint, { headers: { Authorization: `Bearer ${this.options.apiKey}` }, signal: context.signal });
    if (!response.ok) throw new Error(`Pyth HTTP ${response.status}`);
    const price = onlyMatchingPrice(await response.json() as PythResponse, this.options.feedId);
    const publishedAt = new Date(price.publish_time * 1000).toISOString();
    const age = (Date.parse(context.asOf) - Date.parse(publishedAt)) / 1000;
    if (age < 0 || age > this.maxAgeSeconds) return { documents: [], limitations: ["Latest Pyth update is after the cutoff or outside the configured freshness window. No historical price was inferred."] };
    return {
      documents: [{ url: endpoint.toString(), title: `Pyth feed ${this.options.feedId}`, publishedAt, retrievedAt: new Date().toISOString(), sourceTier: 1, retrievalKind: "page",
        text: pythDocumentText(this.options.feedId, price, publishedAt) }],
      limitations: ["Pyth latest-only observation; no historical series or intraperiod extrema. Feed identity must match the contract."],
    };
  }
}

interface PortWatchAttributes { date: number | string; portid: string; portname: string; n_total: number | null; }
interface PortWatchRow { date: string; total: number; port: string; }
interface PortWatchResponse { error?: unknown; features?: Array<{ attributes: PortWatchAttributes }>; }

const DAY_MS = 86_400_000;
const MEAN_WINDOW_DAYS = 7;
const PORTWATCH_RECORD_COUNT = "30";

function toPortWatchRow(attributes: PortWatchAttributes, portId: string): PortWatchRow {
  const time = typeof attributes.date === "number" ? attributes.date : Date.parse(attributes.date);
  const total = attributes.n_total;
  if (!Number.isFinite(time) || attributes.portid !== portId) throw new Error("Invalid PortWatch row.");
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) throw new Error("Invalid PortWatch row.");
  return { date: new Date(time).toISOString().slice(0, 10), total, port: attributes.portname };
}

function weeklyMean(rows: PortWatchRow[]): number | null {
  if (rows.length < MEAN_WINDOW_DAYS) return null;
  const consecutive = rows.slice(1, MEAN_WINDOW_DAYS).every((row, index) => Date.parse(rows[index]!.date) - Date.parse(row.date) === DAY_MS);
  return consecutive ? rows.slice(0, MEAN_WINDOW_DAYS).reduce((sum, row) => sum + row.total, 0) / MEAN_WINDOW_DAYS : null;
}

function portWatchDocumentText(portId: string, rows: PortWatchRow[], mean: number | null): string {
  return `Port ID: ${portId}\nMetric: daily transit calls (not cargo volume).\nLatest observation date: ${rows[0]!.date}\nLatest seven-calendar-day mean: ${mean ?? "unavailable; fewer than seven consecutive days"}\nObservations:\n${rows.map(row => `${row.date}: ${row.total}`).join("\n")}\nPublication time and historical revision availability are unknown. A current snapshot cannot establish what was known at a past cutoff.`;
}

export class PortWatchSourceAdapter implements SourceAdapter {
  readonly id = "imf-portwatch";
  readonly domains = ["portwatch.imf.org"];
  constructor(private readonly options: { portId: string; fetchFn?: typeof fetch }) {
    if (!/^[a-z0-9_-]+$/i.test(options.portId)) throw new Error("An exact PortWatch port ID is required.");
  }

  private endpoint(): URL {
    const endpoint = new URL("https://services9.arcgis.com/weJ1QsnbMYJlCHdG/ArcGIS/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query");
    endpoint.search = new URLSearchParams({ where: `portid='${this.options.portId}'`, outFields: "date,portid,portname,n_total", orderByFields: "date DESC", resultRecordCount: PORTWATCH_RECORD_COUNT, returnGeometry: "false", f: "json" }).toString();
    return endpoint;
  }

  async fetch(context: SourceAdapterContext): Promise<SourceAdapterResult> {
    const endpoint = this.endpoint();
    const response = await (this.options.fetchFn ?? fetch)(endpoint, { signal: context.signal });
    if (!response.ok) throw new Error("PortWatch retrieval failed.");
    const data = await response.json() as PortWatchResponse;
    if (data.error || !data.features?.length) throw new Error("PortWatch returned no usable records.");
    const rows = data.features.map(feature => toPortWatchRow(feature.attributes, this.options.portId))
      .filter(row => row.date <= context.asOf.slice(0, 10)).sort((a, b) => b.date.localeCompare(a.date));
    if (!rows.length) return { documents: [], limitations: ["No PortWatch observations at or before cutoff in the latest 30 records."] };
    if (new Set(rows.map(row => row.date)).size !== rows.length) throw new Error("Duplicate PortWatch dates.");
    return {
      documents: [{ url: endpoint.toString(), title: `IMF PortWatch — ${rows[0]!.port}`, retrievedAt: new Date().toISOString(), sourceTier: 1, retrievalKind: "page",
        text: portWatchDocumentText(this.options.portId, rows, weeklyMean(rows)) }],
      limitations: ["PortWatch observations may lag and be revised. Publication dates are unknown; strict historical eligibility will exclude this live snapshot. Exact port ID and metric must match the contract."],
    };
  }
}
