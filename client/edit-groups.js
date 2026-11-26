import { compareSources } from "./citations.js";

const sourceHint = /\b(?:sources?|sourcing|cites?|citations?|refs?|references?|footnotes?|coverage|reports?)\b/iu;
const sourceAction = /\b(?:add\w*|remov\w*|replac\w*|trim\w*|more|unreliab\w*|primary|secondary|deprecat\w*)\b/iu;
const maintenance = /#IABot|#UCB_toolbar|\brescuing \d+ sources|\bcitation formatting\b/iu;
const framing = /\b(?:alleg\w*|attribut\w*|claim\w*|disput\w*|critic\w*|according to|report\w*|recogniz\w*|controvers\w*|illegal\w*|revers\w*|war|law|designat\w*)\b/iu;
const groupWindow = 125 * 86400000;
const emptySources = new Map();

const tokens = key => key.split(" ");
const wordCount = key => key ? tokens(key).length : 0;
const meaningful = key => wordCount(key) >= 6 || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{12}/u.test(key);
const ordered = (a, b) => a.date.localeCompare(b.date) || a.id - b.id;

export function selectEdits(revisions, baseline) {
  const metadata = new Map(revisions.map(revision => [revision.id, revision]));
  if (baseline) metadata.set(baseline.id, baseline);
  const candidates = revisions.filter(revision => {
    const parent = metadata.get(revision.parent);
    return revision.parent && (!revision.hash || revision.hash !== parent?.hash);
  });
  if (candidates.length <= 60) return [...candidates].sort(ordered);

  const scored = candidates.map(revision => {
    const parent = metadata.get(revision.parent);
    const delta = revision.size != null && parent?.size != null ? Math.abs(revision.size - parent.size) : 0;
    const comment = revision.comment || "";
    const hinted = sourceHint.test(comment);
    const citation = hinted && sourceAction.test(comment) && !maintenance.test(comment);
    return { revision, delta, hinted, citation,
      weight: delta + (hinted ? 900 : 0),
      citationWeight: (delta >= 20 && delta <= 2200 ? 3 : 0) + (sourceAction.test(comment) ? 2 : 0)
        + (/\b(?:primary|unreliab\w*|replace\w*|deprecat\w*)\b/iu.test(comment) ? 2 : 0) };
  });
  const wording = scored.filter(item => item.delta >= 750 || item.delta >= 250 && item.hinted)
    .sort((a, b) => b.weight - a.weight || ordered(a.revision, b.revision)).slice(0, 60);
  const included = new Set(wording.map(item => item.revision.id));
  // Spread source candidates across the range before filling the remaining slots by score.
  const sources = scored.filter(item => item.citation && !included.has(item.revision.id))
    .sort((a, b) => b.citationWeight - a.citationWeight || ordered(a.revision, b.revision));
  const years = new Set();
  const spread = sources.filter(item => {
    const year = item.revision.date.slice(0, 4);
    if (years.has(year)) return false;
    years.add(year);
    return true;
  }).slice(0, 12);
  const first = new Set(spread);
  const citation = [...spread, ...sources.filter(item => !first.has(item))].slice(0, 36);
  const picked = [...wording, ...citation];
  const selected = new Set(picked.map(item => item.revision.id));
  if (picked.length < 60) {
    picked.push(...scored.filter(item => !selected.has(item.revision.id))
      .sort((a, b) => b.weight - a.weight || ordered(a.revision, b.revision)).slice(0, 60 - picked.length));
  }
  return picked.map(item => item.revision).sort(ordered);
}

function grams(key, size) {
  const words = tokens(key);
  const result = new Set();
  for (let i = 0; i + size <= words.length; i += 1) result.add(words.slice(i, i + size).join(" "));
  return result;
}

function shared(left, right) {
  let overlap = 0;
  for (const value of left) if (right.has(value)) overlap += 1;
  return overlap;
}

function makeMatcher(size) {
  const cache = new Map();
  function get(key) {
    if (!cache.has(key)) cache.set(key, grams(key, size));
    return cache.get(key);
  }
  return (left, right) => similarity(left, right, get);
}

function similarity(left, right, get) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const a = get(left);
  const b = get(right);
  return a.size && b.size ? 2 * shared(a, b) / (a.size + b.size) : 0;
}

function signature(sources) {
  return [...(sources ?? emptySources).keys()].sort().join("\n");
}

function makeChange(left, right, kind) {
  const passage = right ?? left;
  const sources = compareSources(left?.sources ?? emptySources, right?.sources ?? emptySources);
  const count = sources.removed.length + sources.added.length;
  const weight = kind === "citation" ? 3 + Math.min(4, count)
    : 3 + Math.min(3, Math.abs(wordCount(left?.key) - wordCount(right?.key)) / 8)
      + Number(passage.section === "Lead") + 2 * Number(framing.test(passage.text));
  return { left, right, kind, section: passage.section, sectionKey: passage.sectionKey, sources, weight };
}

