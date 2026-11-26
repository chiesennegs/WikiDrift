const monthNames = new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" });
const fullMonthNames = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" });
const monthName = (month, full = false) => (full ? fullMonthNames : monthNames).format(new Date(Date.UTC(2020, month - 1, 1)));
const number = new Intl.NumberFormat("en");
const pad = value => String(value).padStart(2, "0");
const pagesPerLoad = 4;

export function monthWindow(year, month) {
  const prefix = `${year}-${pad(month)}`;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { first: `${prefix}-01`, last: `${prefix}-${days}`, days };
}

export function calendarCount(activity, prefix) {
  if (!activity) return { count: 0, complete: false };
  const count = Object.entries(activity.days).reduce((sum, [day, edits]) => day.startsWith(prefix) ? sum + edits : sum, 0);
  return { count, complete: activity.cursor === null || Boolean(activity.oldest && prefix > activity.oldest.slice(0, prefix.length)) };
}

export function createRevisionPicker({ dialog, api, html, date, author, refreshAuthors, onPick }) {
  const $ = selector => dialog.querySelector(selector);
  const yearStrip = $("#picker-years");
  const pickerContent = $("#picker-content") ?? dialog;
  const activityByYear = new Map();
  let articleKey;
  let firstDate;
  let picker;
  let activityRequest;
  let editsRequest;
  let boundsRequest;
  let lookupRequest;
  let renderedYears;

  function yearBounds() {
    const latest = Number(picker.article.latest.date.slice(0, 4));
    return { first: firstDate ? Number(firstDate.slice(0, 4)) : Math.min(2001, latest), last: latest };
  }

  function revealItem(strip, item) {
    if (!item) return;
    const viewport = strip.getBoundingClientRect();
    const rect = item.getBoundingClientRect();
    if (rect.left < viewport.left + 4) strip.scrollLeft += rect.left - viewport.left - 4;
    else if (rect.right > viewport.right - 4) strip.scrollLeft += rect.right - viewport.right + 4;
  }

  function renderYear() {
    const { first, last } = yearBounds();
    const boundsKey = `${first}:${last}`;
    if (boundsKey !== renderedYears) {
      const years = Array.from({ length: last - first + 1 }, (_, index) => first + index);
      $("#picker-year").innerHTML = years.slice().reverse().map(year => `<option value="${year}">${year}</option>`).join("");
      if (yearStrip) yearStrip.innerHTML = years.map(year => `<button type="button" class="button picker-year-chip" data-picker="year" data-key="${year}">${year}</button>`).join("");
      renderedYears = boundsKey;
    }
    $("#picker-year").value = picker.year;
    if (yearStrip) {
      for (const button of yearStrip.children) {
        const selected = Number(button.dataset.key) === picker.year;
        button.setAttribute("aria-pressed", String(selected));
        button.tabIndex = selected ? 0 : -1;
        if (selected) revealItem(yearStrip, button);
      }
    }
    $('[data-picker="older-year"]').disabled = picker.year <= first;
    $('[data-picker="newer-year"]').disabled = picker.year >= last;
    $("#picker-date").min = firstDate || "";
    $("#picker-date").max = new Date().toISOString().slice(0, 10);
  }

  function countLabel(value) {
    if (!value.complete && !value.count) return "Count pending";
    return `${value.complete ? "" : "At least "}${number.format(value.count)} ${value.count === 1 ? "edit" : "edits"}`;
  }

  function bar(key, label, title, value, max, action, active, disabled = false) {
    const height = value.count ? Math.max(8, Math.round(value.count / max * 100)) : 0;
    return `<button type="button" class="activity-bar${value.complete ? "" : " activity-incomplete"}" data-picker="${action}" data-key="${key}"
      aria-pressed="${active}" aria-label="${html(`${title}, ${disabled ? "outside article history" : countLabel(value)}`)}"
      title="${html(`${title} · ${disabled ? "Outside article history" : countLabel(value)}`)}"${disabled ? " disabled" : ""}>
      <span class="activity-track" aria-hidden="true"><span style="--bar-height:${height}%"></span></span>
      <span class="activity-label" aria-hidden="true">${label}</span>
    </button>`;
  }

  function renderActivity() {
    if (!picker || !dialog.open) return;
    const year = picker.year;
    const activity = activityByYear.get(year);
    const focus = document.activeElement?.closest("[data-picker][data-key]")?.dataset;
    const monthValues = Array.from({ length: 12 }, (_, index) => {
      const month = index + 1;
      const window = monthWindow(year, month);
      return { month, ...calendarCount(activity, window.first.slice(0, 7)),
        disabled: window.first > picker.article.latest.date.slice(0, 10) || Boolean(firstDate && window.last < firstDate) };
    });
    const maxMonth = Math.max(1, ...monthValues.map(item => item.count));
    $("#picker-months").innerHTML = monthValues.map(value =>
      bar(value.month, monthName(value.month), `${monthName(value.month, true)} ${year}`, value,
        maxMonth, "month", value.month === picker.month, value.disabled)).join("");
    const months = $("#picker-months");
    if (focus?.picker === "month") revealItem(months, months.querySelector('[aria-pressed="true"]'));
    const window = monthWindow(year, picker.month);
    const prefix = window.first.slice(0, 7);
    const dayValues = Array.from({ length: window.days }, (_, index) => {
      const day = `${prefix}-${pad(index + 1)}`;
      return { day, ...calendarCount(activity, day) };
    });
    const maxDay = Math.max(1, ...dayValues.map(item => item.count));
    $("#picker-days").innerHTML = dayValues.map((value, index) => bar(value.day, index + 1,
      date(value.day), value, maxDay, "day", value.day === picker.day,
      value.day > picker.article.latest.date.slice(0, 10) || Boolean(firstDate && value.day < firstDate))).join("");
    $("#picker-month-title").textContent = `Daily activity in ${monthName(picker.month, true)} ${year}`;
    const total = calendarCount(activity, String(year));
    $("#picker-activity-status").textContent = activity?.loading ? `Counting edits…${total.count ? ` ${number.format(total.count)} so far.` : ""}`
      : activity?.error ? activity.error
      : total.complete ? `${number.format(total.count)} ${total.count === 1 ? "edit" : "edits"} in ${year}.`
      : total.count ? `${number.format(total.count)} edits counted. Striped bars indicate incomplete counts.`
      : "Edit counts are loading.";
    $("#picker-more-activity").hidden = !activity || activity.loading || activity.cursor === null && !activity.error;
    if (focus) {
      [...dialog.querySelectorAll("[data-picker][data-key]")]
        .find(button => button.dataset.picker === focus.picker && button.dataset.key === focus.key)
        ?.focus({ preventScroll: true });
    }
  }

  async function loadActivity() {
    activityRequest?.abort();
    const current = picker;
    const year = current.year;
    let activity = activityByYear.get(year);
    if (activity?.cursor === null) {
      renderActivity();
      return;
    }
    if (!activity) {
      activity = { days: {}, cursor: undefined, oldest: null };
      activityByYear.set(year, activity);
    }
    const controller = new AbortController();
    activityRequest = controller;
    activity.loading = true;
    activity.error = "";
    renderActivity();
    try {
      for (let page = 0; page < pagesPerLoad; page += 1) {
        const data = await api("activity", { wiki: current.article.wiki, page: current.article.id, year, cursor: activity.cursor },
          { signal: controller.signal });
        if (controller.signal.aborted) return;
        for (const [day, edits] of Object.entries(data.days)) activity.days[day] = (activity.days[day] ?? 0) + edits;
        activity.cursor = data.cursor;
        activity.oldest = data.oldest ?? activity.oldest;
        renderActivity();
        if (data.cursor === null) break;
      }
    } catch (error) {
      if (!controller.signal.aborted) activity.error = error.message;
    } finally {
      if (activityRequest === controller || picker?.year !== year) activity.loading = false;
      if (!controller.signal.aborted) renderActivity();
    }
  }

  function renderEdits() {
    const current = picker;
    const title = current.day ? date(current.day) : `${monthName(current.month, true)} ${current.year}`;
    $("#picker-edits-title").textContent = `Revisions in ${title}`;
    $("#picker-edits-status").textContent = current.loading ? "Loading revisions…"
      : current.error || (!current.items.length ? "No revisions in this period." : "");
    $("#picker-edits-list").innerHTML = current.items.map(revision =>
      `<li><button type="button" class="picker-edit" data-picker="pick" data-key="${revision.id}">
        <span><strong>${date(revision.date, true)} UTC</strong> · ${author(revision)}</span>
        ${revision.comment ? `<small dir="auto">${html(revision.comment)}</small>` : ""}
      </button></li>`).join("");
    $("#picker-more-edits").hidden = !current.cursor || current.loading;
    refreshAuthors(dialog);
  }

  async function loadEdits(append = false) {
    editsRequest?.abort();
    editsRequest = new AbortController();
    const { signal } = editsRequest;
    const current = picker;
    if (!append) {
      current.items = [];
      current.cursor = null;
    }
    current.loading = true;
    current.error = "";
    renderEdits();
    const { first, last } = monthWindow(current.year, current.month);
    try {
      const data = await api("revisions", {
        wiki: current.article.wiki, page: current.article.id,
        after: current.day || first, date: current.day || last, cursor: current.cursor
      }, { signal });
      if (signal.aborted) return;
      current.items.push(...data.revisions);
      current.cursor = data.cursor;
    } catch (error) {
      if (!signal.aborted) current.error = error.message;
    } finally {
      if (!signal.aborted) {
        current.loading = false;
        renderEdits();
      }
    }
  }

  function showPeriod(year, month, day = "") {
    lookupRequest?.abort();
    $("#picker-date-status").textContent = "";
    const latest = picker.article.latest.date;
    if (year === Number(latest.slice(0, 4))) month = Math.min(month, Number(latest.slice(5, 7)));
    if (firstDate && year === Number(firstDate.slice(0, 4))) month = Math.max(month, Number(firstDate.slice(5, 7)));
    const yearChanged = picker.year !== year;
    Object.assign(picker, { year, month, day });
    if (yearChanged) {
      renderYear();
      void loadActivity();
    } else {
      renderActivity();
    }
    const months = $("#picker-months");
    revealItem(months, months.querySelector('[aria-pressed="true"]'));
    const monthEnd = monthWindow(year, month).last;
    $("#picker-date").value = day || (monthEnd > latest.slice(0, 10) ? latest.slice(0, 10) : monthEnd);
    void loadEdits();
  }

  function choose(revision) {
    const side = picker.side;
    dialog.close();
    onPick(side, revision);
  }

  dialog.addEventListener("click", event => {
    const button = event.target.closest("[data-picker]");
    if (!button || !picker) return;
    const { picker: action, key } = button.dataset;
    switch (action) {
      case "close": dialog.close(); break;
      case "older-year": showPeriod(picker.year - 1, picker.month); break;
      case "newer-year": showPeriod(picker.year + 1, picker.month); break;
      case "year": showPeriod(Number(key), picker.month); break;
      case "month": showPeriod(picker.year, Number(key)); break;
      case "day": showPeriod(picker.year, picker.month, key); break;
      case "more-activity": void loadActivity(); break;
      case "more-edits": void loadEdits(true); break;
      case "pick": {
        const revision = picker.items.find(item => String(item.id) === key);
        if (revision) choose(revision);
        break;
      }
    }
  });

  yearStrip?.addEventListener("keydown", event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const { first, last } = yearBounds();
    const targetYear = {
      ArrowLeft: Math.max(first, picker.year - 1), ArrowRight: Math.min(last, picker.year + 1), Home: first, End: last
    }[event.key];
    if (targetYear === undefined) return;
    event.preventDefault();
    if (targetYear !== picker.year) showPeriod(targetYear, picker.month);
    yearStrip.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
  });

  yearStrip?.addEventListener("wheel", event => {
    if (!event.deltaY || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const step = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? yearStrip.clientWidth : 1;
    const offset = yearStrip.scrollLeft;
    yearStrip.scrollLeft += event.deltaY * step;
    if (yearStrip.scrollLeft !== offset) event.preventDefault();
  }, { passive: false });

  $("#picker-year").addEventListener("change", event => showPeriod(Number(event.target.value), picker.month));
  $("#picker-date-form").addEventListener("submit", async event => {
    event.preventDefault();
    const chosenDate = $("#picker-date").value;
    if (!chosenDate) return;
    lookupRequest?.abort();
    const { signal } = lookupRequest = new AbortController();
    $("#picker-date-status").textContent = "Finding the nearest revision…";
    try {
      const data = await api("revisions", { wiki: picker.article.wiki, page: picker.article.id, date: chosenDate }, { signal });
      if (signal.aborted) return;
      if (data.revisions[0]) choose(data.revisions[0]);
      else $("#picker-date-status").textContent = "No revisions on or before that date.";
    } catch (error) {
      if (!signal.aborted) $("#picker-date-status").textContent = error.message;
    }
  });

  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    activityRequest?.abort();
    editsRequest?.abort();
    boundsRequest?.abort();
    lookupRequest?.abort();
  });

  return function open(article, side, revision) {
    if (!article.latest || dialog.open) return;
    const key = `${article.wiki}:${article.id}`;
    if (key !== articleKey) {
      activityByYear.clear();
      firstDate = undefined;
      articleKey = key;
    }
    const anchor = revision?.date ?? article.latest.date;
    const year = Number(anchor.slice(0, 4));
    const month = Number(anchor.slice(5, 7));
    picker = { article, side, year, month, day: "", items: [], cursor: null };
    $("#picker-title").textContent = side === "from" ? "Choose earlier revision" : "Choose later revision";
    $("#picker-date").value = anchor.slice(0, 10);
    $("#picker-date-status").textContent = "";
    dialog.showModal();
    pickerContent.scrollTop = 0;
    renderYear();
    void loadActivity();
    const months = $("#picker-months");
    revealItem(months, months.querySelector('[aria-pressed="true"]'));
    void loadEdits();

    if (!firstDate) {
      const { signal } = boundsRequest = new AbortController();
      void api("history-start", { wiki: article.wiki, page: article.id }, { signal }).then(data => {
        if (signal.aborted || !dialog.open) return;
        firstDate = data.first?.slice(0, 10);
        if (firstDate && (picker.year < Number(firstDate.slice(0, 4)) || monthWindow(picker.year, picker.month).last < firstDate)) {
          const year = Number(firstDate.slice(0, 4));
          const month = Number(firstDate.slice(5, 7));
          showPeriod(year, month);
        }
        renderYear();
        renderActivity();
      }).catch(() => {});
    }
  };
}
