import { editionsWordDiff, editionExcerpts, firstExcerpt, revisionExcerpts, revisionRows, sectionsFromHtml, snippet } from "./compare.js";
import { createAuthorBadges } from "./author-status.js";
import { createRevisionPicker } from "./revision-picker.js";

const $ = selector => document.querySelector(selector);
const html = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);
const join = values => values.join("");
const numberDate = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });
const exactDate = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const date = (value, time = false) => value ? (time ? exactDate : numberDate).format(new Date(value)) : "Article creation";
const today = new Date().toISOString().slice(0, 10);
const common = [
  ["ar", "Arabic"], ["zh", "Chinese"], ["en", "English"], ["fr", "French"], ["de", "German"],
  ["it", "Italian"], ["ja", "Japanese"], ["pt", "Portuguese"], ["ru", "Russian"], ["es", "Spanish"]
].map(([wiki, name]) => ({ wiki, name }));
const requestSlots = new Map();
const snapshots = new Map();
const storageKey = "wikidrift.library.v1";

function readLibrary() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
    return {
      articles: saved?.articles && typeof saved.articles === "object" ? saved.articles : {},
      authors: saved?.authors && typeof saved.authors === "object" ? saved.authors : {},
      history: Array.isArray(saved?.history) ? saved.history : []
    };
  } catch {
    return { articles: {}, authors: {}, history: [] };
  }
}

const state = { view: "explore", languages: common, article: null, mode: "revisions", saved: readLibrary() };
let editingRecord;
let toastTimer;

function notice(message) {
  $("#notification").textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("#notification").textContent = ""; }, 3500);
}

function storeLibrary() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state.saved));
    return true;
  } catch {
    notice("This browser could not save your library.");
    return false;
  }
}

function startRequest(name) {
  requestSlots.get(name)?.abort();
  const controller = new AbortController();
  requestSlots.set(name, controller);
  return controller;
}

function cancel(...names) {
  names.forEach(name => requestSlots.get(name)?.abort());
}

async function api(route, params = {}, options = {}) {
  const url = new URL(`/api/${route}`, location.origin);
  Object.entries(params).forEach(([name, value]) => {
    if (value !== "" && value != null) url.searchParams.set(name, value);
  });
  const response = await fetch(url, {
    signal: options.signal,
    ...(options.body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(options.body) } : {})
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data === null) throw new Error(data?.error || "This request could not be completed.");
  if (data.error) throw new Error("Wikipedia could not return the text of this revision.");
  return data;
}

function urlWiki(wiki) {
  return `https://${/^[a-z0-9-]+$/.test(wiki) ? wiki : "en"}.wikipedia.org`;
}
function articleUrl(article, extra = {}) {
  const params = new URLSearchParams({ curid: article.id, ...extra });
  return `${urlWiki(article.wiki)}/w/index.php?${params}`;
}
function revisionUrl(revision) {
  return `${urlWiki(revision.page.wiki)}/w/index.php?oldid=${Number(revision.id)}`;
}
function contributionsUrl(wiki, user) {
  return `${urlWiki(wiki)}/wiki/Special:Contributions/${encodeURIComponent(user.replaceAll(" ", "_"))}`;
}
const external = (url, title) => `<a href="${html(url)}" target="_blank" rel="noopener">${html(title)}</a>`;
const articleKey = article => `${article.wiki}:${article.id}`;
const authorKey = author => `${author.wiki}:${author.user}`;
const languageName = wiki => state.languages.find(language => language.wiki === wiki)?.name ||
  state.article?.languages.find(language => language.wiki === wiki)?.name || wiki.toUpperCase();
const displayAuthor = revision => revision?.user || (revision?.hidden ? "Author hidden" : "Anonymous editor");
const errorText = error => error instanceof Error ? error.message : "This request could not be completed.";
const status = (message, error = false) => `<p class="status${error ? " error" : ""}" role="status">${html(message)}</p>`;
const authors = createAuthorBadges({ api, html, date });
const authorName = revision => `${html(displayAuthor(revision))} ${authors.badge(revision?.page?.wiki, revision?.user)}`;
const openRevisionPicker = createRevisionPicker({
  dialog: $("#revision-picker"), api, html, date, author: authorName, refreshAuthors: authors.refresh,
  onPick(side, revision) {
    state.range[side] = revision;
    render();
  }
});

function selected(value, current) {
  return String(value) === String(current) ? " selected" : "";
}

function renderLanguages() {
  const picker = $("#source-language");
  const wiki = picker.value || "en";
  const languages = state.languages.some(language => language.wiki === wiki)
    ? state.languages : [...state.languages, { wiki, name: wiki.toUpperCase() }];
  picker.innerHTML = join(languages.map(language => `<option value="${html(language.wiki)}"${selected(language.wiki, wiki)}>${html(language.name)}</option>`));
}

function setSearch(content) {
  const target = $("#search-results");
  target.hidden = !content;
  target.innerHTML = content;
}

async function search(event) {
  event.preventDefault();
  const q = $("#search-query").value.trim();
  if (!q) return;
  if (state.view === "library") setView("explore");
  const wiki = $("#source-language").value;
  const { signal } = startRequest("search");
  setSearch("<p>Searching Wikipedia…</p>");
  try {
    const matches = await api("search", { wiki, q }, { signal });
    if (signal.aborted) return;
    setSearch(matches.length ? join(matches.map(result =>
      `<button type="button" data-action="open" data-page="${result.id}" data-wiki="${html(wiki)}" data-title="${html(result.title)}">
        <strong dir="auto">${html(result.title)}</strong><span dir="auto">${html(snippet(result.snippet).slice(0, 170))}</span>
      </button>`
    )) : "<p>No Wikipedia articles matched that search.</p>");
  } catch (error) {
    if (!signal.aborted) setSearch(`<p>${html(errorText(error))}</p>`);
  }
}