function flatten(sections) {
  return sections.flatMap(section => section.passages.map(passage => ({
    ...passage, section: section.title, sectionKey: section.key
  })));
}

function indexBy(items, getKey) {
  const index = new Map();
  for (const [position, item] of items.entries()) {
    const key = getKey(item, position);
    const values = index.get(key) ?? [];
    values.push(item);
    index.set(key, values);
  }
  return index;
}

function joinedPassages(sections) {
  const keys = new Set();
  for (const { passages } of sections) {
    for (let i = 1; i < passages.length; i += 1) {
      keys.add(`${passages[i - 1].key} ${passages[i].key}`);
      if (i >= 2) keys.add(`${passages[i - 2].key} ${passages[i - 1].key} ${passages[i].key}`);
    }
  }
  return keys;
}

function splitPassages(whole, sections) {
  const keys = new Set();
  for (const { passages } of sections) {
    for (let i = 1; i < passages.length; i += 1) {
      const a = passages[i - 1].key;
      const b = passages[i].key;
      if (whole.has(`${a} ${b}`)) { keys.add(a); keys.add(b); }
      if (i >= 2) {
        const c = passages[i - 2].key;
        if (whole.has(`${c} ${a} ${b}`)) { keys.add(c); keys.add(a); keys.add(b); }
      }
    }
  }
  return keys;
}

export function passageChanges(before, after, { includeWording = true } = {}) {
  const left = flatten(before);
  const right = flatten(after);
  const oldIndex = indexBy(left, item => item.key);
  const newIndex = indexBy(right, item => item.key);
  const result = [];
  for (const [key, earlier] of oldIndex) {
    const later = newIndex.get(key);
    if (!later) continue;
    const remaining = new Set(later);
    for (const a of earlier) {
      const matches = [...remaining].filter(item => item.sectionKey === a.sectionKey);
      const b = matches.find(item => signature(item.sources) === signature(a.sources)) ?? matches[0]
        ?? (earlier.length === 1 && later.length === 1 ? later[0] : null);
      if (!b) continue;
      remaining.delete(b);
      if (signature(a.sources) !== signature(b.sources)) result.push(makeChange(a, b, "citation"));
    }
  }

  const deleted = left.filter(item => !newIndex.has(item.key) && meaningful(item.key));
  const inserted = right.filter(item => !oldIndex.has(item.key) && meaningful(item.key));
  if (!deleted.length && !inserted.length) return result;
  const oldJoined = joinedPassages(before);
  const newJoined = joinedPassages(after);
  const oldSplit = splitPassages(newIndex, before);
  const newSplit = splitPassages(oldIndex, after);
  const beforeOnly = deleted.filter(item => !newJoined.has(item.key) && !oldSplit.has(item.key));
  const afterOnly = inserted.filter(item => !oldJoined.has(item.key) && !newSplit.has(item.key));
  const bySection = indexBy(afterOnly, item => item.sectionKey);
  const match = makeMatcher(2);
  const paired = [];
  for (const a of beforeOnly) {
    for (const b of bySection.get(a.sectionKey) ?? []) {
      const overlap = match(a.key, b.key);
      if (overlap >= 0.46) paired.push({ a, b, overlap });
    }
  }
  paired.sort((a, b) => b.overlap - a.overlap);
  const usedBefore = new Set();
  const usedAfter = new Set();
  for (const { a, b } of paired) {
    if (usedBefore.has(a) || usedAfter.has(b)) continue;
    usedBefore.add(a);
    usedAfter.add(b);
    const change = makeChange(a, b, "wording");
    if (includeWording || change.sources.added.length || change.sources.removed.length) result.push(change);
  }
  if (includeWording) {
    for (const a of beforeOnly) if (!usedBefore.has(a)) result.push(makeChange(a, null, "wording"));
    for (const b of afterOnly) if (!usedAfter.has(b)) result.push(makeChange(null, b, "wording"));
  }
  return result.sort((a, b) => b.weight - a.weight);
}

export function editEvidence(revision, before, after) {
  const seen = new Map();
  const changes = passageChanges(before, after).filter(change => {
    if (change.kind === "citation" && maintenance.test(revision.comment || "")) return false;
    const count = seen.get(change.sectionKey) ?? 0;
    seen.set(change.sectionKey, count + 1);
    return count < 4;
  }).slice(0, 9);
  return { revision, changes };
}

function passageKeys(change) {
  return [change.left, change.right].filter(Boolean).map(item => item.key).filter(meaningful);
}

function matches(left, right, min, match) {
  return left.some(a => right.some(b => match(a, b) >= min));
}

