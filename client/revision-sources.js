import { readCitations } from "./citations.js";

const cacheLimit = 12_000_000;
const batchLimit = 4_000_000;

export function createRevisionSources(api) {
  const cache = new Map();
  let size = 0;
  function remember(key, entry) {
    if (entry.size > cacheLimit) return;
    size -= cache.get(key)?.size ?? 0;
    cache.delete(key);
    cache.set(key, entry);
    size += entry.size;
    for (const [first, item] of cache) {
      if (size <= cacheLimit) break;
      size -= item.size;
      cache.delete(first);
    }
  }

  return async function revisionSources(article, revisions, signal) {
    const keyFor = revision => `${article.wiki}:${article.id}:${revision.hash ? `hash:${revision.hash}` : revision.id}`;
    const requested = new Map(revisions.filter(item => item?.id).map(item => [item.id, item]));
    const entries = new Map();
    const missing = new Map();
    for (const revision of requested.values()) {
      const key = keyFor(revision);
      const entry = cache.get(key);
      if (entry) {
        remember(key, entry);
        entries.set(key, entry);
      } else if (!missing.has(key)) {
        missing.set(key, revision);
      }
    }
    let batch = [];
    let estimate = 0;
    async function load() {
      if (!batch.length) return;
      signal?.throwIfAborted();
      const lookup = new Map(batch.map(revision => [revision.id, revision]));
      const data = await api("wikitext", { wiki: article.wiki, ids: batch.map(item => item.id).join(",") }, { signal });
      signal?.throwIfAborted();
      const page = data.query?.pages?.find(item => item.pageid === article.id && item.ns === 0);
      for (const revision of page?.revisions ?? []) {
        const source = revision.slots?.main?.content;
        if (!lookup.has(revision.revid) || typeof source !== "string") continue;
        const key = keyFor(lookup.get(revision.revid));
        const entry = { sections: readCitations(source, article.wiki), size: source.length * 2 };
        remember(key, entry);
        entries.set(key, entry);
      }
      batch = [];
      estimate = 0;
    }
    for (const revision of missing.values()) {
      const bytes = revision.size ?? 250_000;
      if (batch.length === 20 || batch.length && estimate + bytes > batchLimit) await load();
      batch.push(revision);
      estimate += bytes;
    }
    await load();
    return new Map([...requested.values()].flatMap(item => {
      const entry = entries.get(keyFor(item));
      return entry ? [[item.id, entry.sections]] : [];
    }));
  };
}
