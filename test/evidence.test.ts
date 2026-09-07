import assert from "node:assert/strict";
import test from "node:test";
import { selectEvidence } from "../src/evidence.ts";
import type { SourceDocument } from "../src/types.ts";
const cutoff = "2026-09-01T12:00:00Z";
const source = (overrides: Partial<SourceDocument> = {}): SourceDocument => ({ url: "https://example.test/data", text: "evidence", publishedAt: "2026-08-31", retrievedAt: "2026-09-01T10:00:00Z", ...overrides });
test("future duplicate cannot shadow an eligible snapshot", () => {
  const result = selectEvidence([source({ publishedAt: "2027-01-01" }), source()], cutoff);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0]?.publishedAt, "2026-08-31");
  assert.match(result.excluded[0]!.reason, /after cutoff/);
});
test("full pages replace tracking URL snippets but semantic parameters survive", () => {
  const result = selectEvidence([source({ url: "https://example.test/data?utm_source=x#foo", retrievalKind: "snippet" }), source({ retrievalKind: "page" }), source({ url: "https://example.test/data?board=math" })], cutoff);
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0]?.retrievalKind, "page");
});
test("strict cutoff excludes unknown publication and later-retrieved revisions", () => {
  const input = [source({ publishedAt: undefined }), source({ publishedAt: "invalid" }), source({ retrievedAt: "2026-09-02" }), source()];
  const strict = selectEvidence(input, cutoff, "strict");
  assert.equal(strict.sources.length, 1);
  assert.equal(strict.excluded.length, 3);
  const disclosed = selectEvidence(input, cutoff);
  assert.equal(disclosed.warnings.length, 2);
});