function related(a, b, match) {
  const left = passageKeys(a);
  const right = passageKeys(b);
  if (a.sectionKey !== b.sectionKey) {
    return left.some(key => wordCount(key) >= 12 && right.includes(key));
  }
  if (matches(left, right, 0.4, match)) return true;
  if (a.kind === b.kind) return false;
  const citation = a.kind === "citation" ? a : b;
  const wording = citation === a ? right : left;
  return matches(wording, (citation.right?.context ?? []).filter(meaningful), 0.55, match);
}

function isInverse(a, b) {
  if ((a.left?.key ?? "") !== (b.right?.key ?? "") || (a.right?.key ?? "") !== (b.left?.key ?? "")) return false;
  if (a.kind === "wording" && b.kind === "wording") return true;
  return a.kind === b.kind && signature(a.left?.sources) === signature(b.right?.sources)
    && signature(a.right?.sources) === signature(b.left?.sources);
}

function outcome(changes, endpoint, match) {
  if (!endpoint) return null;
  const earlier = new Map(), later = new Map();
  let best = { strength: 0, passage: null };
  const variants = new Map();
  for (const change of changes) {
    for (const passage of [change.left, change.right]) {
      if (!passage) continue;
      variants.set(passage.key, passage);
      for (const [key, source] of passage.sources) earlier.set(key, source);
    }
  }
  for (const variant of variants.values()) {
    let closest = { strength: 0, passage: null };
    for (const passage of endpoint) {
      const score = variant.key === passage.key ? 1
        : variant.sectionKey === passage.sectionKey ? match(variant.key, passage.key) : 0;
      if (score > closest.strength) closest = { strength: score, passage };
      if (closest.strength === 1 && closest.passage.sectionKey === variant.sectionKey) break;
    }
    if (closest.strength < 0.54) continue;
    if (closest.strength > best.strength) best = closest;
    for (const [key, source] of closest.passage.sources) later.set(key, source);
  }
  if (!best.passage) return { status: "Sampled wording absent" };
  return {
    status: best.strength === 1 ? "Sampled wording present" : "Related wording present",
    text: best.passage.text, section: best.passage.section,
    sources: compareSources(earlier, later)
  };
}

export function groupEdits(edits, endpoint) {
  const nodes = edits.flatMap(edit => edit.changes.map(change => ({
    revision: edit.revision, change, time: Date.parse(edit.revision.date)
  }))).sort((a, b) => ordered(a.revision, b.revision));
  const parents = nodes.map((_, index) => index);
  const match = makeMatcher(4);
  const matchEndpoint = makeMatcher(3);
  const endpointPassages = endpoint ? flatten(endpoint) : null;
  function root(index) {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  }
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length && nodes[j].time - nodes[i].time <= groupWindow; j += 1) {
      if (nodes[i].revision.id !== nodes[j].revision.id && related(nodes[i].change, nodes[j].change, match)) parents[root(j)] = root(i);
    }
  }
  const clusters = [...indexBy(nodes, (_, index) => root(index)).values()]
    .filter(cluster => new Set(cluster.map(item => item.revision.id)).size >= 2)
    .sort((a, b) => b.length - a.length);
  const groups = [];
  for (const cluster of clusters) {
    const byEdit = [...indexBy(cluster, item => item.revision.id).values()];
    const events = byEdit.map(items => ({ revision: items[0].revision, changes: items.map(item => item.change) }));
    const ids = new Set(events.map(event => event.revision.id));
    if (groups.some(group => group.events.length === events.length && group.events.every(event => ids.has(event.revision.id)))) continue;
    for (let index = 1; index < events.length; index += 1) {
      const event = events[index];
      const previous = events.slice(0, index).findLast(earlier =>
        event.changes.some(change => earlier.changes.some(old => isInverse(old, change))));
      if (previous) event.reverses = previous.revision;
    }
    const changes = cluster.map(item => item.change);
    const strongest = changes.reduce((a, b) => a.weight >= b.weight ? a : b);
    groups.push({ events, section: strongest.section, title: (strongest.right ?? strongest.left).text,
      outcome: outcome(changes, endpointPassages, matchEndpoint) });
    if (groups.length === 20) break;
  }
  return groups;
}

export function nearbyEdits(groups, revisions, inspected) {
  const timeline = [...revisions].sort(ordered);
  const locations = new Map(timeline.map((item, index) => [item.id, index]));
  const next = new Map();
  for (const group of groups) {
    if (group.events.length < 3) continue;
    for (let i = 1; i < group.events.length; i += 1) {
      const start = locations.get(group.events[i - 1].revision.id);
      const end = locations.get(group.events[i].revision.id);
      if (end - start < 2 || end - start > 16) continue;
      for (const item of timeline.slice(start + 1, end)) {
        if (!item.parent || inspected.has(item.id)) continue;
        if (end - start <= 7 || sourceHint.test(item.comment || "")) next.set(item.id, item);
      }
    }
  }
  return [...next.values()].sort(ordered).slice(0, 24);
}
