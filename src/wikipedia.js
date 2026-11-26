export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const wikiPattern = /^[a-z0-9]{1,16}(?:-[a-z0-9]{1,16}){0,4}$/;

export function wikiCode(value) {
  if (typeof value !== "string" || !wikiPattern.test(value)) {
    throw new AppError(400, "Choose a valid Wikipedia edition.");
  }
  return value;
}

export function positiveId(value) {
  const id = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(id) || id < 1) {
    throw new AppError(400, "Choose a valid Wikipedia article or revision.");
  }
  return id;
}

export function wikiFromUrl(value) {
  return /^https:\/\/([a-z0-9-]+)\.wikipedia\.org(?:\/|$)/.exec(value ?? "")?.[1];
}

export function makeWikipedia(env, appUrl) {
  const agent = `WikiDrift/0.1 (${env.WIKIMEDIA_CONTACT || appUrl})`;
  const revisionFields = "ids|timestamp|user|userid|comment|size|flags";

  async function request(host, params) {
    const url = new URL(`https://${host}/w/api.php`);
    url.search = new URLSearchParams({ format: "json", formatversion: "2", maxlag: "5", ...params });
    let response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        headers: { Accept: "application/json", "User-Agent": agent },
        signal: AbortSignal.timeout(18000),
        cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": params.oldid ? 900 : 60, "400-599": -1 } }
      });
    } catch (error) {
      console.warn("Wikipedia request failed", error instanceof Error ? error.message : String(error));
      throw new AppError(502, "Wikipedia did not respond. Try again in a moment.");
    }
    if (response.status === 429 || response.status === 503) {
      throw new AppError(503, "Wikipedia is busy. Try again in a moment.");
    }
    if (!response.ok) throw new AppError(502, "Wikipedia could not return this data.");
    return response;
  }

  async function query(host, params) {
    const response = await request(host, params);
    const data = await response.json().catch(() => {
      throw new AppError(502, "Wikipedia could not return this data.");
    });
    if (data.error?.code === "maxlag") throw new AppError(503, "Wikipedia is busy. Try again in a moment.");
    if (data.error?.code === "missingtitle" || data.error?.code === "nosuchrevid" || data.error?.code === "missingrev") {
      throw new AppError(404, "Wikipedia could not find this article or revision.");
    }
    if (data.error) {
      throw new AppError(502, "Wikipedia could not return this data.");
    }
    return data;
  }

  function wikipedia(wiki, params) {
    return query(`${wikiCode(wiki)}.wikipedia.org`, params);
  }

  function revision(wiki, page, item) {
    if (!item?.revid) return null;
    // Wikimedia exposes some historical edits under IP addresses. Keep the audit
    // trail via the revision link and omit IPs from WikiDrift's author records.
    const user = item.userhidden || !item.user || (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(item.user) || item.user.includes(":"))
      ? null
      : item.user;
    return {
      id: item.revid,
      parent: item.parentid || null,
      date: item.timestamp,
      user,
      hidden: Boolean(item.userhidden),
      comment: item.comment ?? "",
      size: item.size ?? null,
      minor: Boolean(item.minor),
      page: { wiki, id: page.pageid, title: page.title }
    };
  }

  function article(data, wiki) {
    const page = data.query?.pages?.[0];
    if (!page || page.missing || page.ns !== 0) {
      throw new AppError(404, "Wikipedia could not find that article.");
    }
    return {
      wiki, id: page.pageid, title: page.title,
      latest: revision(wiki, page, page.revisions?.[0]),
      languages: (page.langlinks ?? []).flatMap(link => {
        const target = wikiFromUrl(link.url);
        return target ? [{ wiki: target, title: link.title ?? link["*"], name: link.langname ?? link.lang, autonym: link.autonym }] : [];
      })
    };
  }

  return {
    async languages() {
      const editions = [];
      let cursor;
      do {
        const data = await query("meta.wikimedia.org", {
          action: "sitematrix", smtype: "language", smlangprop: "name|site|localname",
          smsiteprop: "url|code", smlimit: "max", ...(cursor ? { smcontinue: cursor } : {})
        });
        for (const language of Object.values(data.sitematrix ?? {})) {
          const site = language?.site?.find(entry => entry.code === "wiki" && !("closed" in entry) && !("private" in entry));
          const wiki = wikiFromUrl(site?.url);
          if (wiki) editions.push({ wiki, name: language.localname || language.name, autonym: language.name });
        }
        cursor = data.continue?.smcontinue;
      } while (cursor);
      return editions.sort((left, right) => left.name.localeCompare(right.name, "en"));
    },

    async search(wiki, term) {
      const data = await wikipedia(wiki, {
        action: "query", list: "search", srsearch: term, srnamespace: "0", srlimit: "8", srprop: "snippet"
      });
      return (data.query?.search ?? []).map(result => ({
        id: result.pageid, title: result.title, wiki, snippet: result.snippet
      }));
    },

    async topic(wiki, title, id, includeLanguages = true) {
      const data = await wikipedia(wiki, {
        action: "query", redirects: "1",
        prop: includeLanguages ? "revisions|langlinks" : "revisions",
        rvprop: revisionFields,
        ...(includeLanguages ? { llprop: "url|langname|autonym", lllimit: "max" } : {}),
        ...(id ? { pageids: id } : { titles: title })
      });
      return article(data, wiki);
    },

    async revisions(wiki, pageId, options = {}) {
      const { cursor, date, author, newer, older } = options;
      const data = await wikipedia(wiki, {
        action: "query", pageids: pageId, prop: "revisions", rvprop: revisionFields,
        rvlimit: "20", rvdir: "older",
        ...(cursor ? { rvcontinue: cursor, continue: "||" } : {}),
        ...(date ? { rvstart: `${date}T23:59:59Z` } : {}),
        ...(author ? { rvuser: author } : {}),
        ...(newer && older ? { rvstartid: newer, rvendid: older } : {})
      });
      const page = data.query?.pages?.[0];
      if (!page || page.missing || page.ns !== 0) throw new AppError(404, "That article is unavailable.");
      return {
        revisions: (page.revisions ?? []).filter(item => item.revid !== older).map(item => revision(wiki, page, item)),
        cursor: data.continue?.rvcontinue ?? null
      };
    },

    async metadata(wiki, ids) {
      const data = await wikipedia(wiki, {
        action: "query", revids: ids.join("|"), prop: "revisions", rvprop: revisionFields
      });
      const items = (data.query?.pages ?? []).filter(page => page.ns === 0)
        .flatMap(page => (page.revisions ?? []).map(item => revision(wiki, page, item)));
      return new Map(items.map(item => [item.id, item]));
    },

    snapshot(wiki, id) {
      return request(`${wikiCode(wiki)}.wikipedia.org`, {
        action: "parse", oldid: id, prop: "text", disabletoc: "1", disableeditsection: "1"
      });
    }
  };
}