function setView(view) {
  state.view = view;
  render();
}

function remember(article) {
  const { wiki, id, title } = article;
  state.saved.history = [{ wiki, id, title, viewed: new Date().toISOString() },
    ...state.saved.history.filter(item => articleKey(item) !== articleKey(article))].slice(0, 100);
  storeLibrary();
}

async function openArticle(wiki, title, page, options = {}) {
  cancel("search", "article", "history", "comparison", "scan", "analysis", "translation", "credits");
  const { signal } = startRequest("article");
  setSearch("");
  state.view = "explore";
  state.article = null;
  state.loading = true;
  state.loadError = "";
  state.history = { items: [], cursor: null, date: "", author: "" };
  state.mode = options.edition ? "editions" : "revisions";
  state.target = options.edition || "";
  state.findingsByRevision = new Map();
  state.compare = null;
  state.range = {};
  state.scan = null;
  render();
  try {
    const article = await api("topic", { wiki, title, page }, { signal });
    if (signal.aborted) return;
    state.article = article;
    state.loading = false;
    remember(article);
    if (![...$("#source-language").options].some(option => option.value === wiki)) {
      $("#source-language").add(new Option(wiki.toUpperCase(), wiki));
    }
    $("#source-language").value = wiki;
    $("#search-query").value = article.title;
    state.history.author = options.author || "";
    render();
    void loadHistory(false, Boolean(options.author));
    if (state.mode === "editions") {
      if (article.languages.some(item => item.wiki === state.target)) void compareEditions(state.target);
      else state.target = "";
    } else if (options.from && options.to) {
      void compareRevisions(options.from, options.to);
    } else if (article.latest && !options.author) {
      void compareRevisions(article.latest.parent, article.latest.id);
    }
    updateUrl();
  } catch (error) {
    if (signal.aborted) return;
    state.loading = false;
    state.loadError = errorText(error);
    render();
  }
}

async function loadHistory(append = false, selectFirst = false) {
  const timeline = state.history;
  const article = state.article;
  if (!article || (append && !timeline.cursor)) return;
  const { signal } = startRequest("history");
  timeline.loading = true;
  timeline.error = "";
  if (!append) timeline.items = [];
  render();
  try {
    const response = await api("revisions", {
      wiki: article.wiki, page: article.id, cursor: append ? timeline.cursor : "",
      date: timeline.date, author: timeline.author
    }, { signal });
    if (signal.aborted) return;
    timeline.items = append ? [...timeline.items, ...response.revisions] : response.revisions;
    timeline.cursor = response.cursor;
    if (selectFirst && timeline.items[0] && state.mode === "revisions") {
      const { parent, id } = timeline.items[0];
      void compareRevisions(parent, id);
    }
  } catch (error) {
    if (!signal.aborted) timeline.error = errorText(error);
  } finally {
    if (!signal.aborted) {
      timeline.loading = false;
      render();
    }
  }
}

async function metadata(wiki, ids, signal) {
  const data = await api("metadata", { wiki, ids: ids.filter(Boolean).join(",") }, { signal });
  return new Map(data.map(item => [item.id, item]));
}

async function snapshot(wiki, id, signal) {
  if (!id) return [];
  const key = `${wiki}:${id}`;
  if (snapshots.has(key)) return snapshots.get(key);
  const data = await api("snapshot", { wiki, id }, { signal });
  if (typeof data.parse?.text !== "string") throw new Error("This revision’s article text is unavailable.");
  const sections = sectionsFromHtml(data.parse.text);
  if (snapshots.size >= 18) snapshots.delete(snapshots.keys().next().value);
  snapshots.set(key, sections);
  return sections;
}

function updateUrl() {
  const article = state.article;
  if (!article) return;
  const params = new URLSearchParams({ wiki: article.wiki, title: article.title });
  const comparison = state.compare;
  if (state.mode === "editions" && state.target) params.set("edition", state.target);
  if (state.mode === "revisions" && comparison?.to && comparison?.left) {
    params.set("from", comparison.left.id);
    params.set("to", comparison.right.id);
  }
  window.history.replaceState(null, "", `?${params}`);
}

function beginComparison(info) {
  cancel("analysis", "translation", "credits");
  state.compare = { loading: true, ...info };
  render();
  return { comparison: state.compare, signal: startRequest("comparison").signal };
}

function selectEdit(id, section) {
  const revision = state.history.items.find(item => item.id === id) || state.compare?.right;
  if (revision?.id === id) void compareRevisions(revision.parent, id, section);
}

