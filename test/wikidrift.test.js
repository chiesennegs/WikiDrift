import assert from "node:assert/strict";
import { test } from "node:test";
import { editionExcerpts, editionsWordDiff, revisionExcerpts, revisionRows } from "../client/compare.js";
import { calendarCount, monthWindow } from "../client/revision-picker.js";
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

test("calendar periods include leap days and identify incomplete activity", () => {
  assert.deepEqual(monthWindow(2024, 2), { first: "2024-02-01", last: "2024-02-29", days: 29 });
  const days = { "2024-02-29": 3, "2024-02-14": 500, "2024-03-01": 7 };
  const partial = { days, cursor: "next", oldest: "2024-02-14" };
  assert.deepEqual(calendarCount(partial, "2024-02"), { count: 503, complete: false });
  assert.deepEqual(calendarCount(partial, "2024-03"), { count: 7, complete: true });
  assert.deepEqual(calendarCount(partial, "2024-01"), { count: 0, complete: false });
  assert.deepEqual(calendarCount({ ...partial, cursor: null }, "2024-01"), { count: 0, complete: true });
});

test("activity counts edits by UTC day and exposes Wikimedia's continuation", async t => {
  t.mock.method(globalThis, "fetch", async url => {
    const { searchParams } = url;
    assert.equal(searchParams.get("rvstart"), "2024-12-31T23:59:59Z");
    assert.equal(searchParams.get("rvend"), "2024-01-01T00:00:00Z");
    assert.equal(searchParams.get("rvcontinue"), "old-cursor");
    return Response.json({ continue: { rvcontinue: "next-cursor" }, query: { pages: [
      { ns: 0, revisions: [{ timestamp: "2024-02-29T23:59:59Z" }, { timestamp: "2024-02-29T00:00:00Z" }] }
    ] } });
  });
  const result = await worker.fetch(new Request("https://example.com/api/activity?wiki=en&page=2&year=2024&cursor=old-cursor"), {});
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { days: { "2024-02-29": 2 }, cursor: "next-cursor", oldest: "2024-02-29" });
});

test("a date range filters revision browsing independently of the main timeline", async t => {
  t.mock.method(globalThis, "fetch", async url => {
    assert.equal(url.searchParams.get("rvstart"), "2024-02-29T23:59:59Z");
    assert.equal(url.searchParams.get("rvend"), "2024-02-01T00:00:00Z");
    return Response.json({ query: { pages: [{ ns: 0, pageid: 2, title: "Example", revisions: [
      { revid: 123, parentid: 122, user: "Example", timestamp: "2024-02-12T08:00:00Z" }
    ] }] } });
  });
  const result = await worker.fetch(new Request("https://example.com/api/revisions?wiki=en&page=2&date=2024-02-29&after=2024-02-01"), {});
  assert.equal(result.status, 200);
  assert.equal((await result.json()).revisions[0].id, 123);
});

test("author status distinguishes local restrictions, global restrictions, and unlocked accounts", async t => {
  t.mock.method(globalThis, "fetch", async url => {
    assert.equal(url.searchParams.get("usprop"), "blockinfo");
    assert.equal(url.searchParams.get("gusprop"), "locked");
    return Response.json({ query: { users: [
      { name: "Case A", blockid: 5, blockexpiry: "infinite" },
      { name: "Case B", blockedby: "Blocked by", blockpartial: true, blockexpiry: "2028-01-01T00:00:00Z" },
      { name: "Case C" }, { name: "Case D" }, { name: "Case E" }
    ], globalusers: [{ name: "Case C", locked: true }, { name: "Case E", locked: false }],
    globalblocks: [{ target: "Case D", expiry: "infinite" }] } });
  });
  const params = new URLSearchParams({ wiki: "en", users: "Case A|Case B|Case C|Case D|Case E" });
  const result = await worker.fetch(new Request(`https://example.com/api/author-status?${params}`), {});
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).map(item => item.restriction), ["local-block", "partial-block", "global-lock", "global-block", null]);
});
