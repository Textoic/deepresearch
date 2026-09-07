import assert from "node:assert/strict";
import test from "node:test";
import { PolymarketClient } from "../src/polymarket.ts";

test("Polymarket client encodes slug and returns the first matching event", async () => {
  let requested = "";
  const client = new PolymarketClient(async (input) => {
    requested = String(input);
    return new Response(JSON.stringify([{ id: "1", slug: "a b", title: "Question", resolutionSource: "Official source", markets: [] }]));
  });
  const event = await client.getEventBySlug("a b");
  assert.equal(event.title, "Question");
  assert.match(requested, /slug=a\+b|slug=a%20b/);
});