async function compareRevisions(from, to, section) {
  const article = state.article;
  const { comparison, signal } = beginComparison({ from, to });
  try {
    const revisions = await metadata(article.wiki, [from, to], signal);
    let left = from ? revisions.get(from) : null;
    let right = revisions.get(to);
    if (!right || right.page.id !== article.id || (from && left?.page.id !== article.id)) {
      throw new Error("These revision sources are unavailable for this article.");
    }
    if (left?.id === right.id) throw new Error("Choose two different revisions.");
    if (left && (left.date > right.date || left.date === right.date && left.id > right.id)) {
      [left, right] = [right, left];
    }
    const [before, after] = await Promise.all([
      snapshot(article.wiki, left?.id, signal), snapshot(article.wiki, right.id, signal)
    ]);
    if (signal.aborted) return;
    comparison.left = left;
    comparison.right = right;
    comparison.from = left?.id ?? null;
    comparison.to = right.id;
    comparison.rows = revisionRows(before, after);
    comparison.section = comparison.rows.some(row => row.key === section) ? section
      : (comparison.rows.find(row => row.changed) || comparison.rows[0])?.key;
    if (section) {
      comparison.highlight = state.findingsByRevision.get(right.id)?.find(item => item.leftKey === section || item.rightKey === section);
    }
    comparison.credits = right.parent === left?.id || !left ? { items: [right], complete: true } : { items: [] };
    state.range = { from: left, to: right };
    updateUrl();
  } catch (error) {
    if (!signal.aborted) comparison.error = errorText(error);
  } finally {
    if (!signal.aborted) {
      comparison.loading = false;
      render();
      if (section) scrollToEvidence();
    }
  }
}

async function compareEditions(target) {
  state.target = target;
  const article = state.article;
  const edition = article.languages.find(language => language.wiki === target);
  if (!edition) {
    cancel("comparison", "analysis", "translation");
    state.compare = null;
    render();
    updateUrl();
    return;
  }
  const { comparison, signal } = beginComparison({ edition });
  try {
    const other = await api("topic", { wiki: target, title: edition.title, links: 0 }, { signal });
    if (!other.latest || !article.latest) throw new Error("A current revision is unavailable for one of these editions.");
    const [leftSections, rightSections] = await Promise.all([
      snapshot(article.wiki, article.latest.id, signal), snapshot(other.wiki, other.latest.id, signal)
    ]);
    if (signal.aborted) return;
    Object.assign(comparison, { left: article.latest, right: other.latest, leftSections, rightSections,
      leftKey: leftSections[0]?.key, rightKey: rightSections[0]?.key });
    remember(other);
    remember(article);
    updateUrl();
  } catch (error) {
    if (!signal.aborted) comparison.error = errorText(error);
  } finally {
    if (!signal.aborted) {
      comparison.loading = false;
      render();
    }
  }
}

async function loadCredits() {
  const comparison = state.compare;
  if (!comparison?.credits || comparison.credits.complete || comparison.credits.loading) return;
  const credits = comparison.credits;
  const article = state.article;
  const { signal } = startRequest("credits");
  credits.loading = true;
  credits.error = "";
  render();
  try {
    const response = await api("revisions", { wiki: article.wiki, page: article.id,
      newer: comparison.right.id, older: comparison.left.id, cursor: credits.cursor }, { signal });
    if (signal.aborted) return;
    credits.items.push(...response.revisions);
    credits.cursor = response.cursor;
    credits.complete = !response.cursor;
  } catch (error) {
    if (!signal.aborted) credits.error = errorText(error);
  } finally {
    if (!signal.aborted) {
      credits.loading = false;
      render();
    }
  }
}

function scrollToEvidence() {
  $("#comparison-panel")?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
}

async function analyzeComparison(sectionOnly = false) {
  const comparison = state.compare;
  const mode = state.mode;
  if (!comparison || comparison.loading || comparison.error) return;
  const { signal } = startRequest("analysis");
  const request = sectionOnly ? "sectionAnalysis" : "analysis";
  comparison[request] = { loading: true };
  const result = comparison[request];
  render();
  try {
    const passages = mode === "editions" ? {
      left: editionExcerpts(comparison.leftSections, sectionOnly ? comparison.leftSections.find(item => item.key === comparison.leftKey) : null),
      right: editionExcerpts(comparison.rightSections, sectionOnly ? comparison.rightSections.find(item => item.key === comparison.rightKey) : null)
    } : revisionExcerpts(comparison.rows);
    const data = await api("analysis", {}, { signal, body: { mode, ...passages } });
    if (signal.aborted) return;
    result.findings = data.findings;
  } catch (error) {
    if (!signal.aborted) result.error = errorText(error);
  } finally {
    if (!signal.aborted) {
      result.loading = false;
      render();
    }
  }
}

async function scanTimeline() {
  const candidates = state.history.items.filter(revision => revision.parent).slice(0, 5);
  if (!candidates.length || state.scan?.loading) return;
  const { signal } = startRequest("scan");
  const { wiki } = state.article;
  const scan = { loading: true };
  state.scan = scan;
  render();
  try {
    const passages = { left: [], right: [] };
    for (const revision of candidates) {
      const [before, after] = await Promise.all([
        snapshot(wiki, revision.parent, signal), snapshot(wiki, revision.id, signal)
      ]).catch(error => {
        if (signal.aborted) throw error;
        scan.skipped = (scan.skipped || 0) + 1;
        return [null, null];
      });
      if (!before || !after) continue;
      scan.reviewed = (scan.reviewed || 0) + 1;
      const excerpts = revisionExcerpts(revisionRows(before, after), `r${revision.id}-`, 3, 550);
      passages.left.push(...excerpts.left);
      passages.right.push(...excerpts.right);
    }
    if (signal.aborted) return;
    const data = passages.left.length || passages.right.length
      ? await api("analysis", {}, { signal, body: { mode: "timeline", ...passages } }) : { findings: [] };
    if (signal.aborted) return;
    candidates.forEach(revision => state.findingsByRevision.delete(revision.id));
    for (const finding of data.findings) {
      const match = /^r(\d+)-(.+)$/.exec(finding.rightKey || finding.leftKey);
      if (!match) continue;
      const id = Number(match[1]);
      const items = state.findingsByRevision.get(id) || [];
      items.push({ ...finding, leftKey: finding.leftKey ? match[2] : "", rightKey: finding.rightKey ? match[2] : "" });
      state.findingsByRevision.set(id, items);
    }
    scan.hits = candidates.filter(revision => state.findingsByRevision.has(revision.id)).length;
  } catch (error) {
    if (!signal.aborted) scan.error = errorText(error);
  } finally {
    if (!signal.aborted) {
      scan.loading = false;
      render();
    }
  }
}

