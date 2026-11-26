import assert from "node:assert/strict";
import { test } from "node:test";
import { editionExcerpts, editionsWordDiff, revisionExcerpts, revisionRows } from "../client/compare.js";
import worker from "../src/worker.js";

const section = (key, title, text, path = [title]) => ({ key, title, text, path });

test("revision diff preserves both sides and can navigate to a removed section", () => {
  const before = [section("s0", "Lead", "The policy was successful."),
    section("s1", "Old section", "An excerpt removed from the article.")];
  const after = [section("s0", "Lead", "The policy was controversial."),
    section("s1", "New section", "An excerpt added to the article.")];
  const rows = revisionRows(before, after);
  assert.deepEqual(rows.map(row => [row.key, row.change]),
    [["s0", "Edited"], ["s1", "Added"], ["removed-s1", "Removed"]]);
  assert.equal(rows[0].parts.filter(part => !part.added).map(part => part.value).join(""), before[0].text);
  assert.equal(rows[0].parts.filter(part => !part.removed).map(part => part.value).join(""), after[0].text);
  assert.ok(rows[0].parts.some(part => part.removed));
  assert.ok(rows[0].parts.some(part => part.added));
  assert.equal(revisionExcerpts(rows, "r123-").left[1].key, "r123-removed-s1");
});

test("revision excerpts show a change after a long unchanged introduction", () => {
  const lead = "An unchanged sentence. ".repeat(180);
  const rows = revisionRows([section("s0", "Lead", lead + "Ultimately rejected.")],
    [section("s0", "Lead", lead + "Ultimately accepted.")]);
  const excerpts = revisionExcerpts(rows);
  assert.match(excerpts.left[0].text, /rejected/);
  assert.match(excerpts.right[0].text, /accepted/);
});

test("translation diff reconstructs both inputs and edition excerpts preserve section IDs", () => {
  const before = "Primer texto.\n\nTambién aquí.";
  const after = "Otro texto.\n\nTambién aquí.";
  const parts = editionsWordDiff(before, after);
  assert.equal(parts.filter(part => !part.added).map(part => part.value).join(""), before);
  assert.equal(parts.filter(part => !part.removed).map(part => part.value).join(""), after);
  const chosen = section("s3", "History", "Una historia");
  assert.deepEqual(editionExcerpts([section("s0", "Lead", before), chosen], chosen), [chosen]);
});

test("AI findings require supplied evidence and valid links between comparison passages", async () => {
  const body = { mode: "revisions",
    left: [{ key: "s0", title: "Lead", text: "The policy was successful." }],
    right: [{ key: "s0", title: "Lead", text: "The policy was controversial." }] };
  const response = await worker.fetch(new Request("https://example.com/api/analysis", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  }), { AI: { run: async () => ({ response: { findings: [
    { leftKey: "s0", rightKey: "s0", leftQuote: "was successful", rightQuote: "was controversial",
      category: "Tone", description: "The wording changes from approval to dispute." },
    { leftKey: "s9", rightKey: "s9", leftQuote: "fabricated evidence", rightQuote: "fabricated evidence",
      category: "Tone", description: "Unsupported finding." }
  ] } }) } });
  assert.equal(response.status, 200);
  const { findings } = await response.json();
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rightKey, "s0");
});

test("AI unavailability leaves the other Worker routes independent", async () => {
  const disabled = await worker.fetch(new Request("https://example.com/api/analysis", { method: "POST" }),
    { AI_DISABLED: "true" });
  assert.equal(disabled.status, 503);
  assert.match((await disabled.json()).error, /disabled/);
  const invalidHost = await worker.fetch(new Request("https://example.com/api/topic?wiki=evil.example&title=Test"), {});
  assert.equal(invalidHost.status, 400);
});
