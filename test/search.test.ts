import assert from "node:assert/strict";
import test from "node:test";
import { SearxngSearchProvider } from "../src/search/searxng.ts";

test("SearXNG adapter requests JSON and snapshots matching pages", async () => {
  const requested: string[] = [];
  const provider = new SearxngSearchProvider({ baseUrl: "http://searx.local", fetchFn: async (input) => {
    requested.push(String(input));
    if (String(input).includes("/search")) return new Response(JSON.stringify({ results: [{ url: "https://source.test/a", title: "A", content: "snippet" }] }));
    return new Response("<h1>Full page</h1><script>bad()</script>", { headers: { "content-type": "text/html" } });
  } });
  const sources = await provider.search("arena", { limit: 3 });
  assert.equal(sources[0]?.text, "Full page");
  assert.match(requested[0]!, /format=json/);
});

test("challenge pages fall back to snippets and explicit page publication dates are retained", async () => {
  const provider = new SearxngSearchProvider({ baseUrl: "http://searx.local", fetchFn: async input => {
    const url = String(input);
    if (url.includes("/search")) return new Response(JSON.stringify({ results: [{ url: "https://source.test/blocked", content: "Discovery only" }, { url: "https://source.test/article" }] }));
    return new Response(url.endsWith("blocked") ? "<h1>Prove your humanity</h1>" : '<meta property="article:published_time" content="2026-09-01T12:00:00Z"><p>Dated official announcement.</p>', { headers: { "content-type": "text/html" } });
  } });
  const sources = await provider.search("query", { limit: 2 });
  assert.equal(sources[0]?.retrievalKind, "snippet");
  assert.equal(sources[0]?.text, "Discovery only");
  assert.equal(sources[1]?.publishedAt, "2026-09-01T12:00:00.000Z");
});