async function translateSection() {
  const comparison = state.compare;
  const right = comparison.rightSections.find(item => item.key === comparison.rightKey);
  const left = comparison.leftSections.find(item => item.key === comparison.leftKey);
  if (!right?.text || !left?.text) return;
  const { signal } = startRequest("translation");
  const translation = { loading: true };
  comparison.translation = translation;
  render();
  try {
    const passage = firstExcerpt(right.text, 3500);
    const before = firstExcerpt(left.text, 3500);
    const data = await api("translation", {}, { signal, body: {
      from: comparison.right.page.wiki, to: comparison.left.page.wiki, passage
    } });
    if (signal.aborted) return;
    translation.parts = editionsWordDiff(before, data.translation);
    translation.partial = passage !== right.text || before !== left.text;
  } catch (error) {
    if (!signal.aborted) translation.error = errorText(error);
  } finally {
    if (!signal.aborted) {
      translation.loading = false;
      render();
    }
  }
}

function tags(record) {
  return record?.tags?.length
    ? `<span class="tags">${join(record.tags.map(tag => `<span class="tag">${html(tag)}</span>`))}</span>` : "";
}

function authorControl(revision, icon = false) {
  if (!revision?.user) return html(displayAuthor(revision));
  const { wiki, id, title } = revision.page;
  const editing = `data-action="edit-author" data-wiki="${html(wiki)}" data-author="${html(revision.user)}" data-page="${id}" data-title="${html(title)}"`;
  return icon
    ? `<button type="button" class="icon-button" ${editing} title="${html(revision.user)}" aria-label="Manage author ${html(revision.user)}">···</button>`
    : `${external(contributionsUrl(wiki, revision.user), revision.user)} ${authors.badge(wiki, revision.user)} <button type="button" class="icon-button" ${editing} aria-label="Manage author ${html(revision.user)}">···</button>`;
}

function timeline() {
  const timeline = state.history;
  const scan = state.scan;
  const scanState = scan?.loading ? status("Reading the first five edits…") : scan?.error ? status(scan.error, true)
    : scan ? status(`${scan.hits} flagged across ${scan.reviewed || 0} checked edits.${scan.skipped ? ` ${scan.skipped} unavailable.` : ""}`) : "";
  const revisions = timeline.items.map(revision => {
    const findings = state.findingsByRevision.get(revision.id);
    const active = state.compare?.to === revision.id;
    return `<div class="revision-item${active ? " active" : ""}">
      <button class="revision" type="button" data-action="edit" data-id="${revision.id}"${active ? ' aria-current="true"' : ""}>
        <time datetime="${html(revision.date)}">${date(revision.date, true)}${findings?.length ? `<span class="finding-dot" aria-label="AI finding">✦ ${findings.length}</span>` : ""}</time>
        <small class="revision-author" dir="auto">${authorName(revision)}</small>
        ${revision.comment ? `<small dir="auto" title="${html(revision.comment)}">${html(revision.comment)}</small>` : ""}
      </button>${revision.user ? authorControl(revision, true) : ""}
    </div>`;
  });
  return `<aside class="panel panel-pad">
    <div class="panel-title"><h2>Revision timeline</h2></div>
    <form id="date-form" class="filter-form">
      <label class="sr-only" for="timeline-date">Show edits on or before this date</label>
      <input id="timeline-date" type="date" name="date" max="${today}" value="${html(timeline.date)}">
      <button class="button" type="submit">Jump to date</button>
    </form>
    ${timeline.author ? `<div class="active-author">Edits by <b dir="auto">${html(timeline.author)}</b> ${authors.badge(state.article.wiki, timeline.author)} <button type="button" class="icon-button" data-action="clear-author" aria-label="Clear author filter">×</button></div>` : ""}
    ${revisions.length ? `<div class="revision-list">${join(revisions)}</div>` : ""}
    ${timeline.loading ? status("Loading edits…") : timeline.error ? status(timeline.error, true)
      : !revisions.length ? status("No edits found for this selection.") : ""}
    <div class="actions">
      ${timeline.cursor && revisions.length ? `<button type="button" class="button" data-action="more" ${timeline.loading ? "disabled" : ""}>Older edits</button>` : ""}
      <button type="button" class="button" data-action="scan" ${scan?.loading || !timeline.items.some(item => item.parent) ? "disabled" : ""}>✦ Scan 5 edits</button>
    </div>
    ${scanState}
  </aside>`;
}

function rangeComparison() {
  const { from, to = state.article.latest } = state.range;
  const same = from && from.id === to?.id;
  const control = (side, title, revision) => `<div class="range-field">
    <span class="field-label" id="range-${side}-label">${title}</span>
    <button id="range-${side}" type="button" class="button range-pick" aria-haspopup="dialog"
      aria-labelledby="range-${side}-label range-${side}" data-action="pick-date" data-side="${side}"${state.article.latest ? "" : " disabled"}>
      ${revision ? `${date(revision.date, true)} UTC` : "Browse years and dates"}
    </button>
  </div>`;
  return `<div class="range panel panel-pad">
    ${control("from", "Earlier revision", from)}
    ${control("to", "Later revision", to)}
    <button class="button primary range-compare" type="button" data-action="compare-range"${!from || !to || same ? " disabled" : ""}>Compare dates</button>
    ${same ? '<p class="range-message muted" role="status">Choose two different revisions.</p>' : ""}
  </div>`;
}

