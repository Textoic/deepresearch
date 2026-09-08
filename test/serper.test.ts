import assert from "node:assert/strict";
import test from "node:test";
import { FallbackSearchProvider, SerperSearchProvider } from "../src/index.ts";
import { absoluteFromHint } from "../src/search/page-content.ts";
import type { SearchProvider } from "../src/types.ts";

function organic(payload: unknown) {
  return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
}

test("Serper posts the documented request and maps organic results to sources", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const provider = new SerperSearchProvider({ apiKey: "k-123", fetchPages: false, fetchFn: async (input, init) => {
    seen.push({ url: String(input), init: init! });
    return organic({ organic: [{ title: "A", link: "https://www.reuters.com/a", snippet: "text", date: "2 days ago" }, { link: "not-a-url" }] });
  } });
  const sources = await provider.search("press secretary", { limit: 6 });
  assert.equal(seen[0]!.url, "https://google.serper.dev/search");
  assert.equal(seen[0]!.init.method, "POST");
  assert.equal((seen[0]!.init.headers as Record<string, string>)["X-API-KEY"], "k-123");
  assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), { q: "press secretary", num: 10, gl: "us", hl: "en" });
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.url, "https://www.reuters.com/a");
  assert.equal(sources[0]?.sourceTier, 2);
  assert.equal(sources[0]?.retrievalKind, "snippet");
});

test("a freshness window and a wider result count reach the request body", async () => {
  let body: Record<string, unknown> = {};
  const provider = new SerperSearchProvider({ apiKey: "k", fetchPages: false, freshness: "qdr:w", country: "gb", language: "en",
    fetchFn: async (_input, init) => { body = JSON.parse(String(init!.body)); return organic({ organic: [] }); } });
  await provider.search("q", { limit: 25 });
  assert.deepEqual(body, { q: "q", num: 25, gl: "gb", hl: "en", tbs: "qdr:w" });
});

test("Serper turns credential and quota failures into actionable errors", async () => {
  const failing = (status: number) => new SerperSearchProvider({ apiKey: "k", fetchPages: false, fetchFn: async () => new Response("", { status }) });
  await assert.rejects(failing(401).search("q", { limit: 3 }), /rejected the API key/);
  await assert.rejects(failing(403).search("q", { limit: 3 }), /rejected the API key/);
  await assert.rejects(failing(429).search("q", { limit: 3 }), /credits exhausted/);
  await assert.rejects(failing(500).search("q", { limit: 3 }), /Serper returned 500/);
  assert.throws(() => new SerperSearchProvider({ apiKey: "  " }), /requires an API key/);
});

test("a relative publication hint becomes a date only when it can be read, and the page's own date wins", async () => {
  assert.equal(absoluteFromHint("2 days ago", "2026-09-08T00:00:00Z"), "2026-09-06");
  assert.equal(absoluteFromHint("Sep 3, 2026", "2026-09-08T00:00:00Z"), "2026-09-03");
  assert.equal(absoluteFromHint("sometime recently", "2026-09-08T00:00:00Z"), undefined);
  assert.equal(absoluteFromHint(undefined, "2026-09-08T00:00:00Z"), undefined);

  const provider = new SerperSearchProvider({ apiKey: "k", fetchFn: async input => {
    if (String(input).includes("serper.dev")) return organic({ organic: [{ link: "https://www.reuters.com/a", date: "2 days ago" }] });
    return new Response('<meta property="article:published_time" content="2026-08-30T09:00:00Z"><p>Body text here.</p>', { headers: { "content-type": "text/html" } });
  } });
  const sources = await provider.search("q", { limit: 3 });
  assert.equal(sources[0]?.publishedAt, "2026-08-30T09:00:00.000Z");
});

test("the fallback chain uses the second provider only when the first fails, and reports total failure", async () => {
  const boom: SearchProvider = { async search() { throw new Error("credits exhausted"); } };
  const good: SearchProvider = { async search() { return [{ url: "https://www.reuters.com/b", text: "backup", retrievedAt: "2026-09-08T00:00:00Z" }]; } };
  const chain = new FallbackSearchProvider([{ id: "serper", provider: boom }, { id: "searxng", provider: good }]);
  assert.equal((await chain.search("q", { limit: 3 }))[0]?.text, "backup");
  assert.ok(chain.diagnostics.some(d => d.startsWith("serper: ")));

  let secondCalls = 0;
  const counted: SearchProvider = { async search() { secondCalls++; return []; } };
  const primaryWins = new FallbackSearchProvider([{ id: "serper", provider: good }, { id: "searxng", provider: counted }]);
  await primaryWins.search("q", { limit: 3 });
  assert.equal(secondCalls, 0);

  const allDead = new FallbackSearchProvider([{ id: "serper", provider: boom }, { id: "searxng", provider: boom }]);
  await assert.rejects(allDead.search("q", { limit: 3 }), /Every search provider failed/);
});

test("a genuinely empty answer from every provider is empty, not a failure", async () => {
  const quiet: SearchProvider = { async search() { return []; } };
  const chain = new FallbackSearchProvider([{ id: "serper", provider: quiet }, { id: "searxng", provider: quiet }]);
  assert.deepEqual(await chain.search("query with no matches", { limit: 3 }), []);
});

test("an absolute date hint keeps its wall-clock day regardless of the machine timezone", () => {
  for (const tz of ["UTC", "Pacific/Kiritimati", "Pacific/Midway"]) {
    process.env.TZ = tz;
    assert.equal(absoluteFromHint("Sep 3, 2026", "2026-09-08T00:00:00Z"), "2026-09-03", `failed in ${tz}`);
  }
  delete process.env.TZ;
});
