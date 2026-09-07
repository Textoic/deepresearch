// Network-free CLI integration test. Unexpected requests fail instead of reaching the web.
import assert from "node:assert/strict";
let searches = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input);
  if (url.hostname === "gamma-api.polymarket.com") {
    return Response.json([{ id: "test", slug: url.searchParams.get("slug"), title: "Arena fixture", resolutionSource: "https://arena.ai/leaderboard/text/overall-no-style-control", markets: [] }]);
  }
  if (url.origin === "http://127.0.0.1:8080" && url.pathname === "/search") {
    searches++;
    return Response.json({ results: [{ url: "https://evidence.test/methodology", title: "Arena methodology", content: "snippet" }] });
  }
  if (url.hostname === "evidence.test") return new Response("<p>Evidence from a full page</p>", { headers: { "content-type": "text/html" } });
  if (url.origin === "http://127.0.0.1:11434" && url.pathname === "/api/chat") {
    assert.equal(searches, 2);
    const request = JSON.parse(init.body);
    assert.equal(request.model, "qwen3.8:27b");
    assert.match(request.messages[1].content, /Evidence from a full page/);
    assert.match(request.messages[1].content, /Separates public release/);
    return Response.json({ message: { content: "# Fixture report" }, prompt_eval_count: 100, eval_count: 10 });
  }
  throw new Error(`Unexpected test request: ${url}`);
};
