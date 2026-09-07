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
