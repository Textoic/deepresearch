import assert from "node:assert/strict";
import test from "node:test";
import { linkSourceReferences } from "../src/citations.ts";

test("bare and grouped citations link only existing source IDs without changing authored links", () => {
  const sources = [{ url: "https://example.test/one", text: "", retrievedAt: "2026-09-07" }, { url: "https://example.test/two", text: "", retrievedAt: "2026-09-07" }];
  const output = linkSourceReferences("A [Source 1]. B [Source 1, Source 2]. Unknown [Source 9]. Existing [Source 1](https://another.test).", sources);
  assert.match(output, /A \[Source 1\]\(https:\/\/example.test\/one\)/);
  assert.match(output, /\[Source 2\]\(https:\/\/example.test\/two\)/);
  assert.match(output, /Unknown \[Source 9\]/);
  assert.match(output, /Existing \[Source 1\]\(https:\/\/another.test\)/);
});
