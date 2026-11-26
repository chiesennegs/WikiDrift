const labels = {
  "global-lock": "Globally locked",
  "global-block": "Globally blocked",
  "partial-block": "Partially blocked",
  "local-block": "Blocked"
};

function label(status, date) {
  const name = labels[status?.restriction];
  if (!name) return null;
  const time = Date.parse(status.expiry);
  if (Number.isFinite(time) && time <= Date.now()) return null;
  const indefinite = /^(?:infinity|infinite|indefinite|never)$/i.test(status.expiry ?? "");
  const context = status.restriction === "local-block" || status.restriction === "partial-block"
    ? " on this Wikipedia edition" : " by Wikimedia";
  return {
    text: indefinite && status.restriction === "local-block" ? "Blocked indefinitely" : name,
    title: name + context + (Number.isFinite(time) ? ` until ${date(status.expiry, true)} UTC` : indefinite ? " indefinitely" : "")
  };
}

export function createAuthorBadges({ api, html, date }) {
  const results = new Map();
  const pending = new Set();
  const key = (wiki, user) => `${wiki}:${user}`;

  function badge(wiki, user) {
    if (!wiki || !user) return "";
    const restriction = label(results.get(key(wiki, user))?.status, date);
    return `<span class="author-status" data-author-wiki="${html(wiki)}" data-author-user="${html(user)}"
      ${restriction ? `title="${html(restriction.title)}"` : "hidden"}>${html(restriction?.text)}</span>`;
  }

  function apply(nodes) {
    for (const node of nodes) {
      const { authorWiki, authorUser } = node.dataset;
      const restriction = label(results.get(key(authorWiki, authorUser))?.status, date);
      node.hidden = !restriction;
      node.textContent = restriction?.text ?? "";
      node.title = restriction?.title ?? "";
    }
  }

  async function batch(wiki, users) {
    users.forEach(user => pending.add(key(wiki, user)));
    let statuses;
    try {
      const items = await api("author-status", { wiki, users: users.join("|") });
      statuses = new Map(items.map(item => [item.name, item]));
    } catch {
      // Attribution remains available when the status lookup fails.
    } finally {
      for (const user of users) {
        const id = key(wiki, user);
        pending.delete(id);
        if (results.size >= 1000) results.delete(results.keys().next().value);
        const cached = results.get(id);
        results.set(id, { status: statuses ? statuses.get(user) : cached?.status,
          expires: Date.now() + (statuses ? 300000 : 30000) });
      }
      apply(document.querySelectorAll("[data-author-wiki]"));
    }
  }

  function refresh(root) {
    const nodes = root.querySelectorAll("[data-author-wiki]");
    apply(nodes);
    const grouped = new Map();
    for (const { dataset: { authorWiki, authorUser } } of nodes) {
      const id = key(authorWiki, authorUser);
      if (pending.has(id) || results.get(id)?.expires > Date.now()) continue;
      const users = grouped.get(authorWiki) ?? new Set();
      users.add(authorUser);
      grouped.set(authorWiki, users);
    }
    for (const [wiki, group] of grouped) {
      const users = [...group];
      for (let offset = 0; offset < users.length; offset += 25) void batch(wiki, users.slice(offset, offset + 25));
    }
  }

  return { badge, refresh };
}
