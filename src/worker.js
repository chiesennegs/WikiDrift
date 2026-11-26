import { analyze } from "./analysis.js";
import { AppError, makeWikipedia, positiveId, wikiCode } from "./wikipedia.js";

const json = (data, status = 200) => Response.json(data, {
  status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
});

function parameter(params, key, length) {
  const value = params.get(key)?.trim() ?? "";
  if (value.length > length) throw new AppError(400, `The ${key} value is too long.`);
  return value;
}

function dateParameter(params, key) {
  const date = params.get(key);
  if (!date) return "";
  const stamp = Date.parse(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== date) {
    throw new AppError(400, "Choose a valid date.");
  }
  return date;
}

async function api(request, env, ctx) {
  const { pathname, origin, searchParams: params } = new URL(request.url);
  const ai = pathname === "/api/analysis" || pathname === "/api/translation";
  if (request.method !== (ai ? "POST" : "GET")) throw new AppError(405, "This method is unavailable.");
  if (ai) return analyze(request, env, ctx, pathname === "/api/translation");

  const wiki = makeWikipedia(env, origin);
  if (pathname === "/api/languages") return json(await wiki.languages());
  if (!["/api/search", "/api/topic", "/api/revisions", "/api/activity", "/api/history-start", "/api/author-status", "/api/metadata", "/api/snapshot", "/api/wikitext"].includes(pathname)) {
    throw new AppError(404, "This WikiDrift endpoint does not exist.");
  }
  const code = wikiCode(params.get("wiki"));

  if (pathname === "/api/search") {
    const term = parameter(params, "q", 250);
    return json(term ? await wiki.search(code, term) : []);
  }
  if (pathname === "/api/topic") {
    const id = params.has("page") ? positiveId(params.get("page")) : null;
    const title = parameter(params, "title", 350);
    if (!id && (!title || title.includes("|"))) throw new AppError(400, "Enter one Wikipedia article title.");
    return json(await wiki.topic(code, title, id, params.get("links") !== "0"));
  }
  if (pathname === "/api/revisions") {
    const newer = params.has("newer") ? positiveId(params.get("newer")) : null;
    const older = params.has("older") ? positiveId(params.get("older")) : null;
    if (Boolean(newer) !== Boolean(older)) throw new AppError(400, "Choose both revisions for the range.");
    const date = dateParameter(params, "date");
    const after = dateParameter(params, "after");
    if (after && (!date || after > date || newer)) throw new AppError(400, "Choose a valid date range.");
    const limit = params.has("limit") ? positiveId(params.get("limit")) : 20;
    if (limit > 500) throw new AppError(400, "Choose up to 500 revision records.");
    const options = { cursor: parameter(params, "cursor", 120), date, after,
      author: parameter(params, "author", 250), newer, older, limit };
    return json(await wiki.revisions(code, positiveId(params.get("page")), options));
  }
  if (pathname === "/api/history-start") {
    return json(await wiki.historyStart(code, positiveId(params.get("page"))));
  }
  if (pathname === "/api/activity") {
    const year = Number(params.get("year"));
    if (!Number.isInteger(year) || year < 1900 || year > new Date().getUTCFullYear()) {
      throw new AppError(400, "Choose a valid revision year.");
    }
    return json(await wiki.activity(code, positiveId(params.get("page")), year, parameter(params, "cursor", 120)));
  }
  if (pathname === "/api/author-status") {
    const authors = [...new Set(parameter(params, "users", 8000).split("|").filter(Boolean))];
    if (!authors.length || authors.length > 25 || authors.some(name => name.length > 250 || /[:#\u0000-\u001f]/u.test(name))) {
      throw new AppError(400, "Choose up to 25 named Wikipedia accounts.");
    }
    return json(await wiki.authorStatus(code, authors));
  }
  if (pathname === "/api/metadata") {
    const ids = (params.get("ids") ?? "").split(",");
    if (ids.length > 20) throw new AppError(400, "Choose up to twenty revisions.");
    const items = await wiki.metadata(code, ids.map(positiveId));
    return json([...items.values()]);
  }

  let response;
  if (pathname === "/api/wikitext") {
    const ids = parameter(params, "ids", 400).split(",");
    if (ids.length > 20) throw new AppError(400, "Choose up to twenty revisions.");
    response = await wiki.wikitext(code, [...new Set(ids.map(positiveId))].sort((left, right) => left - right));
  } else {
    response = await wiki.snapshot(code, positiveId(params.get("id")));
  }
  // Stream historical content inside Wikipedia's JSON envelope.
  return new Response(response.body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await api(request, env, ctx);
    } catch (error) {
      if (error instanceof AppError) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: "WikiDrift could not complete the request." }, 500);
    }
  }
};