function editionPicker() {
  const article = state.article;
  const sorted = [...article.languages].sort((left, right) => left.name.localeCompare(right.name, "en"));
  return `<aside class="panel panel-pad stack">
    <div class="panel-title"><h2>Language editions</h2></div>
    <div><span class="field-label">Source edition</span><strong>${html(languageName(article.wiki))}</strong></div>
    <div>
      <label class="field-label" for="edition-picker">Comparison edition</label>
      <select id="edition-picker" class="wide" ${sorted.length ? "" : "disabled"}>
        <option value="">Choose a language</option>
        ${join(sorted.map(item => `<option value="${html(item.wiki)}"${selected(item.wiki, state.target)}>${html(item.name === item.autonym || !item.autonym ? item.name : `${item.name} · ${item.autonym}`)}</option>`))}
      </select>
    </div>
    ${!sorted.length ? status("Wikipedia lists no linked language editions for this article.") : ""}
  </aside>`;
}

function splitHead(revision, title, edition = false) {
  if (!revision) return `<div class="split-label"><strong>${html(title)}</strong><p class="meta">Article creation</p></div>`;
  const wiki = revision.page.wiki;
  return `<div class="split-label">
    <strong>${html(edition ? languageName(wiki) : title)}${edition ? ` · <span dir="auto">${html(revision.page.title)}</span>` : ""}</strong>
    <p class="meta">${external(revisionUrl(revision), date(revision.date, true))}
      <span>${edition ? "Last edit by " : ""}${authorControl(revision)}</span>
      ${edition ? external(articleUrl(revision.page, { action: "history" }), "Contributors") : ""}
    </p>
  </div>`;
}

function formatParts(parts, side) {
  const visible = parts.filter(part => side === "left" ? !part.added : !part.removed);
  return join(visible.map(part => part.added ? `<ins>${html(part.value)}</ins>`
    : part.removed ? `<del>${html(part.value)}</del>` : html(part.value)));
}

function passage(content) {
  return `<div class="passage" dir="auto">${content || '<span class="absent">No text in this section.</span>'}</div>`;
}

function evidenceNote(finding) {
  if (!finding) return "";
  return `<div class="source-note">
    <strong>${html(finding.category)}</strong> · ${html(finding.description)}
    <div class="evidence-quotes">
      ${finding.leftQuote ? `<q dir="auto"><mark>${html(finding.leftQuote)}</mark></q>` : ""}
      ${finding.rightQuote ? `<q dir="auto"><mark>${html(finding.rightQuote)}</mark></q>` : ""}
    </div>
  </div>`;
}

function findingItems(items, scope) {
  return `<ul class="finding-list">${join(items.map((finding, index) =>
    `<li><button type="button" class="finding" data-action="finding" data-scope="${scope}" data-index="${index}"${finding === state.compare?.highlight ? ' aria-current="true"' : ""}><span class="category">${html(finding.category)}</span>${html(finding.description)}</button></li>`
  ))}</ul>`;
}

function insights(comparison) {
  const result = comparison?.analysis;
  const selectedResult = comparison?.sectionAnalysis;
  const editions = state.mode === "editions";
  const timelineFindings = editions ? [] : state.findingsByRevision.get(comparison?.to) || [];
  const available = editions ? comparison?.leftSections?.some(item => item.text) || comparison?.rightSections?.some(item => item.text)
    : comparison?.rows?.some(item => item.changed && (item.left?.text || item.right?.text));
  return `<section class="panel panel-pad findings">
    <div class="panel-title">
      <p class="ai-label"><span aria-hidden="true">✦</span> AI analysis</p>
      <button type="button" class="button" data-action="analyze" ${!available || result?.loading ? "disabled" : ""}>${result?.loading ? "Analyzing…" : "Analyze comparison"}</button>
    </div>
    ${result?.loading ? status("Checking excerpts for changes in framing, tone and coverage.")
      : result?.error ? status(result.error, true)
      : result?.findings?.length ? findingItems(result.findings, "analysis")
      : result?.findings ? status("The AI found no material differences it could support with quotes.")
      : status(editions ? "Compare framing and coverage in excerpts from the two articles."
        : "Check changed passages for evidence of shifts in tone or framing.")}
    ${selectedResult?.loading ? status("Analyzing the selected sections…")
      : selectedResult?.error ? status(selectedResult.error, true)
      : selectedResult?.findings?.length ? findingItems(selectedResult.findings, "sectionAnalysis")
      : selectedResult?.findings ? status("The AI found no supported differences in these excerpts.") : ""}
    ${timelineFindings.length ? findingItems(timelineFindings, "timeline") : ""}
  </section>`;
}

function credits(comparison) {
  const items = comparison.credits;
  return `<section class="panel panel-pad">
    <div class="panel-title"><h2>Contributors in this range</h2>${external(articleUrl(state.article, { action: "history" }), "Full history")}</div>
    ${items.items.length ? `<ul class="credit-list">${join(items.items.map(revision =>
      `<li><span>${authorControl(revision)}</span>${external(revisionUrl(revision), date(revision.date, true))}</li>`
    ))}</ul>` : ""}
    ${items.error ? status(items.error, true) : ""}
    ${!items.complete ? `<button class="button" type="button" data-action="credits" ${items.loading ? "disabled" : ""}>
      ${items.loading ? "Loading…" : items.items.length ? "More edits in range" : "Load edits in range"}
    </button>` : ""}
  </section>`;
}

