const inlineRef = /<ref\b([^<>]*?)(?:\/\s*>|>(.*?)<\/ref\s*>)/gis;
const shortRef = /{{\s*(?:sfn|sfnp|harv|harvnb|harvtxt|harvcol)\s*\|([^{}]+)}}/gi;
const marker = /\uE000(\d+)\uE001/g;
const citationUrl = /https?:\/\/[^\s|<>"{}\]]+/i;
const footnote = /^(?:efn\w*|refn|footnote)$/i;
const wrappedText = /^(?:lang[\w-]*|nowrap|nobreak|small|abbr|sortname)$/i;
const endMatter = /^(?:see also|notes|references|bibliography|sources|further reading|external links)$/i;
const variants = new Map(Object.entries({
  analyse: "analyze", analysed: "analyzed", behaviour: "behavior", centre: "center", colour: "color",
  defence: "defense", favour: "favor", labour: "labor", neighbouring: "neighboring",
  organisation: "organization", organisations: "organizations", organise: "organize",
  programme: "program", recognise: "recognize", recognised: "recognized", towards: "toward"
}));

export const normalizeWords = text => text.normalize("NFKC").toLowerCase().replace(/’/gu, "'")
  .match(/[\p{L}\p{M}\p{N}]+(?:['-][\p{L}\p{M}\p{N}]+)*/gu)?.map(word => variants.get(word) ?? word).join(" ") ?? "";

export const sectionIdentity = path => path.map(normalizeWords).join("/");
const compact = text => text.replace(/\s+/gu, " ").trim();
const stripLinks = text => text.replace(/\[\[([^\[\]\n]+)\]\]/gu, (_, value) => value.split("|").at(-1))
  .replace(/\[(https?:\/\/[^\s\]]+)(?:\s+([^\]]+))?\]/giu, "$2")
  .replace(/'{2,5}/gu, "");

function wikiText(text) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—" };
  return stripLinks(text).replace(/<br\s*\/?>/giu, " ").replace(/<[^>]+>/gu, "")
    .replace(/&([a-z]+|#\d{1,7}|#x[\da-f]{1,6});/giu, (full, value) => {
      if (value in entities && Object.hasOwn(entities, value)) return entities[value];
      if (!value.startsWith("#")) return full;
      const hexadecimal = value[1]?.toLowerCase() === "x";
      const point = Number.parseInt(value.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return point > 0 && point <= 0x10FFFF ? String.fromCodePoint(point) : full;
    });
}

function field(body, name) {
  return new RegExp(`\\|\\s*(?:${name})\\s*=\\s*([^|{}]+)`, "i").exec(body)?.[1]?.trim() ?? "";
}

function sourceLink(text) {
  const link = citationUrl.exec(text)?.[0]?.replace(/[.,;]+$/u, "");
  if (!link) return null;
  try {
    let url = new URL(link);
    const archived = url.hostname === "web.archive.org" && /^\/web\/[^/]+\/(https?:\/\/.*)$/iu.exec(url.pathname + url.search);
    if (archived) url = new URL(archived[1]);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    for (const name of [...url.searchParams.keys()]) {
      if (/^(?:utm_|fbclid$|gclid$)/iu.test(name)) url.searchParams.delete(name);
    }
    url.searchParams.sort();
    const host = url.hostname.replace(/^www\./u, "");
    const book = /^books\.google\.[a-z.]+$/u.test(host) && url.searchParams.get("id");
    const path = url.pathname.replace(/\/$/u, "");
    const key = book ? `books:${book}` : host === "doi.org" ? `doi:${path.slice(1).toLowerCase()}` : `${host}${path}${url.search}`;
    return { url: url.href, host, key };
  } catch {
    return null;
  }
}

function citation(body) {
  const doi = field(body, "doi").toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//u, "");
  const link = sourceLink(field(body, "url|chapter[- ]url|article[- ]url") || body);
  const title = compact(wikiText(field(body, "title|chapter|article")));
  const publisher = compact(wikiText(field(body, "website|work|publisher|newspaper|journal")));
  const author = compact(wikiText(field(body, "last|last1|author|author1")));
  const isbn = field(body, "isbn").replace(/[^\dX]/giu, "");
  const record = { url: link?.url ?? "", title: title || link?.host, publisher: publisher || link?.host || author };
  const authorTitle = title && normalizeWords(`${title} ${author || publisher}`);
  if (doi || link || isbn || authorTitle) return {
    ...record, title: record.title || doi || isbn,
    key: doi ? `doi:${doi}` : link?.key ?? (isbn ? `isbn:${isbn}` : `title:${authorTitle}`)
  };
  const bibliographic = compact(wikiText(body)).replace(/[,;]?\s+pp?\.\s*\d.*$/iu, "");
  if (/\b(?:17|18|19|20)\d{2}\b/u.test(bibliographic) && !body.trim().startsWith("{{")) {
    return { key: `book:${normalizeWords(bibliographic)}`, title: bibliographic, publisher: "", url: "" };
  }
  return null;
}

function refName(attributes) {
  const fields = Object.fromEntries([...attributes.matchAll(/\b(name|group)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'/]+))/gi)]
    .map(([, key, double, single, plain]) => [key.toLowerCase(), double ?? single ?? plain]));
  return fields.name ? JSON.stringify([fields.group || "", fields.name]) : "";
}

function stripTemplates(text) {
  let depth = 0;
  let start = 0;
  let offset = 0;
  const chunks = [];
  for (const token of text.matchAll(/\{\{|\}\}/gu)) {
    if (token[0] === "{{") {
      if (depth++ === 0) start = token.index;
    } else if (depth && --depth === 0) {
      const body = text.slice(start + 2, token.index);
      const [name, ...fields] = body.split("|");
      chunks.push(text.slice(offset, start));
      if (footnote.test(name.trim())) chunks.push([...body.matchAll(marker)].map(match => match[0]).join(""));
      else if (wrappedText.test(name.trim())) chunks.push(fields.at(-1) ?? "");
      offset = token.index + 2;
    }
  }
  chunks.push(text.slice(offset, depth ? start : undefined));
  return chunks.join("");
}

function splitSentences(text, records, segmenter) {
  const marks = [];
  let removed = 0;
  const plain = text.replace(marker, (full, id, offset) => {
    marks.push({ offset: offset - removed, source: records[Number(id)] });
    removed += full.length;
    return "";
  });
  const sentences = [];
  let nextMark = 0;
  for (const { segment, index } of segmenter.segment(plain)) {
    const sources = new Map();
    const end = index + segment.length;
    while (nextMark < marks.length && marks[nextMark].offset <= end) {
      const { source } = marks[nextMark++];
      if (source) sources.set(source.key, source);
    }
    const value = compact(segment);
    if (value) sentences.push({ text: value, key: normalizeWords(value), sources });
  }
  return sentences;
}

export function readCitations(wikitext, language) {
  if (!wikitext) return [];
  let segmenter;
  try {
    segmenter = new Intl.Segmenter(language, { granularity: "sentence" });
  } catch {
    segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
  }
  const raw = wikitext.replace(/<!--[\s\S]*?-->|<(nowiki|pre|code)\b[^>]*>[\s\S]*?<\/\1>/giu, "");
  const named = new Map();
  for (const [, attributes, body] of raw.matchAll(inlineRef)) {
    const name = refName(attributes);
    const record = name && body ? citation(body) : null;
    if (record && !named.has(name)) named.set(name, record);
  }
  const records = [];
  function mark(record) {
    if (!record) return "";
    return `\uE000${records.push(record) - 1}\uE001`;
  }
  const marked = raw.replace(inlineRef, (_, attributes, body) => mark(body ? citation(body) : named.get(refName(attributes))))
    .replace(shortRef, (_, body) => {
      const title = body.split("|").filter(value => !value.includes("=")).join(" ").trim();
      return title ? mark({ key: `short:${normalizeWords(title)}`, title, publisher: "", url: "" }) : "";
    });
  const sections = [];
  const headings = [];
  let section;
  let lines = [];
  function flush() {
    const content = wikiText(lines.join(" ").replace(/^[\s*#:;]+/u, ""));
    lines = [];
    const paragraph = splitSentences(content, records, segmenter).filter(sentence => sentence.key);
    if (paragraph.length) section.passages.push(...paragraph.map((sentence, index) => ({
      ...sentence, context: paragraph.slice(Math.max(0, index - 2), index + 3).map(item => item.key)
    })));
  }
  function start(title, level) {
    while (headings.at(-1)?.level >= level) headings.pop();
    const path = [...headings.map(item => item.title), title];
    section = { title, path, key: sectionIdentity(path), passages: [] };
    sections.push(section);
    if (level) headings.push({ title, level });
  }
  start("Lead", 0);
  const markup = stripTemplates(marked).replace(/\{\|[^]*?\|\}/gu, "");
  for (const line of markup.split(/\r?\n/)) {
    const heading = /^(={2,6})\s*(.*?)\s*\1\s*$/u.exec(line);
    if (heading) {
      flush();
      const title = compact(wikiText(heading[2]));
      if (endMatter.test(title)) break;
      start(title, heading[1].length);
    } else if (!line.trim() || /^\s*(?:\[\[(?:Category|File|Image):|----)/iu.test(line)) {
      flush();
    } else if (/^\s*[*#:;]/u.test(line)) {
      flush();
      lines.push(line);
      flush();
    } else {
      lines.push(line);
    }
  }
  flush();
  return sections.filter(item => item.passages.length);
}

export function compareSources(before, after) {
  const added = [];
  const removed = [];
  const kept = [];
  for (const [key, source] of before) if (!after.has(key)) removed.push(source);
  for (const [key, source] of after) (before.has(key) ? kept : added).push(source);
  return { added, removed, kept };
}
