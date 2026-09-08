import assert from "node:assert/strict";
import test from "node:test";
import { citationIntegrityLimitation, linkSourceReferences, unfoundedCitations } from "../src/citations.ts";

test("bare and grouped citations link only existing source IDs without changing authored links", () => {
  const sources = [{ url: "https://example.test/one", text: "", retrievedAt: "2026-09-07" }, { url: "https://example.test/two", text: "", retrievedAt: "2026-09-07" }];
  const output = linkSourceReferences("A [Source 1]. B [Source 1, Source 2]. Unknown [Source 9]. Existing [Source 1](https://another.test).", sources);
  assert.match(output, /A \[Source 1\]\(https:\/\/example.test\/one\)/);
  assert.match(output, /\[Source 2\]\(https:\/\/example.test\/two\)/);
  assert.match(output, /Unknown \[Source 9\]/);
  assert.match(output, /Existing \[Source 1\]\(https:\/\/another.test\)/);
});

test("a citation to a source that was never retrieved is reported as unfounded", () => {
  const sources = [{ url: "https://www.reuters.com/a", text: "x", retrievedAt: "2026-09-01T00:00:00Z" }];
  const report = "Claim [Source 1](https://www.reuters.com/a) and invention [Source 7](https://www.politico.com/news/2025-02-20/made-up-00123456).";
  const unfounded = unfoundedCitations(report, sources);
  assert.deepEqual(unfounded, [{ number: 7, url: "https://www.politico.com/news/2025-02-20/made-up-00123456", reason: "no such source" }]);
  assert.match(citationIntegrityLimitation(unfounded), /1 citation\(s\) in this report do not correspond to a retrieved source/);
});

test("a citation whose link disagrees with its source is reported, but tracking noise and a URL's own parenthesis are not", () => {
  const sources = [
    { url: "https://ballotpedia.org/Senate_election_(June_2_primary)", text: "x", retrievedAt: "2026-09-01T00:00:00Z" },
    { url: "https://www.reuters.com/story?id=5", text: "x", retrievedAt: "2026-09-01T00:00:00Z" },
  ];
  const clipped = "[Source 1](https://ballotpedia.org/Senate_election_(June_2_primary)";
  const tracked = "[Source 2](https://www.reuters.com/story?id=5&utm_source=x)";
  assert.deepEqual(unfoundedCitations(`${clipped} ${tracked}`, sources), []);
  assert.deepEqual(unfoundedCitations("[Source 2](https://www.reuters.com/other)", sources).map(c => c.reason), ["url does not match the source"]);
});

test("a citation is not matched across a line break into the appended dossiers", () => {
  const sources = [{ url: "https://www.theguardian.com/full/story", text: "x", retrievedAt: "2026-09-01T00:00:00Z" }];
  assert.deepEqual(unfoundedCitations("ends mid-link [Source 1](https://www.theguardian.com/full/story)\n\n# Component research dossiers\n", sources), []);
});