function revisionComparison(comparison) {
  const row = comparison.rows.find(item => item.key === comparison.section);
  const changed = comparison.rows.filter(item => item.changed);
  const unchanged = comparison.rows.filter(item => !item.changed);
  const options = rows => join(rows.map(item => `<option value="${html(item.key)}"${selected(item.key, row?.key)}>${html(item.title)}${item.changed ? ` · ${item.change}` : ""}</option>`));
  return `${insights(comparison)}
    <article class="panel" id="comparison-panel">
      <div class="compare-toolbar">
        <div><h2>Side-by-side diff</h2><span class="muted">${changed.length} changed ${changed.length === 1 ? "section" : "sections"}</span></div>
        <label><span class="sr-only">Jump to a section</span><select id="revision-section">
          ${changed.length ? `<optgroup label="Changed sections">${options(changed)}</optgroup>` : ""}
          ${unchanged.length ? `<optgroup label="Unchanged sections">${options(unchanged)}</optgroup>` : ""}
        </select></label>
        <div class="legend"><span class="removed">Removed</span><span class="added">Added</span></div>
      </div>
      ${changed.length ? `<div class="change-index" role="group" aria-label="Changed sections">${join(changed.map(item =>
        `<button id="section-${html(item.key)}" type="button" class="section-chip" data-action="section" data-key="${html(item.key)}" aria-pressed="${item.key === row?.key}">
          <span class="section-change ${item.change.toLowerCase()}">${html(item.change)}</span><span dir="auto">${html(item.title)}</span>
        </button>`))}</div>` : ""}
      ${row ? `<h3 class="diff-section-title" dir="auto">${html(row.title)}</h3>` : ""}
      ${evidenceNote(comparison.highlight)}
      <div class="split">
        ${splitHead(comparison.left, "Earlier revision")}
        ${splitHead(comparison.right, "Later revision")}
        ${passage(row ? formatParts(row.parts, "left") : "")}
        ${passage(row ? formatParts(row.parts, "right") : "")}
      </div>
      <p class="source-note">${comparison.left ? external(`${urlWiki(state.article.wiki)}/w/index.php?diff=${comparison.right.id}&oldid=${comparison.left.id}`, "Full Wikipedia diff") : external(revisionUrl(comparison.right), "Original revision")} includes wikitext, citations and formatting.</p>
    </article>
    ${credits(comparison)}`;
}

function sectionPicker(side, sections, key) {
  return `<label class="section-picker"><span class="field-label">${side === "left" ? "Source section" : "Comparison section"}</span>
    <select id="edition-${side}">
      ${join(sections.map(item => `<option value="${html(item.key)}"${selected(item.key, key)}>${html(item.path.join(" / "))}</option>`))}
    </select>
  </label>`;
}

function editionComparison(comparison) {
  const left = comparison.leftSections.find(item => item.key === comparison.leftKey);
  const right = comparison.rightSections.find(item => item.key === comparison.rightKey);
  const translation = comparison.translation;
  return `${insights(comparison)}
    <article class="panel" id="comparison-panel">
      <div class="compare-toolbar"><h2>Side-by-side sections</h2>
        <div class="actions">
          <button class="button" type="button" data-action="analyze-section"${!left?.text || !right?.text || comparison.sectionAnalysis?.loading ? " disabled" : ""}>✦ Analyze sections</button>
          <button class="button" type="button" data-action="translate"${!left?.text || !right?.text || translation?.loading ? " disabled" : ""}>Translate and highlight</button>
        </div>
      </div>
      ${evidenceNote(comparison.highlight)}
      <div class="split">
        ${splitHead(comparison.left, "", true)}
        ${splitHead(comparison.right, "", true)}
        ${sectionPicker("left", comparison.leftSections, comparison.leftKey)}
        ${sectionPicker("right", comparison.rightSections, comparison.rightKey)}
        ${passage(html(left?.text))}
        ${passage(html(right?.text))}
      </div>
      <p class="source-note">Choose any two sections to compare. Each revision link opens the original source.</p>
    </article>
    ${translation?.loading || translation?.error ? `<div class="panel panel-pad">${status(translation.error || "Translating the comparison passage…", Boolean(translation.error))}</div>`
      : translation?.parts ? `<article class="panel">
        <div class="compare-toolbar"><h2>Translated word diff</h2><div class="legend"><span class="removed">Source wording</span><span class="added">Comparison wording</span></div></div>
        <div class="split"><div class="split-label"><strong>${html(languageName(comparison.left.page.wiki))} source</strong></div>
        <div class="split-label"><strong>AI translation from ${html(languageName(comparison.right.page.wiki))}</strong></div>
        ${passage(formatParts(translation.parts, "left"))}${passage(formatParts(translation.parts, "right"))}</div>
        <p class="source-note">${translation.partial ? "Showing the opening excerpt of each section. " : ""}Word highlights include differences introduced by translation. Translation adapted from ${external(revisionUrl(comparison.right), "Wikipedia")} under ${external("https://creativecommons.org/licenses/by-sa/4.0/", "CC BY-SA 4.0")}.</p>
      </article>` : ""}`;
}

