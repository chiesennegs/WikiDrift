import { diffArrays, diffWordsWithSpace } from "diff";

const excluded = [
  "table", "figure", "script", "style", "img", "noscript", "math", "[hidden]", ".infobox",
  ".navbox", ".vertical-navbox", ".sidebar", ".metadata", ".ambox", ".hatnote", ".shortdescription",
  ".mw-editsection", ".reference", ".references", ".reflist", ".mw-references-wrap",
  ".sistersitebox", ".portal", ".noprint", ".thumb", ".nomobile"
].join(",");
const read = node => node.textContent.replace(/\s+/gu, " ").trim();

function fragment(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}

export function snippet(html) {
  return read(fragment(html));
}

export function sectionsFromHtml(html) {
  const root = fragment(html);
  root.querySelectorAll(excluded).forEach(node => node.remove());
  root.querySelectorAll("br").forEach(node => node.replaceWith(" "));
  const sections = [];
  const parents = [];
  let section;
  function start(title, level) {
    while (parents.length && parents.at(-1).level >= level) parents.pop();
    const path = [...parents.map(parent => parent.title), title];
    section = { key: `s${sections.length}`, title, path, blocks: [] };
    if (level) parents.push({ title, level });
    sections.push(section);
  }
  start("Lead", 0);

  const blockSelector = "p, li, dd, dt, blockquote";
  for (const node of root.querySelectorAll(`h1, h2, h3, h4, h5, h6, ${blockSelector}`)) {
    if (/^H[1-6]$/.test(node.tagName)) {
      start(read(node), Number(node.tagName[1]));
      continue;
    }
    const direct = node.cloneNode(true);
    direct.querySelectorAll(blockSelector).forEach(child => child.remove());
    const content = read(direct);
    if (content) section.blocks.push(content);
  }

  return sections.map(({ blocks, ...heading }) => ({ ...heading, text: blocks.join("\n\n") }))
    .filter(item => item.key === "s0" || item.title && item.text);
}

function identity(section) {
  return section.path.map(title => title.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()).join("/");
}

function parts(before, after) {
  if (before === after) return before ? [{ value: before }] : [];
  if (!before) return [{ value: after, added: true }];
  if (!after) return [{ value: before, removed: true }];
  const paragraphs = diffArrays(before.split(/(?<=\n\n)/), after.split(/(?<=\n\n)/), { maxEditLength: 150, timeout: 25 });
  if (!paragraphs) return [{ value: before, removed: true }, { value: after, added: true }];
  const result = [];
  for (let index = 0; index < paragraphs.length; index += 1) {
    const current = paragraphs[index];
    const next = paragraphs[index + 1];
    if ((current.removed && next?.added) || (current.added && next?.removed)) {
      const oldText = (current.removed ? current : next).value.join("");
      const newText = (current.added ? current : next).value.join("");
      const words = oldText.length + newText.length <= 24000 &&
        diffWordsWithSpace(oldText, newText, { maxEditLength: 380, timeout: 22 });
      result.push(...(words || [{ value: oldText, removed: true }, { value: newText, added: true }]));
      index += 1;
    } else {
      result.push({ value: current.value.join(""), added: current.added, removed: current.removed });
    }
  }
  return result;
}

export function editionsWordDiff(before, translated) {
  return parts(before, translated);
}

export function revisionRows(before, after) {
  const unmatched = new Set(before);
  const exact = new Map();
  const titles = new Map();
  for (const section of before) {
    const key = identity(section);
    const matching = exact.get(key) ?? [];
    matching.push(section);
    exact.set(key, matching);
    const title = section.title.normalize("NFKC").toLocaleLowerCase();
    const sameTitle = titles.get(title) ?? [];
    sameTitle.push(section);
    titles.set(title, sameTitle);
  }
  const pairs = after.map(section => {
    const match = exact.get(identity(section))?.shift();
    if (match) unmatched.delete(match);
    return [match, section];
  });
  for (const pair of pairs) {
    if (pair[0]) continue;
    const title = pair[1].title.normalize("NFKC").toLocaleLowerCase();
    const candidates = titles.get(title)?.filter(section => unmatched.has(section));
    if (candidates?.length === 1) {
      pair[0] = candidates[0];
      unmatched.delete(pair[0]);
    }
  }
  for (const section of unmatched) pairs.push([section, null]);
  return pairs.map(([left, right]) => ({
    key: right?.key ?? `removed-${left.key}`, left, right,
    title: right?.title || left.title,
    changed: left?.text !== right?.text || left?.title !== right?.title,
    change: !left ? "Added" : !right ? "Removed" : "Edited",
    parts: parts(left?.text ?? "", right?.text ?? "")
  }));
}

function context(row, left, limit) {
  const match = row.parts.findIndex(part => left ? part.removed : part.added);
  const visible = part => left ? !part.added : !part.removed;
  if (match < 0) return (left ? row.left : row.right)?.text.slice(0, limit) ?? "";
  const previous = row.parts.slice(0, match).filter(visible).at(-1)?.value ?? "";
  const subsequent = row.parts.slice(match).filter(visible).map(part => part.value).join("");
  return (previous.slice(-140) + subsequent).slice(0, limit).trim();
}

export function revisionExcerpts(rows, prefix = "", limit = 12, characters = 1100) {
  const left = [];
  const right = [];
  for (const row of rows.filter(row => row.changed).slice(0, limit)) {
    const key = prefix + row.key;
    const oldText = context(row, true, characters);
    const newText = context(row, false, characters);
    if (oldText) left.push({ key, title: row.title, text: oldText });
    if (newText) right.push({ key, title: row.title, text: newText });
  }
  return { left, right };
}

export function editionExcerpts(sections, selected) {
  if (selected) return [selected].filter(item => item.text).map(item => ({ ...item, text: item.text.slice(0, 1300) }));
  return sections.filter(item => item.text).slice(0, 12).map(item => ({
    key: item.key, title: item.title, text: item.text.slice(0, item.key === "s0" ? 1300 : 650)
  }));
}

export function firstExcerpt(value, limit) {
  if (value.length <= limit) return value;
  const end = value.lastIndexOf("\n\n", limit);
  return value.slice(0, end > limit / 2 ? end : limit);
}
