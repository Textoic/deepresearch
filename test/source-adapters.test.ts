import assert from "node:assert/strict";
import test from "node:test";
import { collectAdapterSources, PythSourceAdapter, PortWatchSourceAdapter, scalePrice, type SourceAdapterContext } from "../src/source-adapters.ts";
const id = "ab".repeat(32);
const context = (): SourceAdapterContext => ({ topic: "WTI", rules: "", urls: ["https://app.pyth.com/explore?search=WTI"], asOf: "2026-09-01T12:00:00Z", signal: AbortSignal.timeout(1000) });
const payload = (time = Date.parse("2026-09-01T11:59:00Z") / 1000) => ({ parsed: [{ id, price: { price: "7123456789", conf: "12345", expo: -8, publish_time: time } }] });
test("PortWatch requires consecutive days for a mean and preserves unknown publication time", async () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ attributes: { date: Date.parse("2026-09-01") - i * 86_400_000, portid: "test", portname: "Test Strait", n_total: 10 } }));
  const adapter = new PortWatchSourceAdapter({ portId: "test", fetchFn: async () => Response.json({ features: rows }) });
  const result = await adapter.fetch(context());
  assert.match(result.documents[0]!.text, /mean: 10/);
  assert.equal(result.documents[0]!.publishedAt, undefined);
  rows[6]!.attributes.date -= 86_400_000;
  assert.match((await adapter.fetch(context())).documents[0]!.text, /mean: unavailable/);
  rows[0]!.attributes.n_total = null as unknown as number;
  await assert.rejects(adapter.fetch(context()), /Invalid PortWatch row/);
});
test("Pyth preserves precision, provenance and authenticated upgraded endpoint", async () => {
  const adapter = new PythSourceAdapter({ feedId: id, apiKey: "test-key", fetchFn: async (url, init) => {
    assert.equal(new URL(String(url)).origin, "https://pyth.dourolabs.app");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer test-key");
    return Response.json(payload());
  } });
  const result = await adapter.fetch(context());
  assert.match(result.documents[0]!.text, /71\.23456789/);
  assert.equal(result.documents[0]?.publishedAt, "2026-09-01T11:59:00.000Z");
  assert.ok(!JSON.stringify(result).includes("test-key"));
  assert.equal(scalePrice("1234567890123456789", -8), "12345678901.23456789");
});
test("Pyth rejects stale, future, ambiguous and malformed observations", async () => {
  for (const time of [0, Date.parse("2027-01-01") / 1000]) {
    const adapter = new PythSourceAdapter({ feedId: id, apiKey: "x", fetchFn: async () => Response.json(payload(time)) });
    assert.equal((await adapter.fetch(context())).documents.length, 0);
  }
  const adapter = new PythSourceAdapter({ feedId: id, apiKey: "x", fetchFn: async () => Response.json({ parsed: [...payload().parsed, ...payload().parsed] }) });
  await assert.rejects(adapter.fetch(context()), /exactly one/);
  assert.throws(() => new PythSourceAdapter({ feedId: "WTI", apiKey: "x" }), /feed ID/);
  assert.throws(() => scalePrice("NaN", -8));
});
test("routing uses exact hosts, deduplicates adapters and discloses failure safely", async () => {
  let calls = 0;
  const adapter = { id: "test", domains: ["app.pyth.com"], async fetch() { calls++; throw new Error("secret-url"); } };
  const result = await collectAdapterSources([adapter, adapter], context());
  assert.equal(calls, 1);
  assert.equal(result.diagnostics[0]?.status, "failed");
  assert.ok(!JSON.stringify(result).includes("secret-url"));
  await collectAdapterSources([adapter], { ...context(), urls: ["https://app.pyth.com.evil.test/"] });
  assert.equal(calls, 1);
});
