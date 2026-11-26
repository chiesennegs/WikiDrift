import assert from "node:assert/strict";
import test from "node:test";
import { readCitations } from "../client/citations.js";
import { editEvidence, groupEdits, nearbyEdits, passageChanges, selectEdits } from "../client/edit-groups.js";
import { createRevisionSources } from "../client/revision-sources.js";
import worker from "../src/worker.js";

const cite = (domain, title) => `<ref>{{cite web|url=https://${domain}/record|title=${title}}}</ref>`;
const bulletin = cite("bulletin.example", "Transit bulletin");
const minutes = cite("council.example", "Council minutes");
const schedule = "The valley shuttle runs twice an hour between the visitor center and the upper trailhead.";
const detail = "The valley shuttle runs twice an hour between the visitor center and the upper trailhead during the summer season.";
const article = text => `'''Valley shuttle''' is a transit service.\n\n== Service ==\n${text}\n\n== References ==\n{{reflist}}`;
const record = (id, extra = {}) => ({ id, parent: id - 1, date: `2025-02-${String(id).padStart(2, "0")}T12:00:00Z`, ...extra });
const parse = text => readCitations(article(text), "en");

test("recognizes citation-only additions and keeps nested and named sources attached to their passages", () => {
  const withFootnote = `${schedule}{{efn|A note with ${bulletin}}} Another local route also runs at weekends.<ref name="minutes" />`;
  const withDefinition = text => article(text).replace("{{reflist}}", `{{reflist|refs=${minutes.replace("<ref>", '<ref name="minutes">')}}}`);
  const before = readCitations(withDefinition(withFootnote), "en");
  const after = readCitations(withDefinition(withFootnote.replace(" Another", `${minutes} Another`)), "en");
  const [change, ...rest] = passageChanges(before, after);
  assert.equal(rest.length, 0);
  assert.equal(change.kind, "citation");
  assert.equal(change.section, "Service");
  assert.equal(change.left.text, schedule);
  assert.deepEqual(change.sources.added.map(item => item.title), ["Council minutes"]);
  assert.deepEqual(change.sources.kept.map(item => item.title), ["Transit bulletin"]);
  assert.deepEqual(change.sources.removed, []);
});

test("ignores archival rewrites and prose moves, splits and spelling variants", () => {
  const before = parse(`${schedule}${bulletin} The original programme ran from May to August each year.`);
  const afterText = article(`The original program ran from May to August each year.\n\n== Connections ==\n${schedule}${bulletin.replace("https://bulletin.example/record", "https://web.archive.org/web/20240102/http://www.bulletin.example/record?utm_source=test")}`);
  assert.deepEqual(passageChanges(before, readCitations(afterText, "en")), []);
  const joined = "The first route opened in spring, the second route opened in autumn.";
  const split = "The first route opened in spring. The second route opened in autumn.";
  assert.deepEqual(passageChanges(parse(joined), parse(split)), []);
});

test("groups wording and source edits, detects reversals and checks the ending citation state", () => {
  const states = ["", detail + bulletin, schedule + bulletin, "", schedule + bulletin,
    schedule + bulletin + minutes, schedule + bulletin].map(parse);
  const edits = states.slice(1).map((after, index) => editEvidence(record(index + 2), states[index], after));
  const [group, ...rest] = groupEdits(edits, states.at(-1));
  assert.equal(rest.length, 0);
  assert.deepEqual(group.events.map(event => event.revision.id), [2, 3, 4, 5, 6, 7]);
  assert.equal(group.events[3].reverses.id, 4);
  assert.equal(group.events[5].reverses.id, 6);
  assert.equal(group.outcome.status, "Sampled wording present");
  assert.deepEqual(group.outcome.sources.kept.map(item => item.title), ["Transit bulletin"]);
  assert.deepEqual(group.outcome.sources.removed.map(item => item.title), ["Council minutes"]);
  assert.equal(groupEdits(edits.slice(0, 3), states[3])[0].outcome.status, "Sampled wording absent");
  const timeline = Array.from({ length: 8 }, (_, index) => record(index + 1));
  assert.deepEqual(nearbyEdits([{ events: [2, 5, 7].map(id => ({ revision: timeline[id - 1] })) }],
    timeline, new Set([2, 5, 7])).map(item => item.id), [3, 4, 6]);
});

test("keeps a small citation edit in the shortlist for a busy article", () => {
  const revisions = Array.from({ length: 180 }, (_, index) => {
    const date = new Date(Date.UTC(2020, 0, index + 1)).toISOString();
    return record(index + 1, { date, size: 100_000 + index * 1100 });
  });
  revisions[155].size = revisions[154].size + 45;
  revisions[155].comment = "Remove primary sourcing from a paragraph";
  const picked = selectEdits(revisions);
  assert.ok(picked.length <= 96);
  assert.ok(picked.some(item => item.id === 156));
});

test("revision source batches reuse matching hashes and exclude unavailable or other-page revisions", async () => {
  const calls = [];
  const load = createRevisionSources(async (route, params) => {
    assert.equal(route, "wikitext");
    calls.push(params.ids);
    return { query: { pages: [
      { pageid: 100, ns: 0, revisions: [{ revid: 10, slots: { main: { content: article(schedule) } } }, { revid: 12 }] },
      { pageid: 200, ns: 0, revisions: [{ revid: 13, slots: { main: { content: article(schedule) } } }] }
    ] } };
  });
  const topic = { wiki: "en", id: 100 };
  const first = await load(topic, [record(10, { hash: "same" }), record(11, { hash: "same" }), record(12), record(13)]);
  assert.deepEqual([...first.keys()], [10, 11]);
  assert.equal(first.get(10), first.get(11));
  const second = await load(topic, [record(14, { hash: "same" })]);
  assert.equal(second.get(14), first.get(10));
  assert.deepEqual(calls, ["10,12,13"]);
});

test("streams the batch wikitext API and validates revision IDs and batch size", async t => {
  t.mock.method(globalThis, "fetch", async url => {
    const { hostname, searchParams } = new URL(url);
    assert.equal(hostname, "en.wikipedia.org");
    assert.equal(searchParams.get("revids"), "8|9");
    assert.equal(searchParams.get("rvprop"), "ids|content");
    assert.equal(searchParams.get("rvslots"), "main");
    return Response.json({ query: { pages: [] } });
  });
  const api = path => worker.fetch(new Request(`https://app.example/api/wikitext?wiki=en&ids=${path}`), {}, {});
  assert.deepEqual(await (await api("9,8,8")).json(), { query: { pages: [] } });
  assert.equal((await api("8,bad")).status, 400);
  assert.equal((await api(Array.from({ length: 21 }, (_, i) => i + 1).join(","))).status, 400);
});
