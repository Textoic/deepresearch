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
  /** Exact host matching; no substring routing. */
  domains: readonly string[];
  fetch(context: SourceAdapterContext): Promise<SourceAdapterResult>;
}
export interface AdapterDiagnostic { id: string; status: "complete" | "failed"; documents: number; limitations: string[]; }

export function extractSourceUrls(text: string): string[] {
  return [...new Set((text.match(/https?:\/\/[^\s<>"']+/gi) ?? []).map(value => value.replace(/[),.;]+$/, "")))];
}

export async function collectAdapterSources(adapters: SourceAdapter[], context: SourceAdapterContext) {
  const hosts = new Set(context.urls.flatMap(value => {
    try { return [new URL(value).hostname.toLowerCase().replace(/^www\./, "")]; } catch { return []; }
  }));
  const documents: SourceDocument[] = [];
  const diagnostics: AdapterDiagnostic[] = [];
  const seen = new Set<string>();
  for (const adapter of adapters) {
    if (seen.has(adapter.id) || !adapter.domains.some(host => hosts.has(host.toLowerCase().replace(/^www\./, "")))) continue;
    seen.add(adapter.id);
    try {
      context.signal.throwIfAborted();
      const result = await adapter.fetch(context);
      documents.push(...result.documents);
      diagnostics.push({ id: adapter.id, status: "complete", documents: result.documents.length, limitations: result.limitations });
    } catch {
      // Provider errors may contain authenticated request URLs. Persist only a safe diagnostic.
      diagnostics.push({ id: adapter.id, status: "failed", documents: 0, limitations: ["Adapter retrieval failed or timed out; ordinary search remains available."] });
    }
  }
  return { documents, diagnostics };
}

/** Decimal strings preserve the oracle's integer mantissa without floating-point rounding. */
export function scalePrice(value: string, exponent: number): string {
  if (!/^-?\d+$/.test(value) || !Number.isInteger(exponent) || Math.abs(exponent) > 30) throw new Error("Invalid oracle price.");
  const sign = value.startsWith("-") ? "-" : "";
  const digits = value.replace(/^-/, "");
  if (exponent >= 0) return sign + digits + "0".repeat(exponent);
  const padded = digits.padStart(1 - exponent, "0");
  return sign + padded.slice(0, exponent) + "." + padded.slice(exponent);
}

/** An explicit feed ID is required: search=WTI alone does not identify a contract. */
export class PythSourceAdapter implements SourceAdapter {
  readonly id = "pyth-price";
  readonly domains = ["app.pyth.com", "pyth.network", "www.pyth.network"];
  constructor(private readonly options: { feedId: string; apiKey: string; fetchFn?: typeof fetch; maxAgeSeconds?: number }) {
    if (!/^(?:0x)?[0-9a-f]{64}$/i.test(options.feedId)) throw new Error("Pyth requires an exact 32-byte feed ID.");
    if (!options.apiKey.trim()) throw new Error("Pyth requires an API key.");
    if (!Number.isFinite(options.maxAgeSeconds ?? 300) || (options.maxAgeSeconds ?? 300) < 0) throw new Error("Invalid Pyth freshness limit.");
  }
  async fetch(context: SourceAdapterContext): Promise<SourceAdapterResult> {
    const endpoint = new URL("https://pyth.dourolabs.app/hermes/v2/updates/price/latest");
    endpoint.searchParams.set("ids[]", this.options.feedId);
    const response = await (this.options.fetchFn ?? fetch)(endpoint, {
      headers: { Authorization: `Bearer ${this.options.apiKey}` }, signal: context.signal,
    });
    if (!response.ok) throw new Error(`Pyth HTTP ${response.status}`);
    const data = await response.json() as { parsed?: Array<{ id: string; price: { price: string; conf: string; expo: number; publish_time: number } }> };
    const normalize = (id: string) => id.replace(/^0x/i, "").toLowerCase();
    const records = data.parsed?.filter(row => normalize(row.id) === normalize(this.options.feedId)) ?? [];
    if (records.length !== 1) throw new Error("Pyth did not return exactly one matching feed.");
    const price = records[0]!.price;
    if (!Number.isSafeInteger(price.publish_time) || price.publish_time < 0 || !/^\d+$/.test(price.conf)) throw new Error("Invalid Pyth timestamp or confidence.");
    const publishedAt = new Date(price.publish_time * 1000).toISOString();
    const age = (Date.parse(context.asOf) - Date.parse(publishedAt)) / 1000;
    if (age < 0 || age > (this.options.maxAgeSeconds ?? 300)) return { documents: [], limitations: ["Latest Pyth update is after the cutoff or outside the configured freshness window. No historical price was inferred."] };
    return {
      documents: [{ url: endpoint.toString(), title: `Pyth feed ${this.options.feedId}`, publishedAt, retrievedAt: new Date().toISOString(), sourceTier: 1, retrievalKind: "page",
        text: `Pyth feed ID: ${this.options.feedId}\nPrice: ${scalePrice(price.price, price.expo)}\nConfidence interval magnitude: ${scalePrice(price.conf, price.expo)}\nPublish time: ${publishedAt}\nRaw price record: ${JSON.stringify(price)}\nThis is an oracle observation, not proof of market resolution or a historical threshold crossing. Confirm the feed's asset, currency, and contract against the resolution rules.` }],
      limitations: ["Pyth latest-only observation; no historical series or intraperiod extrema. Feed identity must match the contract."],
    };
  }
}

/** Exact port IDs avoid guessing the subject from generic words in a market title. */
export class PortWatchSourceAdapter implements SourceAdapter {
  readonly id = "imf-portwatch";
  readonly domains = ["portwatch.imf.org"];
  constructor(private readonly options: { portId: string; fetchFn?: typeof fetch }) {
    if (!/^[a-z0-9_-]+$/i.test(options.portId)) throw new Error("An exact PortWatch port ID is required.");
  }
  async fetch(context: SourceAdapterContext): Promise<SourceAdapterResult> {
    const endpoint = new URL("https://services9.arcgis.com/weJ1QsnbMYJlCHdG/ArcGIS/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query");
    endpoint.search = new URLSearchParams({ where: `portid='${this.options.portId}'`, outFields: "date,portid,portname,n_total", orderByFields: "date DESC", resultRecordCount: "30", returnGeometry: "false", f: "json" }).toString();
    const response = await (this.options.fetchFn ?? fetch)(endpoint, { signal: context.signal });
    if (!response.ok) throw new Error("PortWatch retrieval failed.");
    const data = await response.json() as { error?: unknown; features?: Array<{ attributes: { date: number | string; portid: string; portname: string; n_total: number | null } }> };
    if (data.error || !data.features?.length) throw new Error("PortWatch returned no usable records.");
    const rows = data.features.map(({ attributes: a }) => {
      const time = typeof a.date === "number" ? a.date : Date.parse(a.date);
      if (!Number.isFinite(time) || a.portid !== this.options.portId || typeof a.n_total !== "number" || !Number.isFinite(a.n_total) || a.n_total < 0) throw new Error("Invalid PortWatch row.");
      return { date: new Date(time).toISOString().slice(0, 10), total: a.n_total, port: a.portname };
    }).filter(row => row.date <= context.asOf.slice(0, 10)).sort((a, b) => b.date.localeCompare(a.date));
    if (!rows.length) return { documents: [], limitations: ["No PortWatch observations at or before cutoff in the latest 30 records."] };
    if (new Set(rows.map(r => r.date)).size !== rows.length) throw new Error("Duplicate PortWatch dates.");
    const consecutive = rows.length >= 7 && rows.slice(1, 7).every((row, i) => Date.parse(rows[i]!.date) - Date.parse(row.date) === 86_400_000);
    const mean = consecutive ? rows.slice(0, 7).reduce((sum, row) => sum + row.total, 0) / 7 : null;
    return {
      documents: [{ url: endpoint.toString(), title: `IMF PortWatch — ${rows[0]!.port}`, retrievedAt: new Date().toISOString(), sourceTier: 1, retrievalKind: "page",
        // Observation dates are not publication dates: revisions/processing lag are not known.
        text: `Port ID: ${this.options.portId}\nMetric: daily transit calls (not cargo volume).\nLatest observation date: ${rows[0]!.date}\nLatest seven-calendar-day mean: ${mean ?? "unavailable; fewer than seven consecutive days"}\nObservations:\n${rows.map(row => `${row.date}: ${row.total}`).join("\n")}\nPublication time and historical revision availability are unknown. A current snapshot cannot establish what was known at a past cutoff.` }],
      limitations: ["PortWatch observations may lag and be revised. Publication dates are unknown; strict historical eligibility will exclude this live snapshot. Exact port ID and metric must match the contract."],
    };
  }
}