function workspace() {
  const article = state.article;
  if (!article) return state.loading ? status("Opening the Wikipedia article…")
    : state.loadError ? status(state.loadError, true) : "";
  const saved = state.saved.articles[articleKey(article)];
  const comparison = state.compare;
  const edition = state.mode === "editions";
  return `<div class="workspace-head">
      <div><h1 dir="auto">${html(article.title)}</h1>
        <p class="meta">${html(languageName(article.wiki))} Wikipedia ${external(articleUrl(article), "Original article")}
        ${external(articleUrl(article, { action: "history" }), "Article history")} ${tags(saved)}</p>
      </div>
      <button type="button" class="button" data-action="edit-article">${saved?.favorite ? "★" : "☆"} Favorite &amp; tags</button>
    </div>
    <div class="mode-tabs" role="group" aria-label="Comparison mode">
      <button type="button" data-action="mode" data-mode="revisions" aria-pressed="${!edition}">Revision history</button>
      <button type="button" data-action="mode" data-mode="editions" aria-pressed="${edition}">Language editions</button>
    </div>
    <div class="pane-grid">
      ${edition ? editionPicker() : timeline()}
      <div class="stack">
        ${edition ? "" : rangeComparison()}
        ${comparison?.loading ? `<div class="panel panel-pad">${status("Loading revision text…")}</div>`
          : comparison?.error ? `<div class="panel panel-pad">${status(comparison.error, true)}</div>`
          : comparison ? edition ? editionComparison(comparison) : revisionComparison(comparison)
          : `<div class="panel panel-pad">${status(edition ? "Choose a linked language edition to compare." : "Select a revision to inspect an edit.")}</div>`}
      </div>
    </div>`;
}

function libraryArticle(record, history = false) {
  return `<li>
    <div><button type="button" class="text-button" data-action="open" data-wiki="${html(record.wiki)}" data-page="${Number(record.id)}" data-title="${html(record.title)}"><b dir="auto">${html(record.title)}</b></button>
    <span class="muted"> · ${html(languageName(record.wiki))}${history ? ` · ${date(record.viewed)}` : ""}</span>
    ${tags(record)}</div>
    ${history ? "" : `<button type="button" class="button" data-action="edit-article" data-wiki="${html(record.wiki)}" data-page="${Number(record.id)}" data-title="${html(record.title)}">${record.favorite ? "★" : "☆"} Edit tags</button>`}
  </li>`;
}

function libraryAuthor(record) {
  return `<li>
    <div>${external(contributionsUrl(record.wiki, record.user), record.user)} ${authors.badge(record.wiki, record.user)} <span class="muted"> · ${html(languageName(record.wiki))}</span> ${tags(record)}</div>
    <div class="actions">
      ${record.article ? `<button type="button" class="button" data-action="filter-library-author" data-wiki="${html(record.wiki)}" data-page="${Number(record.article.id)}" data-author="${html(record.user)}" data-title="${html(record.article.title)}">Edits on ${html(record.article.title)}</button>` : ""}
      <button type="button" class="button" data-action="edit-author" data-wiki="${html(record.wiki)}" data-page="${Number(record.article?.id || 0)}" data-author="${html(record.user)}" data-title="${html(record.article?.title)}">${record.favorite ? "★" : "☆"} Edit tags</button>
    </div>
  </li>`;
}

function libraryContent() {
  const { articles, authors, history } = state.saved;
  const section = (title, items, empty) => `<section class="panel library-list"><h2>${title}</h2>
    ${items.length ? `<ul>${join(items)}</ul>` : `<p class="muted">${empty}</p>`}
  </section>`;
  return `<h1>Your library</h1><p class="muted">Favorites, tags and viewing history are saved in this browser.</p>
    ${section("Saved articles", Object.values(articles).map(item => libraryArticle(item)), "Favorite or tag an article from its comparison page.")}
    ${section("Saved authors", Object.values(authors).map(libraryAuthor), "Open an author menu beside an edit to favorite or tag the author.")}
    ${section("Viewing history", history.map(item => libraryArticle(item, true)), "Open a Wikipedia article to start your history.")}`;
}

function render() {
  const inLibrary = state.view === "library";
  const showWorkspace = Boolean(state.article || state.loading || state.loadError);
  $("#search-area").hidden = inLibrary;
  $("#search-area").classList.toggle("compact", showWorkspace);
  $("#start").hidden = inLibrary || showWorkspace;
  const panel = $("#workspace");
  const list = $("#library");
  panel.hidden = inLibrary || !showWorkspace;
  list.hidden = !inLibrary;
  $("#explore-nav").toggleAttribute("aria-current", !inLibrary);
  $("#library-nav").toggleAttribute("aria-current", inLibrary);
  $(inLibrary ? "#library-nav" : "#explore-nav").setAttribute("aria-current", "page");
  if (inLibrary) {
    list.innerHTML = libraryContent();
    authors.refresh(list);
  } else if (showWorkspace) {
    const priorScroll = panel.querySelector(".revision-list")?.scrollTop ?? 0;
    const focused = document.activeElement;
    const focusedId = focused?.id;
    const preserveFocus = focusedId && panel.contains(focused);
    panel.innerHTML = workspace();
    const revisions = panel.querySelector(".revision-list");
    if (revisions) revisions.scrollTop = priorScroll;
    if (preserveFocus) document.getElementById(focusedId)?.focus({ preventScroll: true });
    authors.refresh(panel);
  }
}

function editRecord(kind, dataset) {
  const { wiki, page, author, title } = dataset;
  const item = kind === "articles" ? (page ? { wiki, id: Number(page), title } : state.article)
    : { wiki, user: author, article: Number(page) ? { id: Number(page), title } : null };
  if (!item) return;
  const key = kind === "articles" ? articleKey(item) : authorKey(item);
  editingRecord = { kind, key, item };
  const saved = state.saved[kind][key];
  const dialog = $("#record-dialog");
  $("#record-title").textContent = kind === "articles" ? item.title : item.user;
  $("#record-form").elements.favorite.checked = Boolean(saved?.favorite);
  $("#record-tags").value = saved?.tags?.join(", ") || "";
  dialog.querySelector("[data-action='filter-author']")?.remove();
  if (kind === "authors" && item.article && item.article.id === state.article?.id && wiki === state.article.wiki) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button";
    button.dataset.action = "filter-author";
    button.textContent = "Show edits on this article";
    dialog.querySelector(".dialog-actions").prepend(button);
  }
  dialog.showModal();
}

