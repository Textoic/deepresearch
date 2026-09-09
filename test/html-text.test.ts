import assert from "node:assert/strict";
import test from "node:test";
import { htmlToText, isReadableProse, proseQuality } from "../src/search/html-text.ts";

const article = (body: string) => `<!DOCTYPE html><html><head><title>t</title></head><body>${body}${"<p>Filler sentence that carries enough words to read as ordinary prose.</p>".repeat(40)}</body></html>`;

test("a stylesheet truncated before its closing tag does not leak into the text", () => {
  const truncated = `<html><head><style>@font-face { font-family: "cnn_sans"; src: url(/a.woff2); } .source__cite{line-height:1.75rem}`;
  const text = htmlToText(truncated + article("<p>Israel will withdraw from two areas in southern Lebanon under the agreement.</p>"));
  assert.ok(!text.includes("font-family"), text.slice(0, 200));
  assert.ok(!text.includes("line-height"));
  assert.match(text, /Israel will withdraw from two areas/);
});

test("a script truncated before its closing tag does not leak embedded JSON", () => {
  const truncated = `<html><body><script>var ytInitialData = {"contents":{"twoColumnWatchNextResults":{"results":`;
  assert.equal(htmlToText(truncated), "");
});

test("JSON inside a quoted attribute never escapes as body text", () => {
  const page = article(`<span class="mw-empty-elt" data-mw='{"parts":[{"template":{"target":{"wt":"Infobox"}},"seats_before1":{"wt":"310"}}]}'>x</span><p>Legislative elections are scheduled to be held in Russia in September 2026.</p>`);
  const text = htmlToText(page);
  assert.ok(!text.includes("seats_before1"), text.slice(0, 200));
  assert.ok(!text.includes('"wt"'));
  assert.match(text, /Legislative elections are scheduled/);
});

test("navigation soup is dropped while article sentences survive", () => {
  const nav = "<div>Saudi Arabia News The Place The Space Who&#x27;s Who KSA Today Green &amp; Blue Middle East World Business Insight Energy Finance</div>";
  const text = htmlToText(article(`${nav}<p>The minister said the army would not withdraw from the security zones this year.</p>`));
  assert.ok(!text.includes("KSA Today"), text.slice(0, 300));
  assert.match(text, /the army would not withdraw/);
});

test("entities are decoded rather than shown as escapes", () => {
  const text = htmlToText(article("<p>Israel&#x27;s cabinet met &amp; agreed the plan, according to a spokesperson.</p>"));
  assert.match(text, /Israel's cabinet met & agreed the plan/);
});

test("an unterminated layout element does not erase the rest of the document", () => {
  const text = htmlToText(article("<form action='/search'><p>A short official announcement was published by the ministry today.</p>"));
  assert.match(text, /A short official announcement/);
});

test("a small document keeps its text without boilerplate filtering", () => {
  const text = htmlToText("<h1>Full page</h1><script>bad()</script>");
  assert.equal(text, "Full page");
  assert.ok(isReadableProse(text, 40));
});

test("a large page that yields almost no text is rejected, a small one is not", () => {
  const short = "The director resigned today.";
  assert.ok(isReadableProse(short, 1500));
  assert.ok(!isReadableProse(short, 90_000));
  assert.ok(!isReadableProse("", 100));
});

test("text that is mostly stylesheet or JSON is rejected however long it is", () => {
  const css = ".a{line-height:1.75rem;font-weight:700}".repeat(40);
  assert.ok(proseQuality(css).codeArtifactsPer1000 > 6);
  assert.ok(!isReadableProse(css, 5000));
});
