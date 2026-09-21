/* =====================================================================
   qillycoer masterlist tracker
   Everything you might want to edit is inside CONFIG below.
   ===================================================================== */
(() => {
  "use strict";

  const CONFIG = {
    // The long ID in your Google Sheet link (between /d/ and /edit)
    SHEET_ID: "1GOtePsrjxNATOAtVPWcYewHcRO4tBxvflIezjJES0lw",

    // One entry per order tab (KOREA, JAPAN, CHINA, ...).
    // gid = the number at the end of the tab's URL:  ...edit#gid=123456789
    // Tabs whose gid still says PASTE_GID are skipped.
    TABS: [
      { label: "Korea",     gid: "PASTE_GID" },
      { label: "Japan",     gid: "PASTE_GID" },
      { label: "China",     gid: "PASTE_GID" },
      { label: "Local",     gid: "PASTE_GID" },
      { label: "Xianyu",    gid: "PASTE_GID" },
      { label: "Indonesia", gid: "PASTE_GID" },
      // If a tab's headers aren't auto-detected, tell the site which columns to use:
      // { label: "Korea", gid: "123", columns: { username: "C", item: "D", status: "H" }, firstDataRow: 6 },
    ],

    // How the site finds your column headers (case-insensitive).
    // Change these words if your headers are named differently.
    HEADERS: {
      username: /telegram|tele\b|username|user name|\btg\b|buyer/i,
      status:   /status|update|progress/i,
      item:     /item|product|order|title|description/i,
    },

    // How status text is grouped. First match wins, so keep the order.
    // Anything that matches none of these is shown as-is and only counts toward Total.
    STATUS_RULES: [
      ["posted",  /\bposted\b|post out/],
      ["admin",   /\badmin\b/],
      ["transit", /\botw\b|on the way|\barrived\b|\bwh\b|warehouse|transit|\bmy\b/],
      ["secured", /secur/],
    ],

    // Reload the sheet if the last load was more than this many minutes ago.
    CACHE_MINUTES: 2,

    ANNOUNCEMENT: {
      title: "Welcome to qillycoer ♡",
      message: "Thanks for shopping with us! Search your Telegram username below to see where your items are.",
      reminders: [
        "Once a payment notice is updated, please pay within 24 hours.",
        "Screenshot your payment receipt. Items without proof of payment can't be processed.",
        "Please don't delete our chat after claiming. Tell us if you need to cancel.",
      ],
    },

    ADMINS: {
      masterlist: "anhkhno",
      admins: ["kikilalax", "irdeena_gx"],
    },
  };

  /* ------------------------------------------------------------------ */

  const STAGES = [
    { key: "secured", label: "Secured",     sub: "" },
    { key: "transit", label: "In transit",  sub: "otw to wh, arrived at wh, otw to my" },
    { key: "admin",   label: "Admin house", sub: "" },
    { key: "posted",  label: "Posted out",  sub: "" },
  ];

  const $ = (id) => document.getElementById(id);
  const els = {
    announcement: $("announcement"),
    form: $("search-form"),
    input: $("username"),
    button: document.querySelector(".go"),
    message: $("message"),
    results: $("results"),
    title: $("results-title"),
    dashboard: $("dashboard"),
    showing: $("showing"),
    orders: $("orders"),
    footer: $("footer"),
  };

  const state = { orders: [], query: "", filter: null };
  let cache = { time: 0, orders: null, failed: [] };

  /* ---------- tiny DOM helper (uses textContent, so sheet text can't inject HTML) ---------- */
  function h(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    kids.flat().forEach((c) => { if (c != null) n.append(c.nodeType ? c : document.createTextNode(c)); });
    return n;
  }

  /* ---------- announcement + footer ---------- */
  function renderAnnouncement() {
    const a = CONFIG.ANNOUNCEMENT;
    els.announcement.replaceChildren(
      h("h1", { text: a.title }),
      a.message ? h("p", { text: a.message }) : null,
      a.reminders && a.reminders.length ? h("ul", {}, a.reminders.map((r) => h("li", { text: r }))) : null
    );
  }

  function renderFooter() {
    const link = (u) => h("a", { href: `https://t.me/${u}`, target: "_blank", rel: "noopener", text: `@${u}` });
    const { masterlist, admins } = CONFIG.ADMINS;
    const adminLine = h("p", {}, "Need help? Message an admin: ");
    admins.forEach((a, i) => { if (i) adminLine.append(", "); adminLine.append(link(a)); });
    els.footer.replaceChildren(h("p", {}, "Masterlist handled by ", link(masterlist)), adminLine);
  }

  /* ---------- reading the Google Sheet ---------- */
  function colIndex(letters) {
    let n = 0;
    for (const ch of String(letters).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  async function fetchGrid(tab) {
    const url = `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/gviz/tq?tqx=out:json&gid=${encodeURIComponent(tab.gid)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    if (json.status === "error") throw new Error((json.errors && json.errors[0] && json.errors[0].message) || "Sheet error");

    const cell = (c) => (c && c.v !== null && c.v !== undefined ? String(c.f != null ? c.f : c.v).trim() : "");
    const labels = json.table.cols.map((c) => (c.label || "").trim());
    const rows = json.table.rows.map((r) => (r.c || []).map(cell));
    return [labels, ...rows]; // Google sometimes turns row 1 into "labels", so keep it as a row
  }

  function detectColumns(grid, tab) {
    if (tab.columns) {
      const first = (tab.firstDataRow || 1) - 1;
      return {
        start: first,
        username: colIndex(tab.columns.username),
        item: tab.columns.item ? colIndex(tab.columns.item) : -1,
        status: colIndex(tab.columns.status),
      };
    }
    const H = CONFIG.HEADERS;
    const short = (c) => c && c.length < 40;
    for (let i = 0; i < Math.min(grid.length, 40); i++) {
      const row = grid[i];
      const username = row.findIndex((c) => short(c) && H.username.test(c));
      const status = row.findIndex((c, j) => short(c) && j !== username && H.status.test(c));
      if (username > -1 && status > -1) {
        const item = row.findIndex((c, j) => short(c) && j !== username && j !== status && H.item.test(c));
        return { start: i + 1, username, item, status };
      }
    }
    return null;
  }

  function usernameKeys(raw) {
    return String(raw)
      .toLowerCase()
      .split(/[\s,;\/]+/)
      .map((t) => t.replace(/^(https?:\/\/)?t\.me\//, "").replace(/^@/, "").replace(/[^a-z0-9_]/g, ""))
      .filter(Boolean);
  }

  function categorize(raw) {
    const s = String(raw || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!s) return "unknown";
    for (const [cat, re] of CONFIG.STATUS_RULES) if (re.test(s)) return cat;
    return "unknown";
  }

  async function loadTab(tab) {
    const grid = await fetchGrid(tab);
    const cols = detectColumns(grid, tab);
    if (!cols) throw new Error("Couldn't find the username/status headers. Set `columns` for this tab in CONFIG.TABS.");

    const out = [];
    for (let i = cols.start; i < grid.length; i++) {
      const row = grid[i];
      const keys = usernameKeys(row[cols.username] || "");
      if (!keys.length) continue;
      const statusRaw = (row[cols.status] || "").trim();
      out.push({
        keys,
        tab: tab.label,
        item: cols.item > -1 ? (row[cols.item] || "").trim() : "",
        statusRaw,
        cat: categorize(statusRaw),
      });
    }
    return out;
  }

  async function getOrders() {
    if (cache.orders && Date.now() - cache.time < CONFIG.CACHE_MINUTES * 60000) return cache;

    const tabs = CONFIG.TABS.filter((t) => t.gid && !/^PASTE/i.test(t.gid));
    if (!tabs.length) throw new Error("No tab gids set in CONFIG.TABS");

    const settled = await Promise.allSettled(tabs.map(loadTab));
    const orders = [], failed = [];
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") orders.push(...r.value);
      else { failed.push(tabs[i].label); console.error(`[masterlist] ${tabs[i].label}:`, r.reason); }
    });
    if (failed.length === tabs.length) throw new Error("Could not load any tab");

    cache = { time: Date.now(), orders, failed };
    return cache;
  }

  /* ---------- rendering results ---------- */
  function countBy(orders) {
    const c = { total: orders.length, secured: 0, transit: 0, admin: 0, posted: 0 };
    orders.forEach((o) => { if (c[o.cat] !== undefined) c[o.cat]++; });
    return c;
  }

  function renderDashboard(counts) {
    const tile = (cat, label, num, sub) =>
      h("button", {
        type: "button", class: "tile", "data-cat": cat, "data-filter": cat,
        "aria-pressed": String((cat === "total" && !state.filter) || state.filter === cat),
        onclick: () => { state.filter = cat === "total" || state.filter === cat ? null : cat; renderList(); syncTiles(); },
      },
        h("span", { class: "tile-num", text: String(num) }),
        h("span", { class: "tile-label" }, label, sub ? h("span", { class: "tile-sub", text: sub }) : null)
      );

    els.dashboard.replaceChildren(
      tile("total", "Total orders", counts.total),
      ...STAGES.map((s) => tile(s.key, s.label, counts[s.key], s.sub))
    );
  }

  function syncTiles() {
    els.dashboard.querySelectorAll(".tile").forEach((t) => {
      const cat = t.dataset.filter;
      t.setAttribute("aria-pressed", String((cat === "total" && !state.filter) || state.filter === cat));
    });
  }

  function renderList() {
    const shown = state.filter ? state.orders.filter((o) => o.cat === state.filter) : state.orders;
    const stageName = state.filter && (STAGES.find((s) => s.key === state.filter) || {}).label;
    els.showing.textContent = state.filter
      ? `Showing ${shown.length} of ${state.orders.length} orders: ${stageName}. Tap the tile again to see all.`
      : `All ${state.orders.length} orders. Tap a tile above to filter.`;

    els.orders.replaceChildren(
      ...shown.map((o) => {
        const stageIdx = STAGES.findIndex((s) => s.key === o.cat);
        return h("li", { class: "order" },
          h("div", {},
            h("div", { class: "order-item", text: o.item || "Order" }),
            h("div", { class: "order-tab", text: o.tab })
          ),
          h("span", { class: "badge", "data-cat": o.cat, text: o.statusRaw || "No status yet" }),
          stageIdx > -1
            ? h("div", { class: "steps", role: "img", "aria-label": `Stage ${stageIdx + 1} of ${STAGES.length}: ${STAGES[stageIdx].label}` },
                STAGES.map((_, i) => h("i", { class: i <= stageIdx ? "on" : "" })))
            : null
        );
      })
    );
  }

  function showResults(query, orders) {
    state.query = query;
    state.orders = orders;
    state.filter = null;
    els.title.textContent = `Orders for @${query}`;
    renderDashboard(countBy(orders));
    renderList();
    els.results.hidden = false;
  }

  function setMessage(text, isError = false) {
    els.message.textContent = text;
    els.message.classList.toggle("error", isError);
  }

  /* ---------- search ---------- */
  async function onSearch(e) {
    e.preventDefault();
    const query = usernameKeys(els.input.value)[0] || "";
    if (query.length < 3) {
      els.results.hidden = true;
      setMessage("Please enter your full Telegram username.", true);
      return;
    }

    els.button.disabled = true;
    setMessage("Looking through the masterlist…");
    try {
      const { orders, failed } = await getOrders();
      const mine = orders.filter((o) => o.keys.includes(query));

      if (!mine.length) {
        els.results.hidden = true;
        setMessage(`No orders found for @${query}. Check the spelling of your Telegram username, or message an admin below.`, true);
      } else {
        showResults(query, mine);
        setMessage(failed.length
          ? `Heads up: ${failed.join(", ")} couldn't be loaded, so some orders may be missing. Try again in a moment.`
          : "", !!failed.length);
      }
    } catch (err) {
      console.error("[masterlist]", err);
      els.results.hidden = true;
      setMessage("We couldn't load the masterlist right now. Please try again in a moment.", true);
    } finally {
      els.button.disabled = false;
    }
  }

  /* ---------- go ---------- */
  renderAnnouncement();
  renderFooter();
  els.form.addEventListener("submit", onSearch);
})();