function filterAuthor(author) {
  cancel("scan", "comparison", "analysis", "translation", "credits");
  state.mode = "revisions";
  state.compare = null;
  state.scan = null;
  state.history.author = author;
  state.history.date = "";
  void loadHistory(false, true);
}

function selectFinding(scope, index) {
  const comparison = state.compare;
  if (!comparison) return;
  const all = scope === "timeline" ? state.findingsByRevision.get(comparison.to) : comparison[scope]?.findings;
  const finding = all?.[index];
  if (!finding) return;
  comparison.highlight = finding;
  if (state.mode === "editions") {
    if (finding.leftKey) comparison.leftKey = finding.leftKey;
    if (finding.rightKey) comparison.rightKey = finding.rightKey;
    cancel("translation");
    comparison.translation = null;
  } else {
    comparison.section = finding.rightKey || finding.leftKey;
  }
  render();
  scrollToEvidence();
}

document.addEventListener("click", event => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  event.preventDefault();
  const { action, wiki, title, page, id, author, mode, scope, index } = button.dataset;
  switch (action) {
    case "home": setView("explore"); break;
    case "library": setView("library"); break;
    case "open": void openArticle(wiki, title, Number(page)); break;
    case "example": void openArticle("en", title); break;
    case "more": void loadHistory(true); break;
    case "pick-date": {
      const side = button.dataset.side;
      openRevisionPicker(state.article, side, state.range[side]);
      break;
    }
    case "compare-range": void compareRevisions(state.range.from.id, (state.range.to ?? state.article.latest).id); break;
    case "edit": {
      const finding = state.findingsByRevision.get(Number(id))?.[0];
      selectEdit(Number(id), finding?.rightKey || finding?.leftKey);
      break;
    }
    case "credits": void loadCredits(); break;
    case "scan": void scanTimeline(); break;
    case "analyze": void analyzeComparison(); break;
    case "analyze-section": void analyzeComparison(true); break;
    case "translate": void translateSection(); break;
    case "edit-article": editRecord("articles", button.dataset); break;
    case "edit-author": editRecord("authors", button.dataset); break;
    case "dialog-close": $("#record-dialog").close(); break;
    case "filter-author":
      $("#record-dialog").close();
      filterAuthor(editingRecord.item.user);
      break;
    case "filter-library-author": void openArticle(wiki, title, Number(page), { author }); break;
    case "clear-author": filterAuthor(""); break;
    case "finding": selectFinding(scope, Number(index)); break;
    case "section":
      state.compare.section = button.dataset.key;
      state.compare.highlight = null;
      render();
      break;
    case "mode":
      if (mode === state.mode) break;
      cancel("comparison", "analysis", "translation", "credits");
      state.mode = mode;
      state.compare = null;
      render();
      if (mode === "editions" && state.target) void compareEditions(state.target);
      else if (mode === "revisions" && state.article.latest) void compareRevisions(state.article.latest.parent, state.article.latest.id);
      updateUrl();
      break;
    default: break;
  }
});

document.addEventListener("change", event => {
  const comparison = state.compare;
  switch (event.target.id) {
    case "source-language":
      cancel("search");
      setSearch("");
      break;
    case "edition-picker": void compareEditions(event.target.value); break;
    case "revision-section":
      comparison.section = event.target.value;
      comparison.highlight = null;
      render();
      break;
    case "edition-left":
    case "edition-right":
      cancel("analysis", "translation");
      if (comparison.analysis?.loading) comparison.analysis = null;
      comparison[event.target.id === "edition-left" ? "leftKey" : "rightKey"] = event.target.value;
      comparison.highlight = null;
      comparison.sectionAnalysis = null;
      comparison.translation = null;
      render();
      break;
    default: break;
  }
});

document.addEventListener("submit", event => {
  const form = event.target;
  if (form.id === "search-form") {
    void search(event);
    return;
  }
  const fields = new FormData(form);
  switch (form.id) {
    case "date-form":
      event.preventDefault();
      cancel("scan");
      state.scan = null;
      state.history.date = String(fields.get("date") || "");
      void loadHistory();
      break;
    case "record-form": {
      event.preventDefault();
      if (!editingRecord) return;
      const { kind, key, item } = editingRecord;
      const favorite = fields.has("favorite");
      const tags = [...new Set(String(fields.get("tags") || "").split(",").map(tag => tag.trim()).filter(Boolean))].slice(0, 12);
      if (favorite || tags.length) {
        const { wiki, id, title, user } = item;
        state.saved[kind][key] = { wiki, id, title, user, article: item.article, favorite, tags };
      } else delete state.saved[kind][key];
      if (storeLibrary()) notice("Library updated.");
      $("#record-dialog").close();
      render();
      break;
    }
    default: break;
  }
});

renderLanguages();
void api("languages").then(languages => {
  if (!languages.length) return;
  state.languages = languages;
  renderLanguages();
  if (state.article) render();
}).catch(() => {});
const query = new URLSearchParams(location.search);
if (query.has("title")) {
  void openArticle(query.get("wiki") || "en", query.get("title"), null, {
    edition: query.get("edition"), from: Number(query.get("from")), to: Number(query.get("to"))
  });
} else render();
