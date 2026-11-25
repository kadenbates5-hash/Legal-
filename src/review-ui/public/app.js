/* ===== Theme (light/dark) =====
   Runs first, before anything else in this file, to apply a stored
   preference as early as this external script can (the CSP's
   script-src 'self' rules out an inline anti-flash snippet in <head> —
   see "Security headers" in CLAUDE.md for why this project keeps that
   policy strict rather than carving out an exception for one script).
   Per-viewer only: stored in localStorage, never sent to the server —
   same reasoning as the Home panel's "Dismiss"-the-checklist flag. */
function effectiveTheme() {
  const stored = (() => {
    try {
      return localStorage.getItem("theme");
    } catch {
      return null;
    }
  })();
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const icon = document.getElementById("themeIcon");
  if (icon) {
    // Shows the icon for what clicking it switches *to* — a moon while
    // in light mode, a sun while in dark mode.
    icon.setAttribute("href", effectiveTheme() === "dark" ? "#i-sun" : "#i-moon");
  }
}

(function initTheme() {
  const stored = (() => {
    try {
      return localStorage.getItem("theme");
    } catch {
      return null;
    }
  })();
  applyTheme(stored);
})();

// Registers the app-shell service worker (see sw.js's own doc comment
// for exactly what it does and doesn't cache — nothing under /api/).
// Best-effort: an old browser or a blocked registration just means no
// install prompt/offline shell, not a broken app.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}

const PANEL_TITLES = {
  home: "Home",
  search: "Search",
  queue: "Review Queue",
  deadlines: "Deadlines",
  scheduling: "Scheduling",
  intake: "Live Intake Demo",
  drafting: "Drafting",
  cases: "Cases",
  signatures: "Signatures",
  conflicts: "Conflicts",
  research: "Research",
  assistant: "Assistant",
  staff: "Staff",
  messages: "Messages",
  "staff-schedule": "Schedule",
  billing: "Billing",
  trust: "Trust",
  invoices: "Invoices",
  "time-clock": "Time Clock",
  payroll: "Payroll",
  security: "Security",
  accounts: "Accounts",
  import: "Import",
  analytics: "Analytics",
  "my-matters": "My Matters",
  audit: "Audit Log",
};

/* ===== Keyboard reach for clickable rows and tiles =====
   List rows (a Review Queue item, a matter in Cases) and Home's clickable
   stat cards open on click, but they're <li>/<div>, which a keyboard
   can't reach — so a keyboard-only user could see the queue and never
   open anything in it. Rather than touch every place a row is built,
   anything rendered as a clickable row or tile is made focusable as it
   appears, and Enter/Space act like a click. Rows marked .static (no
   click handler) are left alone. */
const CLICKABLE_SELECTOR = "ul.list > li:not(.static):not(.empty-hero-row):not(.skeleton-row), .stat.clickable";
/**
 * A list whose rows are *all* clickable is, to a screen reader, a set of
 * buttons — so it drops its list role and its rows become buttons. A
 * list mixing clickable and plain rows keeps its list semantics (a
 * button can't sit directly in a list), with the clickable rows still
 * focusable and still opened by Enter.
 */
function syncListRoles(ul) {
  const rows = [...ul.children].filter((c) => c.tagName === "LI");
  const allClickable = rows.length > 0 && rows.every((li) => li.matches(CLICKABLE_SELECTOR));
  if (allClickable) ul.setAttribute("role", "none");
  else ul.removeAttribute("role");
  for (const li of rows) {
    if (!li.matches(CLICKABLE_SELECTOR)) continue;
    li.tabIndex = 0;
    if (allClickable) li.setAttribute("role", "button");
    else li.removeAttribute("role");
  }
}
function makeKeyboardReachable(root) {
  if (root.matches?.(".stat.clickable") && !root.hasAttribute("tabindex")) {
    root.tabIndex = 0;
    root.setAttribute("role", "button");
  }
  for (const tile of root.querySelectorAll?.(".stat.clickable:not([tabindex])") ?? []) {
    tile.tabIndex = 0;
    tile.setAttribute("role", "button");
  }
  const lists = new Set();
  if (root.matches?.("ul.list")) lists.add(root);
  if (root.parentElement?.matches("ul.list")) lists.add(root.parentElement);
  for (const ul of root.querySelectorAll?.("ul.list") ?? []) lists.add(ul);
  for (const ul of lists) syncListRoles(ul);
}
new MutationObserver((records) => {
  for (const record of records) {
    if (record.target instanceof Element && record.target.matches("ul.list")) syncListRoles(record.target);
    for (const node of record.addedNodes) if (node.nodeType === 1) makeKeyboardReachable(node);
  }
}).observe(document.body, { childList: true, subtree: true });
makeKeyboardReachable(document.body);
document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target instanceof Element && e.target.matches(CLICKABLE_SELECTOR) && e.target.tabIndex === 0) {
    e.preventDefault();
    e.target.click();
  }
});

/**
 * The page heading, plus the small docket line above it: the tab's number
 * in the binder ("No. 07") and the section it's filed under, so the top
 * of every panel says where in the binder you are, not only its name.
 */
function setPanelHeading(panel) {
  document.getElementById("panelTitle").textContent = PANEL_TITLES[panel] || "";
  const visible = [...document.querySelectorAll("nav.nav button")].filter((b) => !b.hidden);
  const btn = visible.find((b) => b.dataset.panel === panel);
  let group = "Docket";
  if (btn) {
    for (let el = btn.previousElementSibling; el; el = el.previousElementSibling) {
      if (el.classList.contains("nav-group")) {
        group = el.textContent.trim();
        break;
      }
    }
  }
  const number = document.createElement("b");
  number.textContent = btn ? `No. ${String(visible.indexOf(btn) + 1).padStart(2, "0")}` : "Index";
  document.getElementById("panelEyebrow").replaceChildren(number, ` · ${btn ? group : "Everything you can see"}`);
  // Screen readers announce the tab you're on as the current page.
  for (const b of document.querySelectorAll("nav.nav button")) {
    if (b.dataset.panel === panel) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
}

for (const btn of document.querySelectorAll("nav.nav button")) {
  btn.addEventListener("click", () => {
    const panel = btn.dataset.panel;
    // An error belongs to the panel it happened on. Left up, Accounts'
    // "username must not be empty" sat on top of the Import panel too.
    showError("");
    for (const b of document.querySelectorAll("nav.nav button")) b.classList.toggle("active", b === btn);
    for (const s of document.querySelectorAll("section.panel")) s.classList.toggle("active", s.id === `panel-${panel}`);
    setPanelHeading(panel);
    if (["messages", "staff-schedule", "drafting", "billing", "research", "cases", "signatures", "scheduling", "conflicts", "trust", "invoices", "payroll"].includes(panel)) {
      refreshPickers();
    }
    if (panel === "home") loadHome();
    if (panel === "security") {
      loadMfaStatus();
      loadPasskeys();
      loadCalendarConnectionStatus();
    }
    if (panel === "scheduling") {
      loadAppointments();
      loadDueReminders();
      loadBookingRequests();
    }
    if (panel === "signatures" && signaturesMatterId().trim() && capabilities?.esignature !== false) {
      loadSignatureSources();
      loadSignatures();
    }
  });
}

/* ===== Command palette =====
   With 20+ panels behind a sidebar (a horizontally-scrolling bar on
   mobile), clicking there every time is slower than typing a few
   letters. Cmd/Ctrl+K opens this over whatever panel is showing;
   Escape or a click on the backdrop closes it without navigating.
   Built from the *visible* nav buttons at open time rather than a
   static list, so it automatically matches whatever a role can
   currently reach — a client account still only sees My Matters and
   Security, same as the sidebar itself. */
let paletteAllItems = [];
let paletteFiltered = [];
let paletteActiveIndex = 0;
let paletteLastFocused = null;

function buildPaletteItems() {
  const items = [];
  let currentGroup = "";
  for (const el of document.querySelectorAll("nav.nav > *")) {
    if (el.classList.contains("nav-group")) {
      if (!el.hidden) currentGroup = el.textContent.trim();
      continue;
    }
    if (el.tagName === "BUTTON" && !el.hidden) {
      items.push({ label: el.textContent.trim(), group: currentGroup, action: () => el.click() });
    }
  }
  items.push({ label: "Toggle light/dark theme", group: "Account", action: () => document.getElementById("themeToggle").click() });
  items.push({ label: "Change password", group: "Account", action: () => document.getElementById("changePasswordBtn").click() });
  items.push({ label: "Log out", group: "Account", action: () => document.getElementById("logout").click() });
  return items;
}

function filterPaletteItems(query) {
  const q = query.trim().toLowerCase();
  if (!q) return paletteAllItems;
  return paletteAllItems.filter((item) => item.label.toLowerCase().includes(q) || item.group.toLowerCase().includes(q));
}

function renderPaletteResults() {
  const list = document.getElementById("paletteResults");
  list.innerHTML = "";
  if (paletteFiltered.length === 0) {
    list.innerHTML = '<li class="palette-empty">No matching panel.</li>';
    return;
  }
  paletteFiltered.forEach((item, i) => {
    const li = document.createElement("li");
    li.className = i === paletteActiveIndex ? "active" : "";
    li.innerHTML = `<span>${escapeHtml(item.label)}</span>${item.group ? `<span class="palette-group">${escapeHtml(item.group)}</span>` : ""}`;
    li.addEventListener("mouseenter", () => {
      paletteActiveIndex = i;
      renderPaletteResults();
    });
    li.addEventListener("click", () => activatePaletteItem(i));
    list.appendChild(li);
  });
}

function activatePaletteItem(i) {
  const item = paletteFiltered[i];
  if (!item) return;
  closePalette();
  item.action();
}

function openPalette() {
  paletteLastFocused = document.activeElement;
  paletteAllItems = buildPaletteItems();
  paletteFiltered = paletteAllItems;
  paletteActiveIndex = 0;
  document.getElementById("paletteInput").value = "";
  renderPaletteResults();
  document.getElementById("commandPalette").classList.remove("hidden");
  document.getElementById("paletteInput").focus();
}

function closePalette() {
  document.getElementById("commandPalette").classList.add("hidden");
  if (paletteLastFocused && typeof paletteLastFocused.focus === "function") paletteLastFocused.focus();
}

document.getElementById("paletteTriggerKey").textContent = navigator.platform.toUpperCase().includes("MAC") ? "⌘K" : "Ctrl K";
document.getElementById("paletteTrigger").addEventListener("click", openPalette);
document.getElementById("commandPalette").addEventListener("click", (e) => {
  if (e.target.id === "commandPalette") closePalette();
});
document.getElementById("paletteInput").addEventListener("input", (e) => {
  paletteFiltered = filterPaletteItems(e.target.value);
  paletteActiveIndex = 0;
  renderPaletteResults();
});
document.getElementById("paletteInput").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    paletteActiveIndex = Math.min(paletteActiveIndex + 1, paletteFiltered.length - 1);
    renderPaletteResults();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    paletteActiveIndex = Math.max(paletteActiveIndex - 1, 0);
    renderPaletteResults();
  } else if (e.key === "Enter") {
    e.preventDefault();
    activatePaletteItem(paletteActiveIndex);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closePalette();
  }
});
document.addEventListener("keydown", (e) => {
  const modifierPressed = navigator.platform.toUpperCase().includes("MAC") ? e.metaKey : e.ctrlKey;
  if (modifierPressed && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (document.getElementById("commandPalette").classList.contains("hidden")) openPalette();
    else closePalette();
  } else if (e.key === "Escape" && !document.getElementById("commandPalette").classList.contains("hidden")) {
    closePalette();
  }
});

async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options && options.headers) },
  });
  if (res.status === 401) {
    window.location.href = "/login.html";
    throw new Error("authentication required");
  }
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

function showError(message) {
  document.getElementById("error").textContent = message || "";
}

const TOAST_DEFAULT_MS = 4000;

/**
 * Success/info/error feedback for actions that used to be silent — the
 * list re-rendering was the only sign anything happened, easy to miss.
 * Deliberately separate from showError()/#error: that banner is for
 * request-blocking failures the user needs to read before continuing,
 * this is a passing confirmation that clears itself.
 */
function showToast(message, kind) {
  if (!message) return;
  const container = document.getElementById("toasts");
  const toast = document.createElement("div");
  toast.className = `toast ${kind || "success"}`;
  const msg = document.createElement("span");
  msg.className = "msg";
  msg.textContent = message;
  const close = document.createElement("button");
  close.className = "close";
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  const dismiss = () => {
    toast.classList.add("leaving");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
  };
  close.addEventListener("click", dismiss);
  toast.append(msg, close);
  container.append(toast);
  setTimeout(dismiss, TOAST_DEFAULT_MS);
}

let currentRole = null;
let currentActorId = null;
/** Whether the server has text-to-speech configured (SPEECH_TOOLS) — see canUseSpeechTools. */
let speechAvailable = false;
/**
 * Which optional features this server was started with (GET
 * /api/capabilities), or null if that couldn't be read — in which case
 * every panel behaves exactly as it did before the probe existed. Only
 * ever used to *explain* a missing feature up front; the server still
 * refuses anything it isn't configured for.
 */
let capabilities = null;

/**
 * What each optional feature needs, written for whoever reads it: the
 * person at the desk wants to know it isn't them, and whoever runs
 * Docket wants the setting that turns it on.
 */
const UNCONFIGURED = {
  assistant: {
    panel: "assistant",
    title: "The assistant isn't set up on this server",
    body: "It needs an Anthropic API key. Whoever runs Docket for the firm turns it on by setting <code>ANTHROPIC_API_KEY</code> and restarting — until then nothing typed here goes anywhere.",
  },
  esignature: {
    panel: "signatures",
    title: "E-signature isn't set up on this server",
    body: "Signing links have to work from outside the office, so Docket needs the address people reach it at. Whoever runs Docket turns this on by setting <code>PUBLIC_BASE_URL</code> and restarting. Email is optional: without it, each signer's link is shown here for you to send.",
  },
};

/** Puts a "not set up here" note at the top of a panel and disables its controls. */
function markUnconfigured(feature) {
  const info = UNCONFIGURED[feature];
  const panel = document.getElementById(`panel-${info.panel}`);
  if (!panel || panel.querySelector(".unconfigured")) return;
  const note = document.createElement("div");
  note.className = "card unconfigured";
  note.setAttribute("role", "note");
  note.innerHTML = `<h3>${escapeHtml(info.title)}</h3><p>${info.body}</p>`;
  panel.querySelector(".subtitle")?.after(note);
  for (const el of panel.querySelectorAll(".card:not(.unconfigured) :is(button, input, select, textarea)")) el.disabled = true;
}

async function loadCapabilities() {
  if (currentRole !== "attorney" && currentRole !== "paralegal" && currentRole !== "receptionist") return;
  capabilities = await tryApi("/api/capabilities");
  if (!capabilities) return;
  for (const feature of Object.keys(UNCONFIGURED)) {
    if (capabilities[feature] === false) markUnconfigured(feature);
  }
}

async function loadWhoami() {
  try {
    const me = await api("/api/me");
    currentRole = me.role;
    currentActorId = me.id;
    // Best-effort: absent or failing, Listen buttons simply stay hidden.
    api("/api/speech/status")
      .then((status) => {
        speechAvailable = status.available === true;
        updateVoiceStatus();
      })
      .catch(() => {});
    document.getElementById("whoami").textContent = `Signed in as ${me.username || me.id} (${me.role})`;
    const name = me.username || me.id;
    document.getElementById("sidebarUserAvatar").textContent = name.slice(0, 2).toUpperCase();
    document.getElementById("sidebarUserName").textContent = name;
    document.getElementById("sidebarUserRole").textContent = me.role;
    document.getElementById("sidebarUser").hidden = false;
    if (me.mustChangePassword) {
      showError("An attorney reset your password — please change it (top right) to one only you know.");
    }
    document.getElementById("mfaSetupBanner").hidden = !me.mfaSetupRequired;
    if (me.role === "client") {
      // A client sees only its own matters plus its own login security —
      // everything else here is a firm-internal surface (staff directory,
      // messaging, scheduling, billing internals) that a client account
      // has no server-side access to anyway; hiding the nav for it is
      // just not showing doors that would all 403.
      for (const btn of document.querySelectorAll("nav.nav button")) {
        if (btn.id !== "navMyMatters" && btn.dataset.panel !== "security") btn.hidden = true;
      }
      // The group labels are just headings over those buttons — hide them
      // too, or a client sees "Casework"/"Team"/etc. sitting over nothing.
      for (const label of document.querySelectorAll("nav.nav .nav-group")) label.hidden = true;
      document.getElementById("navMyMatters").hidden = false;
      document.getElementById("navMyMatters").click();
      const returnedMatterId = handleInvoiceCheckoutRedirect();
      if (returnedMatterId) {
        await openMyMatter(returnedMatterId);
      } else {
        loadMyMatters();
      }
      return;
    }
    // Live Intake trains the roles that run intake. The server refuses
    // anyone else before a call starts (its conflicts screen would answer
    // "does the firm know this name?"), so don't offer a door that 403s.
    if (me.role !== "receptionist" && me.role !== "attorney") {
      document.querySelector('nav.nav button[data-panel="intake"]').hidden = true;
    }
    if (me.role === "attorney") {
      document.getElementById("navAccounts").hidden = false;
      document.getElementById("navAudit").hidden = false;
      document.getElementById("navAnalytics").hidden = false;
      document.getElementById("navImport").hidden = false;
      document.getElementById("conflictAuditCard").hidden = false;
    }
    if (me.role === "attorney" || me.role === "paralegal") {
      document.getElementById("globalSearch").hidden = false;
      document.getElementById("navDrafting").hidden = false;
      document.getElementById("navCases").hidden = false;
      document.getElementById("navSignatures").hidden = false;
      document.getElementById("navConflicts").hidden = false;
      document.getElementById("navResearch").hidden = false;
      document.getElementById("navAssistant").hidden = false;
      document.getElementById("navBilling").hidden = false;
      document.getElementById("navTrust").hidden = false;
      document.getElementById("navInvoices").hidden = false;
      document.getElementById("navGroupFinance").hidden = false;
    }
    // Review Queue and Deadlines are attorney-only server-side (ReviewGateService gates
    // every method, including reads) — only fetch them once we know the role, and only
    // for an attorney, so a paralegal/receptionist session doesn't 403 on page load.
    if (me.role === "attorney") {
      loadQueue();
      loadConflicts();
      loadUpcomingDeadlines();
    } else {
      renderAttorneyOnly("queue", "Review Queue is attorney-only.");
      renderAttorneyOnly("conflictList", "Deadlines are attorney-only.");
    }
    await loadCapabilities();
    // Pickers first: Home greets you by display name, which comes from the
    // staff directory those pickers load.
    await refreshPeoplePickers();
    refreshMatterOptions();
    loadHome();
    loadIntakeScenarios();

    if (window.location.search.includes("calendar")) {
      handleCalendarConnectionRedirect();
      document.querySelector('nav.nav button[data-panel="security"]')?.click();
    }
  } catch (err) {
    // api() already redirects to /login.html on 401.
  }
}

const DEADLINE_TYPE_LABEL = {
  speedy_trial: "speedy trial",
  arraignment: "arraignment",
  bail_hearing: "bail hearing",
  discovery_response: "discovery response",
  other: "deadline",
};

/** One row of the coming-due list, shared by the Deadlines panel and Home. */
function deadlineRowHtml(d) {
  const when = d.overdue
    ? `<span class="badge rejected">${Math.abs(d.daysAway)} day${Math.abs(d.daysAway) === 1 ? "" : "s"} overdue</span>`
    : d.daysAway === 0
      ? '<span class="badge rejected">due today</span>'
      : `<span class="badge ${d.daysAway <= 3 ? "rejected" : "pending_review"}">in ${d.daysAway} day${d.daysAway === 1 ? "" : "s"}</span>`;
  // The verification state is the point of the list, so it's never
  // omitted — a confirmed deadline says so as loudly as an unverified one.
  const state =
    d.confirmationState === "confirmed"
      ? '<span class="badge approved">confirmed by two sources</span>'
      : d.confirmationState === "conflict"
        ? '<span class="badge rejected">sources disagree</span>'
        : '<span class="badge pending_review">only one source — not verified</span>';
  return `<strong>${escapeHtml(DEADLINE_TYPE_LABEL[d.type] || d.type)}</strong>
    <span class="badge">${escapeHtml(d.matterId)}</span> ${when} ${state}
    <div class="meta-tight">${escapeHtml(d.date)}${
      d.confirmationState === "conflict"
        ? ` · proposed ${escapeHtml([...new Set(d.calculations.map((c) => c.date))].join(" and "))}`
        : ` · from ${escapeHtml([...new Set(d.calculations.map((c) => c.source))].join(", "))}`
    }</div>`;
}

// Kept around so "Download CSV" exports the same risk-ranked list
// currently on screen, at the same horizon, without a second fetch.
let lastUpcomingDeadlines = [];

async function loadUpcomingDeadlines() {
  const list = document.getElementById("upcomingList");
  if (currentRole && currentRole !== "attorney") {
    renderAttorneyOnly("upcomingList", "Deadlines are attorney-only.");
    return;
  }
  try {
    const withinDays = Number(document.getElementById("deadlineHorizon").value) || 14;
    const due = await api(`/api/deadlines/upcoming?withinDays=${withinDays}`);
    lastUpcomingDeadlines = due;
    list.innerHTML = "";
    for (const d of due) list.appendChild(listRow(deadlineRowHtml(d)));
    if (due.length === 0) {
      list.innerHTML = emptyHero(
        ICON_CHECK,
        `Nothing due in the next ${withinDays} days`,
        "Deadlines only appear here once someone has recorded one.",
        { ok: true },
      );
    }
  } catch (err) {
    showError(err.message);
  }
}

function renderAttorneyOnly(listId, message) {
  document.getElementById(listId).innerHTML = `<li class="static empty">${message}</li>`;
}

document.getElementById("themeToggle").addEventListener("click", () => {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  try {
    localStorage.setItem("theme", next);
  } catch {
    // Private browsing / blocked storage — the toggle still works for
    // this page view, it just won't be remembered next time.
  }
  applyTheme(next);
});

document.getElementById("logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
  window.location.href = "/login.html";
});

document.getElementById("changePasswordBtn").addEventListener("click", async () => {
  showError("");
  const currentPassword = prompt("Current password?");
  if (!currentPassword) return;
  const newPassword = prompt("New password (8+ characters)?");
  if (!newPassword) return;
  try {
    await api("/api/change-password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
    alert("Password changed — please log in again.");
    window.location.href = "/login.html";
  } catch (err) {
    showError(err.message);
  }
});

/* ===== Security panel: your own second factor =====
   Every route here acts on the caller's own account and takes no user
   id — enrolling a second factor onto someone else's account would be a
   way to lock them out of it. Turning one off for someone else is an
   attorney action, and lives in the Accounts panel where the rest of the
   overrides are. */
function showMfaSection(id) {
  for (const section of ["mfaOff", "mfaEnrolling", "mfaOn"]) {
    document.getElementById(section).hidden = section !== id;
  }
}

async function loadMfaStatus() {
  try {
    const status = await api("/api/mfa");
    const badge = document.getElementById("mfaStatusBadge");
    badge.textContent = status.enabled ? "on" : "off";
    badge.className = `badge ${status.enabled ? "approved" : "draft"}`;
    document.getElementById("mfaCodesRemaining").textContent = status.recoveryCodesRemaining;
    showMfaSection(status.enabled ? "mfaOn" : "mfaOff");
  } catch (err) {
    showError(err.message);
  }
}

function showRecoveryCodes(codes) {
  document.getElementById("mfaCodes").textContent = codes.join("\n");
  document.getElementById("mfaCodesCard").hidden = false;
}

/* ===== Passkeys (WebAuthn) =====
   navigator.credentials.create()/.get() speak ArrayBuffers; the server
   speaks base64url strings (so options/responses survive a JSON round
   trip). These two helpers are the entire translation layer — no
   @simplewebauthn/browser or any other client library, consistent with
   this app having no bundler and a CSP that only loads scripts from
   'self': there's nowhere to load a CDN script from even if we wanted
   one, and the translation itself is base64url encode/decode, not
   cryptography. */
function base64urlToBuffer(base64url) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "===".slice((base64.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bufferToBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function performPasskeyRegistration(optionsJSON) {
  const publicKey = {
    ...optionsJSON,
    challenge: base64urlToBuffer(optionsJSON.challenge),
    user: { ...optionsJSON.user, id: base64urlToBuffer(optionsJSON.user.id) },
    excludeCredentials: (optionsJSON.excludeCredentials || []).map((c) => ({ ...c, id: base64urlToBuffer(c.id) })),
  };
  const credential = await navigator.credentials.create({ publicKey });
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
      attestationObject: bufferToBase64url(credential.response.attestationObject),
      transports: credential.response.getTransports ? credential.response.getTransports() : [],
    },
    clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
  };
}

/** Loaded only when the Security panel opens — see `loadPasskeys()`'s own feature-detection guard for why this card can be entirely absent. */
async function loadPasskeys() {
  const card = document.getElementById("passkeysCard");
  if (!window.PublicKeyCredential) {
    card.hidden = true;
    return;
  }
  try {
    const passkeys = await api("/api/webauthn");
    card.hidden = false;
    const list = document.getElementById("passkeysList");
    list.innerHTML = "";
    for (const p of passkeys) {
      const li = document.createElement("li");
      li.classList.add("static");
      li.innerHTML = `<strong>${escapeHtml(p.nickname)}</strong>
        <span class="meta-xs">added ${new Date(p.createdAt).toLocaleDateString()}</span>`;
      const removeBtn = mkButton("Remove", async () => {
        showError("");
        const password = prompt("Confirm your password to remove this passkey.");
        if (!password) return;
        try {
          await api(`/api/webauthn/${encodeURIComponent(p.id)}`, { method: "DELETE", body: JSON.stringify({ password }) });
          await loadPasskeys();
          showToast("Passkey removed.", "success");
        } catch (err) {
          showError(err.message);
        }
      });
      removeBtn.classList.add("danger");
      li.appendChild(document.createElement("br"));
      li.appendChild(removeBtn);
      list.appendChild(li);
    }
    if (passkeys.length === 0) list.innerHTML = '<li class="static empty">No passkeys added yet.</li>';
  } catch {
    // Not configured on this server, or not reachable — same "the
    // surface doesn't exist here" treatment as the calendar card.
    card.hidden = true;
  }
}

document.getElementById("passkeyAddBtn").addEventListener("click", async () => {
  showError("");
  const password = prompt("Confirm your password to add a passkey.");
  if (!password) return;
  try {
    const options = await api("/api/webauthn/register/begin", { method: "POST", body: JSON.stringify({ password }) });
    const response = await performPasskeyRegistration(options);
    const nickname = document.getElementById("passkeyNickname").value.trim();
    await api("/api/webauthn/register/complete", { method: "POST", body: JSON.stringify({ response, nickname }) });
    document.getElementById("passkeyNickname").value = "";
    await loadPasskeys();
    showToast("Passkey added.", "success");
  } catch (err) {
    showError(err.name === "NotAllowedError" ? "Passkey setup was cancelled." : err.message);
  }
});

/**
 * Hidden entirely (not just a blank state) when the server has no
 * calendarConnection configured at all — same "the feature doesn't
 * exist here" treatment as every other optional panel, rather than
 * showing a card with buttons that would just 404.
 */
async function loadCalendarConnectionStatus() {
  const card = document.getElementById("calendarConnectionCard");
  if (capabilities && capabilities.calendarConnection === false) {
    card.hidden = true;
    return;
  }
  const status = await tryApi("/api/calendar-connection");
  if (!status) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const badge = document.getElementById("calendarStatusBadge");
  badge.textContent = status.connected ? `connected${status.connectedEmail ? ` — ${status.connectedEmail}` : ""}` : "not connected";
  badge.className = `badge ${status.connected ? "approved" : "draft"}`;
  document.getElementById("calendarConnectBtn").hidden = status.connected;
  document.getElementById("calendarDisconnectBtn").hidden = !status.connected;
}

document.getElementById("calendarConnectBtn").addEventListener("click", async () => {
  showError("");
  try {
    const { authUrl } = await api("/api/calendar-connection/begin", { method: "POST", body: "{}" });
    // A full top-level navigation, not a fetch — the consent screen is
    // Google's own page, and the flow finishes by Google redirecting
    // the browser back to this app, not by a response this script reads.
    window.location.href = authUrl;
  } catch (err) {
    showError(err.message);
  }
});

document.getElementById("calendarDisconnectBtn").addEventListener("click", async () => {
  showError("");
  if (!confirm("Disconnect your Google Calendar? Your appointments will stop syncing to it.")) return;
  try {
    await api("/api/calendar-connection/disconnect", { method: "POST", body: "{}" });
    await loadCalendarConnectionStatus();
    showToast("Google Calendar disconnected.", "success");
  } catch (err) {
    showError(err.message);
  }
});

/**
 * Picks up where the OAuth flow leaves off: Google redirects the
 * browser to `/api/calendar-connection/callback`, which redirects here
 * with a query param rather than a JSON body (see server.ts — it's a
 * top-level navigation, Google's own page did the redirecting, not
 * this script). Runs once, on load, then strips the param so a reload
 * doesn't show the toast again.
 */
function handleCalendarConnectionRedirect() {
  const params = new URLSearchParams(window.location.search);
  const connected = params.get("calendarConnected");
  const error = params.get("calendarError");
  if (!connected && !error) return;
  history.replaceState(null, "", window.location.pathname);
  if (connected) {
    showToast("Google Calendar connected.", "success");
  } else {
    showToast(`Couldn't connect Google Calendar: ${error}`, "error");
  }
}

/** Landing back from Stripe's hosted Checkout page — see createCheckoutSession's success/cancel URLs. */
function handleInvoiceCheckoutRedirect() {
  const params = new URLSearchParams(window.location.search);
  const paid = params.get("invoicePaid");
  const cancelled = params.get("invoicePaymentCancelled");
  const matterId = params.get("matterId");
  if (!paid && !cancelled) return null;
  history.replaceState(null, "", window.location.pathname);
  if (paid) {
    // Stripe's webhook records the payment asynchronously — it's usually
    // already landed by the time the browser redirects back, but not
    // guaranteed, so this doesn't claim the balance is updated yet.
    showToast("Payment received — this may take a moment to reflect on the invoice.", "success");
  } else {
    showToast("Payment cancelled — nothing was charged.", "notice");
  }
  return matterId;
}

document.getElementById("mfaSetupBannerBtn").addEventListener("click", () => {
  document.querySelector('nav.nav button[data-panel="security"]').click();
});

document.getElementById("mfaBeginBtn").addEventListener("click", async () => {
  showError("");
  const password = prompt("Confirm your password to set up two-factor authentication.");
  if (!password) return;
  try {
    const { secret, uri } = await api("/api/mfa/begin", { method: "POST", body: JSON.stringify({ password }) });
    document.getElementById("mfaSecret").textContent = secret.replace(/(.{4})/g, "$1 ").trim();
    const link = document.getElementById("mfaUri");
    link.href = uri;
    link.textContent = uri;
    showMfaSection("mfaEnrolling");
    document.getElementById("mfaConfirmCode").focus();
  } catch (err) {
    showError(err.message);
  }
});

document.getElementById("mfaCancelBtn").addEventListener("click", () => {
  // Nothing to undo server-side: a pending secret gates nothing, and the
  // next "Set up" simply replaces it.
  document.getElementById("mfaConfirmCode").value = "";
  showMfaSection("mfaOff");
});

document.getElementById("mfaConfirmBtn").addEventListener("click", async () => {
  showError("");
  const code = document.getElementById("mfaConfirmCode").value.trim();
  if (!code) return;
  try {
    const { recoveryCodes } = await api("/api/mfa/confirm", { method: "POST", body: JSON.stringify({ code }) });
    document.getElementById("mfaConfirmCode").value = "";
    showRecoveryCodes(recoveryCodes);
    await loadMfaStatus();
    // Clears the firm-policy banner immediately, without waiting for the
    // next full page load, if this enrollment is what it was waiting on.
    document.getElementById("mfaSetupBanner").hidden = true;
    showToast("Two-factor authentication enabled.", "success");
  } catch (err) {
    showError(err.message);
  }
});

document.getElementById("mfaRegenerateBtn").addEventListener("click", async () => {
  showError("");
  const password = prompt("Confirm your password to issue new recovery codes. The old ones stop working.");
  if (!password) return;
  try {
    const { recoveryCodes } = await api("/api/mfa/recovery-codes", { method: "POST", body: JSON.stringify({ password }) });
    showRecoveryCodes(recoveryCodes);
    await loadMfaStatus();
    showToast("New recovery codes issued — the old ones no longer work.", "success");
  } catch (err) {
    showError(err.message);
  }
});

document.getElementById("mfaDisableBtn").addEventListener("click", async () => {
  showError("");
  const password = prompt("Confirm your password to turn off two-factor authentication.");
  if (!password) return;
  try {
    await api("/api/mfa/disable", { method: "POST", body: JSON.stringify({ password }) });
    // Disabling revokes every session, this one included.
    alert("Two-factor authentication is off. Please log in again.");
    window.location.href = "/login.html";
  } catch (err) {
    showError(err.message);
  }
});

document.getElementById("mfaCodesDoneBtn").addEventListener("click", () => {
  document.getElementById("mfaCodesCard").hidden = true;
  document.getElementById("mfaCodes").textContent = "";
});

/* ===== My Matters (client role) =====
   Read-only end to end — there is no upload, edit, or pay-online button
   anywhere in this panel. See client-portal-service.ts's doc comment for
   why: everything here is a hand-picked, client-safe projection of data
   that lives fully behind staff's own gated panels. */
async function loadMyMatters() {
  showError("");
  const list = document.getElementById("myMattersList");
  list.innerHTML = "";
  document.getElementById("myMatterDetail").innerHTML = "";
  try {
    const matters = await api("/api/client-portal/matters");
    for (const m of matters) {
      const li = document.createElement("li");
      li.innerHTML = `<strong>${escapeHtml(m.title)}</strong> <span class="badge">${escapeHtml(m.status)}</span> <span class="meta-xs">${escapeHtml(m.matterId)}</span>`;
      li.addEventListener("click", () => openMyMatter(m.matterId));
      list.appendChild(li);
    }
    if (matters.length === 0) {
      list.innerHTML = emptyHero(
        ICON_TRAY,
        "Nothing on file yet",
        "If you were expecting to see a matter here, ask the firm to grant portal access.",
      );
    } else if (matters.length === 1) {
      // The common case — a client with one matter shouldn't have to click through to it.
      openMyMatter(matters[0].matterId);
    }
  } catch (err) {
    showError(err.message);
  }
}

/* ===== Client/firm message thread — shared by the client's My Matters
   panel and staff's Cases panel, since both read and write the same
   thread through the same /api/client-messages route. */
function renderMessageThread(messages) {
  if (messages.length === 0) return '<li class="static empty">No messages yet.</li>';
  return messages
    .map(
      (m) => `<li class="static">
        <span class="badge">${escapeHtml(m.authorRole)}</span>
        <span class="meta-xs">${new Date(m.sentAt).toLocaleString()}</span>
        <div class="mt-xs">${escapeHtml(m.body)}</div>
      </li>`,
    )
    .join("");
}

async function loadMessageThread(matterId, listElementId) {
  try {
    const messages = await api(`/api/client-messages/matters/${encodeURIComponent(matterId)}`);
    document.getElementById(listElementId).innerHTML = renderMessageThread(messages);
  } catch (err) {
    // Not every role reaches this thread (e.g. no grant yet) — the card
    // just shows nothing rather than an error breaking the rest of the panel.
    document.getElementById(listElementId).innerHTML = '<li class="static empty">No messages yet.</li>';
  }
}

async function sendMessage(matterId, inputId, listElementId) {
  showError("");
  const input = document.getElementById(inputId);
  const body = input.value.trim();
  if (!body) return;
  try {
    await api(`/api/client-messages/matters/${encodeURIComponent(matterId)}`, { method: "POST", body: JSON.stringify({ body }) });
    input.value = "";
    await loadMessageThread(matterId, listElementId);
  } catch (err) {
    showError(err.message);
  }
}

async function openMyMatter(matterId) {
  showError("");
  const el = document.getElementById("myMatterDetail");
  el.innerHTML = "<p>Loading…</p>";
  try {
    const detail = await api(`/api/client-portal/matters/${encodeURIComponent(matterId)}`);
    const invoiceRows = (detail.invoices || [])
      .map((inv) => {
        const statusBadge =
          inv.status === "paid" ? "approved" : inv.status === "void" ? "rejected" : inv.status === "sent" ? "pending_review" : "";
        const balanceDue = inv.totals.balanceCents > 0 && (inv.status === "sent" || inv.status === "partially_paid");
        return `<li class="static">
          <strong>Invoice ${escapeHtml(inv.number)}</strong>
          <span class="badge ${statusBadge}">${escapeHtml(inv.status)}</span>
          <span class="meta-xs">balance ${escapeHtml(centsToDollars(inv.totals.balanceCents))} of ${escapeHtml(centsToDollars(inv.totals.subtotalCents))}</span>
          <div class="mt-xs">
            <button class="btn" data-preview="${inv.id}">View itemization</button>
            <a class="btn" href="/api/client-portal/matters/${encodeURIComponent(matterId)}/invoices/${inv.id}/pdf">Download PDF</a>
            ${balanceDue ? `<button class="btn primary" data-pay="${inv.id}">Pay now</button>` : ""}
          </div>
          <pre class="preview hidden mono mt-sm" id="clientInvoicePreview-${inv.id}"></pre>
        </li>`;
      })
      .join("");

    const documentRows = (detail.documents || [])
      .map(
        (doc) => `<li class="static">
          <strong>${escapeHtml(doc.fileName)}</strong>
          <span class="badge">${formatBytes(doc.size)}</span>
          <div class="meta-xs">Shared ${new Date(doc.uploadedAt).toLocaleDateString()}</div>
          <a class="btn mt-xs" href="/api/client-portal/matters/${encodeURIComponent(matterId)}/documents/${doc.id}">Download</a>
        </li>`,
      )
      .join("");

    el.innerHTML = `
      <div class="card">
        <h3>${escapeHtml(detail.title)} <span class="badge">${escapeHtml(detail.status)}</span></h3>
        ${
          detail.trustBalanceCents !== undefined
            ? `<p class="subtitle-inline">Funds held in trust for this matter: <strong>${escapeHtml(centsToDollars(detail.trustBalanceCents))}</strong></p>`
            : ""
        }
        ${
          detail.paymentInstructions
            ? `<p class="subtitle-inline">${escapeHtml(detail.paymentInstructions)}</p>`
            : ""
        }
      </div>
      <div class="card">
        <h3>Invoices</h3>
        <ul class="list">${invoiceRows || '<li class="static empty">No invoices issued yet.</li>'}</ul>
      </div>
      <div class="card">
        <h3>Documents shared with you</h3>
        <ul class="list">${documentRows || '<li class="static empty">Nothing has been shared with you yet.</li>'}</ul>
        <div class="field-row mt-sm">
          <label class="field grow">Send a document to the firm <input id="clientUploadFile" type="file" /></label>
          <button class="btn primary" id="clientUploadBtn">Upload</button>
        </div>
        <p class="meta-xs" id="clientUploadLimitNote"></p>
      </div>
      <div class="card">
        <h3>Messages</h3>
        <p class="subtitle-inline">A message thread with the firm about this matter — not a substitute for calling about anything urgent.</p>
        <ul id="clientMessageThread" class="list"></ul>
        <div class="field-row mt-sm">
          <label class="field grow">Send a message <input id="clientMessageBody" type="text" maxlength="10000" placeholder="Type a message…" /></label>
          <button class="btn primary" id="clientMessageSend">Send</button>
        </div>
      </div>`;

    await loadMessageThread(matterId, "clientMessageThread");
    document.getElementById("clientMessageSend").addEventListener("click", () =>
      sendMessage(matterId, "clientMessageBody", "clientMessageThread"),
    );
    document.getElementById("clientMessageBody").addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendMessage(matterId, "clientMessageBody", "clientMessageThread");
    });

    for (const btn of el.querySelectorAll("[data-preview]")) {
      btn.addEventListener("click", async () => {
        showError("");
        const invoiceId = btn.dataset.preview;
        const pre = document.getElementById(`clientInvoicePreview-${invoiceId}`);
        try {
          if (!pre.textContent) {
            const rendered = await api(`/api/client-portal/matters/${encodeURIComponent(matterId)}/invoices/${invoiceId}/preview`);
            pre.textContent = rendered.text;
          }
          pre.classList.toggle("hidden");
        } catch (err) {
          showError(err.message);
        }
      });
    }

    for (const btn of el.querySelectorAll("[data-pay]")) {
      btn.addEventListener("click", async () => {
        showError("");
        const invoiceId = btn.dataset.pay;
        try {
          btn.disabled = true;
          const { url } = await api(`/api/client-portal/matters/${encodeURIComponent(matterId)}/invoices/${invoiceId}/checkout-session`, {
            method: "POST",
            body: "{}",
          });
          // A real redirect to Stripe's own hosted page, same reasoning as
          // the Google Calendar connect button — this is not an API call
          // that returns inline, it's a full navigation to a third party.
          window.location.href = url;
        } catch (err) {
          showError(err.message.includes("not configured") ? "Online payment isn't set up for this firm yet — see the payment instructions above." : err.message);
          btn.disabled = false;
        }
      });
    }

    api("/api/client-portal/limits")
      .then((limits) => {
        document.getElementById("clientUploadLimitNote").textContent = `Max upload size: ${formatBytes(limits.maxUploadBytes)} per file.`;
      })
      .catch(() => {});

    document.getElementById("clientUploadBtn").addEventListener("click", async () => {
      showError("");
      try {
        const fileInput = document.getElementById("clientUploadFile");
        const file = fileInput.files[0];
        if (!file) throw new Error("choose a file first");
        const content = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(",")[1] || "");
          reader.onerror = () => reject(new Error("could not read file"));
          reader.readAsDataURL(file);
        });
        await api(`/api/client-portal/matters/${encodeURIComponent(matterId)}/documents`, {
          method: "POST",
          body: JSON.stringify({ fileName: file.name, contentType: file.type, content }),
        });
        await openMyMatter(matterId);
        showToast("Document sent to the firm.", "success");
      } catch (err) {
        showError(err.message);
      }
    });
  } catch (err) {
    showError(err.message);
    el.innerHTML = "";
  }
}

loadWhoami();

/* ===== Shared pickers =====
   Every panel used to ask people to type a raw actorId or matterId from
   memory, which is both unpleasant and easy to get silently wrong (a typo
   in a matterId just creates a different matter). These populate the
   people <select>s and the matter autocomplete list from the same data
   the Staff and Cases panels already serve. Matter fields stay free-text
   on purpose — a matter comes into existence the first time someone uses
   its id, so the list is a convenience, never a restriction. */
let knownStaff = [];

function fillPeopleSelect(el, { includeSelf = true, selfActorId = null } = {}) {
  if (!el) return;
  const previous = el.value;
  el.innerHTML = "";
  for (const m of knownStaff) {
    if (!includeSelf && m.actorId === selfActorId) continue;
    // The directory lists client portal accounts too (the audit log's
    // filter needs them); messaging, the staff schedule and "responsible
    // attorney" are for staff, and the server refuses a client there.
    if (m.role === "client") continue;
    const opt = document.createElement("option");
    opt.value = m.actorId;
    opt.textContent = `${m.displayName} (${m.role})`;
    el.appendChild(opt);
  }
  if (previous && knownStaff.some((m) => m.actorId === previous)) el.value = previous;
}

// Responsible attorney is optional, unlike every other person-picker —
// a freshly opened matter has no attorney assigned yet — so it keeps a
// leading "(unassigned)" option fillPeopleSelect's fresh-render would
// otherwise wipe out.
function fillMatterResponsibleAttorneySelect() {
  const el = document.getElementById("matterResponsibleAttorney");
  if (!el) return;
  const previous = el.value;
  fillPeopleSelect(el);
  const unassigned = document.createElement("option");
  unassigned.value = "";
  unassigned.textContent = "(unassigned)";
  el.insertBefore(unassigned, el.firstChild);
  el.value = previous && knownStaff.some((m) => m.actorId === previous) ? previous : "";
}

// Booking used to have no attorney field at all, so a firm without an
// attorney list in its firm config couldn't book a consultation from this
// panel: every attempt ended in "no attorney available". The first option
// keeps the firm-settings auto-assignment; an attorney booking defaults
// to themselves.
function fillAppointmentAttorneySelect() {
  const el = document.getElementById("apptAttorneyId");
  if (!el) return;
  const previous = el.value;
  el.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "Assign from firm settings";
  el.appendChild(auto);
  for (const m of knownStaff) {
    if (m.role !== "attorney" || m.disabled) continue;
    const opt = document.createElement("option");
    opt.value = m.actorId;
    opt.textContent = m.displayName;
    el.appendChild(opt);
  }
  const has = (id) => [...el.options].some((o) => o.value === id);
  el.value = previous && has(previous) ? previous : currentRole === "attorney" && has(currentActorId) ? currentActorId : "";
}

async function refreshPeoplePickers() {
  try {
    knownStaff = await api("/api/staff");
  } catch {
    return; // A picker that can't load shouldn't break the panel around it.
  }
  const me = currentActorId;
  // You can't DM yourself, so leave yourself out of that one.
  fillPeopleSelect(document.getElementById("dmActorId"), { includeSelf: false, selfActorId: me });
  fillPeopleSelect(document.getElementById("groupMembers"), { includeSelf: false, selfActorId: me });
  fillPeopleSelect(document.getElementById("scheduleActorId"));
  fillPeopleSelect(document.getElementById("scheduleViewActorId"));
  fillMatterResponsibleAttorneySelect();
  fillAppointmentAttorneySelect();
  // Default the schedule pickers to yourself — by far the common case.
  for (const id of ["scheduleActorId", "scheduleViewActorId"]) {
    const el = document.getElementById(id);
    if (el && me && knownStaff.some((m) => m.actorId === me)) el.value = me;
  }
}

async function refreshMatterOptions() {
  const list = document.getElementById("matterOptions");
  if (!list) return;
  // Cases is paralegal/attorney-only; asking anyway left a receptionist's
  // console with a 403 on nearly every panel. They just get no suggestions.
  if (currentRole !== "attorney" && currentRole !== "paralegal") return;
  try {
    const cases = await api("/api/cases");
    list.innerHTML = "";
    for (const c of cases) {
      const opt = document.createElement("option");
      opt.value = c.matterId;
      list.appendChild(opt);
    }
  } catch {
    // Cases is paralegal/attorney-only; a receptionist just gets no suggestions.
  }
}

function refreshPickers() {
  refreshPeoplePickers();
  refreshMatterOptions();
}

/* ===== Review Queue ===== */
async function loadQueue() {
  showError("");
  if (currentRole && currentRole !== "attorney") {
    renderAttorneyOnly("queue", "Review Queue is attorney-only.");
    return;
  }
  try {
    const items = await api("/api/work-products?status=pending_review");
    const list = document.getElementById("queue");
    list.innerHTML = "";
    for (const item of items) {
      const li = document.createElement("li");
      li.innerHTML = `<strong>${escapeHtml(item.kind)}</strong> — matter ${escapeHtml(item.matterId)}
        <span class="badge ${item.status}">${item.status}</span>
        ${item.flags.length ? `<div class="flags">Unresolved flags: ${escapeHtml(item.flags.join(", "))}</div>` : ""}`;
      li.addEventListener("click", () => loadDetail(item.id));
      list.appendChild(li);
    }
    if (items.length === 0) {
      list.innerHTML = emptyHero(ICON_CHECK, "All caught up", "Nothing is waiting for your review right now.", { ok: true });
    }
  } catch (err) {
    showError(err.message);
  }
}

async function loadDetail(id) {
  showError("");
  try {
    const wp = await api(`/api/work-products/${id}`);
    const detail = document.getElementById("detail");
    detail.innerHTML = `
      <div class="card">
        <h3>${escapeHtml(wp.kind)} <span class="badge ${wp.status}">${wp.status}</span></h3>
        <p class="subtitle-inline">Matter: ${escapeHtml(wp.matterId)}</p>
        ${wp.flags.length ? `<div class="flags">Unresolved flags: ${wp.flags.map((f) => `<code>${f}</code>`).join(", ")}</div>` : ""}
        <pre>${wp.content}</pre>
        <div class="actions" id="actions"></div>
      </div>
    `;
    const actions = document.getElementById("actions");

    for (const flag of wp.flags) {
      const btn = mkButton(`Clear flag: ${flag}`, () => {
        if (flag === "deadline_requires_redundant_verification") {
          const deadlineType = prompt(
            "Which deadline type does this confirm? (speedy_trial, arraignment, bail_hearing, discovery_response, other)",
          );
          if (!deadlineType) return;
          return act(`/api/work-products/${id}/clear-flag`, { flag, deadlineType }, id);
        }
        return act(`/api/work-products/${id}/clear-flag`, { flag }, id);
      });
      actions.appendChild(btn);
    }

    if (wp.status === "pending_review") {
      const approveBtn = mkButton("Approve", () => act(`/api/work-products/${id}/approve`, {}, id));
      approveBtn.classList.add("primary");
      const rejectBtn = mkButton("Reject", () => {
        const reason = prompt("Reason for rejection?") || "";
        return act(`/api/work-products/${id}/reject`, { reason }, id);
      });
      rejectBtn.classList.add("danger");
      const reviseBtn = mkButton("Request revision", () => {
        const note = prompt("Revision note?") || "";
        return act(`/api/work-products/${id}/request-revision`, { note }, id);
      });
      actions.append(approveBtn, rejectBtn, reviseBtn);
    }
    if (wp.status === "approved") {
      const releaseBtn = mkButton("Release", () => act(`/api/work-products/${id}/release`, {}, id));
      releaseBtn.classList.add("primary");
      actions.appendChild(releaseBtn);
    }
  } catch (err) {
    showError(err.message);
  }
}

/**
 * Escapes quotes as well as angle brackets, so the same helper is correct
 * whether the value lands in element text or inside an attribute value.
 * The textContent/innerHTML trick alone leaves `"` intact, which is enough
 * to break out of an attribute.
 */
function escapeHtml(value) {
  return value == null
    ? ""
    : String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * Small monochrome (currentColor) inline SVGs for the rich empty states
 * below — kept as markup rather than an icon font or emoji so they match
 * this app's line-drawn visual language and cost nothing over the
 * network (no external font/image request, which the CSP wouldn't allow
 * anyway).
 */
const ICON_TRAY =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13h4l2 3h4l2-3h4"/><path d="M5.5 6h13l1.5 7v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-6l1.5-7Z"/></svg>';
const ICON_CHECK =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5L16 9.5"/></svg>';
const ICON_SEARCH =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

/**
 * A rich empty state, reserved for the handful of top-level "nothing
 * here" moments a person actually lands on — see the CSS comment on
 * .empty-hero for why the many small inline ones stay plain text.
 * Returns a full <li> so it drops straight into a `ul.list`'s innerHTML
 * the same way every plain-text empty row already does.
 */
function emptyHero(icon, title, body, { ok = false } = {}) {
  return `<li class="static empty-hero-row"><div class="empty-hero">
    <div class="empty-hero-icon${ok ? " ok" : ""}">${icon}</div>
    <h4>${escapeHtml(title)}</h4>
    ${body ? `<p>${escapeHtml(body)}</p>` : ""}
  </div></li>`;
}

/**
 * A URL is only safe behind a clickable link if it's actually http(s) —
 * these come from CourtListener results and from whatever a user typed
 * when saving a reference, so a stored `javascript:` URL would otherwise
 * be one click away from running inside a logged-in attorney's session.
 * Returns "" for anything else, and callers drop the link entirely.
 */
function safeUrl(value) {
  try {
    const parsed = new URL(String(value), window.location.origin);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
  } catch {
    return "";
  }
}

function mkButton(label, onClick) {
  const btn = document.createElement("button");
  btn.className = "btn";
  btn.textContent = label;
  btn.onclick = onClick;
  return btn;
}

/*
 * Speech. Two engines, tried in order:
 *
 * 1. The firm's voice server (Voicebox, SPEECH_TOOLS=true) via
 *    /api/speech/synthesize, played from a blob: URL.
 * 2. This device's own built-in voice (the browser's speechSynthesis), so
 *    read-aloud works with no server set up at all.
 *
 * The browser engine only ever uses a voice the device reports as
 * `localService`. Some browsers offer network voices (Chrome's "Google …"
 * voices synthesize on Google's servers), and drafts and messages are
 * privileged — read-aloud must not quietly send them to a third party.
 * No local voice means no browser engine, and the Listen buttons don't
 * appear rather than falling back to a network voice.
 */
let browserVoice = null;
let callerVoice = null;
let currentAudio = null;
let speakingCount = 0;

function pickLocalVoices() {
  if (!("speechSynthesis" in window)) return;
  const local = window.speechSynthesis.getVoices().filter((v) => v.localService);
  const english = local.filter((v) => /^en/i.test(v.lang));
  browserVoice = english.find((v) => v.default) || english[0] || local[0] || null;
  // A second voice for the caller's side of a sample call, so the two
  // speakers are distinguishable; the same voice if the device has one.
  callerVoice = english.find((v) => v !== browserVoice) || browserVoice;
  updateVoiceStatus();
}
if ("speechSynthesis" in window) {
  pickLocalVoices();
  window.speechSynthesis.addEventListener("voiceschanged", pickLocalVoices);
}

function speechEngine() {
  if (speechAvailable) return "server";
  if (browserVoice) return "browser";
  return null;
}

function setSpeaking(delta) {
  speakingCount = Math.max(0, speakingCount + delta);
  const stop = document.getElementById("intakeStopAudio");
  if (stop) stop.hidden = speakingCount === 0 && !intakePlayingThrough;
}

/** Stops whatever is being spoken right now, on either engine. */
function stopSpeaking() {
  if (currentAudio) {
    const audio = currentAudio;
    currentAudio = null;
    audio.pause();
    audio.dispatchEvent(new Event("ended"));
  }
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

async function speakViaServer(text) {
  const res = await fetch("/api/speech/synthesize", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (res.status === 401) {
    window.location.href = "/login.html";
    return;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Couldn't synthesize speech.");
  }
  const url = URL.createObjectURL(await res.blob());
  const audio = new Audio(url);
  currentAudio = audio;
  try {
    await new Promise((resolve, reject) => {
      audio.addEventListener("ended", resolve, { once: true });
      audio.addEventListener("error", () => reject(new Error("Couldn't play the synthesized audio.")), { once: true });
      audio.play().catch(reject);
    });
  } finally {
    URL.revokeObjectURL(url);
    if (currentAudio === audio) currentAudio = null;
  }
}

function speakViaBrowser(text, voice) {
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    // Resolve on error too: a cancelled utterance (Stop, or a new
    // conversation) must not leave a sample call waiting forever.
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    window.speechSynthesis.speak(utterance);
  });
}

/**
 * Speaks `text` and resolves once it has finished, so callers can take
 * turns (a sample call waits for each line before the next). `speaker:
 * "caller"` picks the second browser voice.
 */
async function speak(text, { speaker = "agent" } = {}) {
  const trimmed = (text || "").trim();
  if (!trimmed) return;
  const engine = speechEngine();
  if (!engine) throw new Error("No offline voice is available in this browser.");
  setSpeaking(1);
  try {
    if (engine === "server") await speakViaServer(trimmed);
    else await speakViaBrowser(trimmed, speaker === "caller" ? callerVoice : browserVoice);
  } finally {
    setSpeaking(-1);
  }
}

/** Backs every "Listen" button: a busy label while speaking, errors to the banner. */
async function playSynthesizedSpeech(text, button) {
  showError("");
  if (!(text || "").trim()) {
    showError("Nothing to read aloud.");
    return;
  }
  const originalLabel = button ? button.textContent : null;
  if (button) {
    button.disabled = true;
    button.textContent = "Speaking…";
  }
  try {
    await speak(text);
  } catch (err) {
    showError(err.message || "Couldn't play synthesized speech.");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }
}

// Matches SpeechService's own gate (every logged-in staff human; not
// system/client/anonymous), and needs a working engine — a button that
// can't make a sound is worse than none.
function canUseSpeechTools() {
  return speechEngine() !== null && currentRole && currentRole !== "system" && currentRole !== "client" && currentRole !== "anonymous";
}

function listenButton(text) {
  const btn = mkButton("Listen", () => playSynthesizedSpeech(text, btn));
  return btn;
}

/** Live Intake's voice line: which engine will speak, or why none can. */
function updateVoiceStatus() {
  const status = document.getElementById("intakeVoiceStatus");
  if (!status) return;
  const engine = speechEngine();
  const usable = engine !== null;
  document.getElementById("intakeReadAloud").disabled = !usable;
  document.getElementById("intakePlaySample").disabled = !usable;
  if (engine === "server") {
    status.textContent = "Voice: the firm's voice server.";
  } else if (engine === "browser") {
    status.textContent = `Voice: ${browserVoice.name}, built into this device. Nothing is sent anywhere to speak it.`;
  } else {
    status.textContent =
      "No offline voice in this browser, so read-aloud is off. Try another browser or device, or ask an admin to turn on the firm's voice server (SPEECH_TOOLS).";
  }
}

const REVIEW_ACTION_LABEL = {
  approve: "Approved.",
  reject: "Rejected.",
  "request-revision": "Sent back for revision.",
  release: "Released.",
  "clear-flag": "Flag cleared.",
};

async function act(path, body, id) {
  showError("");
  try {
    await api(path, { method: "POST", body: JSON.stringify(body) });
    await loadQueue();
    await loadDetail(id);
    const action = path.split("/").pop();
    showToast(REVIEW_ACTION_LABEL[action] || "Done.", "success");
  } catch (err) {
    showError(err.message);
  }
}

document.getElementById("refresh").addEventListener("click", loadQueue);

/* ===== Deadlines ===== */
async function checkDeadline() {
  showError("");
  if (currentRole && currentRole !== "attorney") {
    document.getElementById("deadlineStatus").innerHTML = '<p class="empty">Deadlines are attorney-only.</p>';
    return;
  }
  try {
    const matterId = document.getElementById("deadlineMatterId").value;
    const type = document.getElementById("deadlineType").value;
    const status = await api(`/api/deadlines?matterId=${encodeURIComponent(matterId)}&type=${encodeURIComponent(type)}`);
    const el = document.getElementById("deadlineStatus");
    const badge =
      status.state === "confirmed"
        ? `<span class="badge confirmed">verified</span> ${escapeHtml(status.date)}`
        : status.state === "conflict"
          ? '<span class="badge conflict">sources disagree</span>'
          : '<span class="badge pending_review">not yet verified</span>';
    // Who recorded what, so "it needs a second check" is actionable
    // rather than mysterious.
    const recorded = status.calculations
      .map(
        (c) =>
          `<li class="static"><strong>${escapeHtml(c.date)}</strong> <span class="badge">${escapeHtml(c.source)}</span>${
            c.recordedBy ? ` <span class="badge">${escapeHtml(c.recordedBy)}</span>` : ""
          }<div class="meta-tight">${new Date(c.recordedAt).toLocaleString()}</div></li>`,
      )
      .join("");
    el.innerHTML = `<p>${badge}</p>
      ${status.hint ? `<p class="subtitle-inline">${escapeHtml(status.hint)}</p>` : ""}
      ${recorded ? `<ul class="list">${recorded}</ul>` : ""}`;
    await loadConflicts();
  } catch (err) {
    showError(err.message);
  }
}

async function confirmDeadline() {
  showError("");
  if (currentRole && currentRole !== "attorney") {
    return;
  }
  const matterId = document.getElementById("deadlineMatterId").value.trim();
  const date = document.getElementById("deadlineDate").value;
  if (!matterId || !date) {
    showError(!matterId ? "Pick the matter this deadline belongs to first." : "Choose the date you checked first.");
    return;
  }
  try {
    await api("/api/deadlines/confirm", {
      method: "POST",
      body: JSON.stringify({
        matterId,
        type: document.getElementById("deadlineType").value,
        date,
        source: document.getElementById("deadlineSource").value,
      }),
    });
    await checkDeadline();
    showToast("Deadline confirmation recorded.", "success");
  } catch (err) {
    showError(err.message);
  }
}

async function loadConflicts() {
  if (currentRole && currentRole !== "attorney") {
    renderAttorneyOnly("conflictList", "Deadlines are attorney-only.");
    return;
  }
  try {
    const conflicts = await api("/api/deadlines/conflicts");
    const list = document.getElementById("conflictList");
    list.innerHTML = conflicts.length
      ? conflicts
          .map((c) => `<li class="static">${escapeHtml(c.matterId)} / ${escapeHtml(c.type)}: ${escapeHtml(c.calculations.map((x) => `${x.source}=${x.date}`).join(", "))}</li>`)
          .join("")
      : '<li class="static empty">None.</li>';
  } catch (err) {
    showError(err.message);
  }
}

function downloadDeadlinesCsv() {
  showError("");
  if (lastUpcomingDeadlines.length === 0) {
    showError("Nothing to export — load the \"Coming due\" list first.");
    return;
  }
  const header = ["Matter ID", "Type", "Date", "Days away", "Overdue", "Verification"];
  const rows = lastUpcomingDeadlines.map((d) => [
    d.matterId,
    DEADLINE_TYPE_LABEL[d.type] || d.type,
    d.date,
    d.daysAway,
    d.overdue ? "yes" : "no",
    d.confirmationState === "confirmed"
      ? "confirmed by two sources"
      : d.confirmationState === "conflict"
        ? "sources disagree"
        : "only one source — not verified",
  ]);
  downloadCsv(`deadlines-coming-due-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
}

document.getElementById("checkDeadline").addEventListener("click", checkDeadline);
document.getElementById("loadUpcoming").addEventListener("click", loadUpcomingDeadlines);
document.getElementById("confirmDeadline").addEventListener("click", confirmDeadline);
document.getElementById("downloadDeadlinesCsv").addEventListener("click", downloadDeadlinesCsv);

/* ===== Scheduling ===== */
async function bookAppointment() {
  showError("");
  try {
    const startTimeLocal = document.getElementById("apptStartTime").value;
    if (!startTimeLocal) throw new Error("pick a start time");
    await api("/api/appointments", {
      method: "POST",
      body: JSON.stringify({
        matterId: document.getElementById("apptMatterId").value,
        startTime: new Date(startTimeLocal).toISOString(),
        practiceAreaId: document.getElementById("apptPracticeArea").value,
        ...(document.getElementById("apptAttorneyId").value ? { attorneyId: document.getElementById("apptAttorneyId").value } : {}),
        allowOutsideBusinessHours: document.getElementById("apptOverrideHours").checked,
      }),
    });
    document.getElementById("scheduleListMatterId").value = document.getElementById("apptMatterId").value;
    await loadAppointments();
    await loadDueReminders();
    showToast("Appointment booked.", "success");
  } catch (err) {
    showError(err.message);
  }
}

/*
 * Online booking requests (see core/booking-requests.ts). The card stays
 * hidden unless the server has the public booking page turned on and the
 * signed-in role can handle requests.
 */
let bookingMatterTypeLabels = null;

function bookingDefaultStart(request) {
  const hour = request.preferredTime === "afternoon" ? "14:00" : "10:00";
  return `${request.preferredDate}T${hour}`;
}

async function loadBookingRequests() {
  const card = document.getElementById("bookingRequestsCard");
  const list = document.getElementById("bookingRequestList");
  // Known to be off: don't ask, and don't leave a 404 in the console.
  if (capabilities && capabilities.publicBooking === false) {
    card.hidden = true;
    return;
  }
  const requests = await tryApi("/api/booking-requests");
  if (!requests) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  if (!bookingMatterTypeLabels) {
    const config = await tryApi("/api/public/booking/config");
    bookingMatterTypeLabels = Object.fromEntries((config?.matterTypes ?? []).map((t) => [t.id, t.label]));
  }
  const pending = requests.filter((r) => r.status === "pending");
  const decided = requests.filter((r) => r.status !== "pending").slice(0, 10);
  if (requests.length === 0) {
    list.innerHTML = '<li class="static empty">No requests yet. Share the public booking link to start receiving them.</li>';
    return;
  }
  list.innerHTML = "";
  for (const request of [...pending, ...decided]) {
    const li = document.createElement("li");
    li.classList.add("static");
    const contact = [request.email, request.phone].filter(Boolean).map(escapeHtml).join(" · ");
    const prefers = `${new Date(`${request.preferredDate}T12:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, ${request.preferredTime === "any" ? "any time" : request.preferredTime}`;
    const conflictBadge = request.conflict.requiresAttorneyReview
      ? '<span class="badge conflict">conflicts: attorney review</span>'
      : '<span class="badge approved">conflicts: clear</span>';
    const statusBadge = request.status === "pending" ? "" : `<span class="badge ${request.status === "accepted" ? "scheduled" : "rejected"}">${request.status}</span>`;
    li.innerHTML = `<strong>${escapeHtml(request.name)}</strong> · ${escapeHtml(bookingMatterTypeLabels[request.matterType] ?? request.matterType)} ${conflictBadge} ${statusBadge}
      <div class="meta">${contact} · prefers ${escapeHtml(prefers)}${request.otherPartyName ? ` · other party: ${escapeHtml(request.otherPartyName)}` : ""}</div>`;
    if (request.conflict.hits.length) {
      const hits = document.createElement("ul");
      hits.className = "meta-list";
      for (const hit of request.conflict.hits) {
        const item = document.createElement("li");
        item.textContent = `${hit.matterTitle} (${hit.matterId}): ${hit.explanation}`;
        hits.appendChild(item);
      }
      li.appendChild(hits);
    }
    if (request.status === "pending") {
      const row = document.createElement("div");
      row.className = "field-row mt-xs";
      const when = document.createElement("input");
      when.type = "datetime-local";
      when.value = bookingDefaultStart(request);
      const whenField = document.createElement("label");
      whenField.className = "field";
      whenField.append("Start (local)", when);
      row.appendChild(whenField);
      // Explicit, so accepting works even without a firm config to auto-assign from.
      const who = document.createElement("select");
      const attorneys = knownStaff.filter((m) => m.role === "attorney" && !m.disabled);
      for (const a of attorneys) {
        const option = document.createElement("option");
        option.value = a.actorId;
        option.textContent = a.displayName;
        if (a.actorId === currentActorId) option.selected = true;
        who.appendChild(option);
      }
      if (attorneys.length) {
        const whoField = document.createElement("label");
        whoField.className = "field";
        whoField.append("Attorney", who);
        row.appendChild(whoField);
      }
      row.appendChild(
        mkButton("Accept and book", async () => {
          showError("");
          try {
            await api(`/api/booking-requests/${encodeURIComponent(request.id)}/accept`, {
              method: "POST",
              body: JSON.stringify({ startTime: new Date(when.value).toISOString(), ...(who.value ? { attorneyId: who.value } : {}) }),
            });
            showToast(`Booked ${request.name}.`, "success");
            await loadBookingRequests();
          } catch (err) {
            showError(err.message);
          }
        }),
      );
      row.appendChild(
        mkButton("Decline", async () => {
          const reason = prompt("Reason for declining (kept on the record, not sent to them)?") || undefined;
          try {
            await api(`/api/booking-requests/${encodeURIComponent(request.id)}/decline`, { method: "POST", body: JSON.stringify({ reason }) });
            showToast("Request declined.", "success");
            await loadBookingRequests();
          } catch (err) {
            showError(err.message);
          }
        }),
      );
      li.appendChild(row);
    } else if (request.appointmentId) {
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `Booked as ${request.appointmentId} (matter prospective-${request.id}) by ${request.decidedBy}`;
      li.appendChild(meta);
    }
    list.appendChild(li);
  }
}

document.getElementById("copyBookingLink").addEventListener("click", async () => {
  const link = `${location.origin}/book.html`;
  try {
    await navigator.clipboard.writeText(link);
    showToast("Booking link copied.", "success");
  } catch {
    showToast(link, "success");
  }
});

async function loadAppointments() {
  showError("");
  const matterId = document.getElementById("scheduleListMatterId").value.trim();
  const list = document.getElementById("appointmentList");
  if (!matterId) {
    list.innerHTML = '<li class="static empty">Enter a matter ID above to see its appointments.</li>';
    return;
  }
  try {
    const items = await api(`/api/appointments?matterId=${encodeURIComponent(matterId)}`);
    list.innerHTML = "";
    for (const appt of items) {
      const li = document.createElement("li");
      li.classList.add("static");
      const when = new Date(appt.startTime).toLocaleString();
      li.innerHTML = `<strong>${appt.type}</strong> with ${appt.attorneyId} at ${when}
        <span class="badge ${appt.status}">${appt.status}</span>`;
      if (appt.status === "scheduled" || appt.status === "rescheduled") {
        const cancelBtn = mkButton("Cancel", async () => {
          const reason = prompt("Cancellation reason (optional)?") || undefined;
          try {
            await api(`/api/appointments/${appt.id}/cancel`, { method: "POST", body: JSON.stringify({ reason }) });
            await loadAppointments();
            showToast("Appointment cancelled.", "success");
          } catch (err) {
            showError(err.message);
          }
        });
        cancelBtn.classList.add("danger");
        const completeBtn = mkButton("Complete", async () => {
          try {
            await api(`/api/appointments/${appt.id}/complete`, { method: "POST", body: "{}" });
            await loadAppointments();
            showToast("Appointment marked complete.", "success");
          } catch (err) {
            showError(err.message);
          }
        });
        li.appendChild(document.createElement("br"));
        li.append(cancelBtn, completeBtn);
      }
      list.appendChild(li);
    }
    if (items.length === 0) list.innerHTML = '<li class="static empty">No appointments for this matter.</li>';
  } catch (err) {
    showError(err.message);
  }
}

async function loadDueReminders() {
  const due = await api("/api/appointments/reminders/due");
  const list = document.getElementById("dueReminderList");
  list.innerHTML = due.length
    ? due
        .map(
          (d) =>
            `<li class="static">Matter ${escapeHtml(d.appointment.matterId)} — ${d.reminder.offsetMinutesBefore} min before ${new Date(d.appointment.startTime).toLocaleString()}</li>`,
        )
        .join("")
    : '<li class="static empty">None due right now.</li>';
}

document.getElementById("bookAppt").addEventListener("click", bookAppointment);
document.getElementById("refreshAppointments").addEventListener("click", loadAppointments);

/* ===== Live Intake Demo ===== */
let intakeSessionId = null;

// The Live Intake Demo's training scenarios (see intake-scenarios.ts) —
// fetched once and cached, since the list is static server content.
let intakeScenarios = [];
let currentIntakeScenario = null;
let intakeScenarioLineIndex = 0;
let intakePlayingThrough = false;
// Bumped on every new conversation so a still-running play-through from the previous one stops instead of typing into the new session.
let intakeRunId = 0;
// Every turn's { speaker, text, trace } — the record the debrief and the
// transcript download are both built from, so they can never disagree.
let intakeTranscript = [];
// Replies are spoken one after another, never over each other: each new
// one chains onto whatever is still being said.
let intakeSpeech = Promise.resolve();

function readAloudOn() {
  return document.getElementById("intakeReadAloud").checked && speechEngine() !== null;
}

function queueIntakeSpeech(text) {
  if (!readAloudOn()) return;
  const runId = intakeRunId;
  intakeSpeech = intakeSpeech
    .then(() => (runId === intakeRunId ? speak(text) : undefined))
    .catch((err) => showError(err.message || "Couldn't read that aloud."));
}

async function loadIntakeScenarios() {
  try {
    api("/api/intake/capabilities")
      .then((caps) => {
        document.getElementById("intakeNaturalPhrasingField").hidden = !caps.naturalPhrasing;
      })
      .catch(() => {});
    intakeScenarios = await api("/api/intake/scenarios");
    const select = document.getElementById("intakeScenarioId");
    for (const scenario of intakeScenarios) {
      const opt = document.createElement("option");
      opt.value = scenario.id;
      opt.textContent = scenario.label;
      select.appendChild(opt);
    }
  } catch {
    // The intake demo nav item is already role-gated; a failure here just
    // leaves the free-form-only option, same degrade-not-break pattern as
    // every other best-effort fetch on Home.
  }
}

document.getElementById("intakeScenarioId").addEventListener("change", () => {
  const scenario = intakeScenarios.find((s) => s.id === document.getElementById("intakeScenarioId").value);
  document.getElementById("intakeScenarioDescription").textContent = scenario ? scenario.description : "";
});

/**
 * What just happened, rendered as a small badge under the agent's bubble —
 * the whole point of a *training* panel over a plain chat window. When
 * natural phrasing added an acknowledgement, it's set apart in italics so a
 * trainee can see exactly which words were the script.
 */
function appendBubble(kind, text, trace, acknowledgement) {
  const log = document.getElementById("chatLog");
  const bubble = document.createElement("div");
  bubble.className = `bubble ${kind}`;
  if (acknowledgement && text.startsWith(`${acknowledgement} `)) {
    const added = document.createElement("span");
    added.className = "ack-text";
    added.title = "Added by Claude. Everything after it is the exact script.";
    added.textContent = acknowledgement;
    bubble.appendChild(added);
    bubble.appendChild(document.createTextNode(text.slice(acknowledgement.length)));
  } else {
    bubble.textContent = text;
  }
  if (kind === "agent" && canUseSpeechTools()) {
    bubble.appendChild(listenButton(text));
  }
  if (trace) {
    const badge = document.createElement("span");
    badge.className = "trace-badge";
    badge.textContent = trace.label + (trace.triggers.length ? ` · ${trace.triggers.join(", ")}` : "") + (acknowledgement ? " · + acknowledgement" : "");
    bubble.appendChild(badge);
  }
  log.appendChild(bubble);
  log.scrollTop = log.scrollHeight;
  intakeTranscript.push({ speaker: kind, text, trace: trace || null, acknowledgement: acknowledgement || null });
}

const INTAKE_STATUS_FIELDS = [
  { key: "callerType", label: "Caller type", render: (v) => (v === "unknown" ? { text: "not yet identified", cls: "no" } : { text: v.replace(/_/g, " "), cls: "yes" }) },
  { key: "interpreterNeeded", label: "Interpreter needed", render: (v) => (v ? { text: "yes", cls: "yes" } : { text: "no", cls: "no" }) },
  { key: "interpreterRouted", label: "Interpreter routed", render: (v, s) => (!s.interpreterNeeded ? { text: "n/a", cls: "no" } : v ? { text: "yes", cls: "yes" } : { text: "pending", cls: "no" }) },
  { key: "recordingConsentDisclosed", label: "Consent disclosed", render: (v) => (v ? { text: "yes", cls: "yes" } : { text: "pending", cls: "no" }) },
  { key: "conflictCheckRun", label: "Conflict check", render: (v, s) => (!v ? { text: "pending", cls: "no" } : s.conflictCheckResolved ? { text: "cleared", cls: "yes" } : { text: "conflict found", cls: "conflict" }) },
];

function renderIntakeStatus(state) {
  const list = document.getElementById("intakeStatusList");
  if (!state) {
    list.innerHTML = '<li class="static empty">Start a conversation to see live status.</li>';
    return;
  }
  list.innerHTML = "";
  for (const field of INTAKE_STATUS_FIELDS) {
    const { text, cls } = field.render(state[field.key], state);
    const li = document.createElement("li");
    li.innerHTML = `<span class="status-label">${escapeHtml(field.label)}</span><span class="status-value ${cls}">${escapeHtml(text)}</span>`;
    list.appendChild(li);
  }
}

function showIntakeDebrief() {
  const allTriggers = [...new Set(intakeTranscript.flatMap((t) => (t.trace ? t.trace.triggers : [])))];
  const agentTurns = intakeTranscript.filter((t) => t.speaker === "agent").length;
  const finalState = [...intakeTranscript].reverse().find((t) => t.trace)?.trace.state;
  const body = document.getElementById("intakeDebriefBody");
  body.innerHTML = `
    <ul class="status-list">
      <li><span class="status-label">Agent turns</span><span class="status-value">${agentTurns}</span></li>
      <li><span class="status-label">Final caller type</span><span class="status-value">${escapeHtml(finalState?.callerType ?? "unknown")}</span></li>
      <li><span class="status-label">Escalation triggers fired</span><span class="status-value ${allTriggers.length ? "conflict" : "no"}">${allTriggers.length ? escapeHtml(allTriggers.join(", ")) : "none"}</span></li>
    </ul>
  `;
  document.getElementById("intakeDebrief").hidden = false;
}

function resetIntakeTraining() {
  intakeTranscript = [];
  intakeScenarioLineIndex = 0;
  intakePlayingThrough = false;
  intakeRunId += 1;
  stopSpeaking();
  intakeSpeech = Promise.resolve();
  setSpeaking(0);
  document.getElementById("intakeDebrief").hidden = true;
  renderIntakeStatus(null);
  updateScenarioProgress();
}

function updateScenarioProgress() {
  const controls = document.getElementById("intakeScenarioControls");
  const progress = document.getElementById("intakeScenarioProgress");
  if (!currentIntakeScenario) {
    controls.hidden = true;
    return;
  }
  controls.hidden = false;
  const remaining = currentIntakeScenario.lines.length - intakeScenarioLineIndex;
  if (!intakeSessionId) {
    progress.textContent = "Conversation ended — start a new one to run another scenario.";
  } else if (remaining > 0) {
    progress.textContent = `${remaining} scripted line(s) left`;
  } else {
    progress.textContent = "Scenario complete — continue free-form if you like.";
  }
  document.getElementById("scenarioNextLine").disabled = remaining <= 0 || !intakeSessionId;
  document.getElementById("scenarioPlayAll").disabled = remaining <= 0 || !intakeSessionId;
}

async function startIntake() {
  showError("");
  try {
    document.getElementById("chatLog").innerHTML = "";
    resetIntakeTraining();
    currentIntakeScenario = intakeScenarios.find((s) => s.id === document.getElementById("intakeScenarioId").value) || null;
    const naturalPhrasing = !document.getElementById("intakeNaturalPhrasingField").hidden && document.getElementById("intakeNaturalPhrasing").checked;
    const { sessionId, reply, trace } = await api("/api/intake/start", { method: "POST", body: JSON.stringify({ naturalPhrasing }) });
    intakeSessionId = sessionId;
    appendBubble("agent", reply, trace);
    queueIntakeSpeech(reply);
    renderIntakeStatus(trace?.state);
    document.getElementById("chatText").disabled = false;
    document.getElementById("chatSend").disabled = false;
    document.getElementById("chatText").focus();
    updateScenarioProgress();
  } catch (err) {
    showError(err.message);
  }
}

/** Shared by manual typing and the scenario controls — one real turn, one place that ends the conversation. */
async function sendIntakeTurn(text) {
  if (!text || !intakeSessionId) return;
  appendBubble("caller", text);
  showError("");
  try {
    const { reply, done, trace, acknowledgement } = await api(`/api/intake/${intakeSessionId}/message`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    appendBubble("agent", reply, trace, acknowledgement);
    queueIntakeSpeech(reply);
    renderIntakeStatus(trace?.state);
    if (done) {
      appendBubble("system", "Conversation ended. Start a new one to try another scenario.");
      document.getElementById("chatText").disabled = true;
      document.getElementById("chatSend").disabled = true;
      intakeSessionId = null;
      showIntakeDebrief();
    }
  } catch (err) {
    showError(err.message);
  }
  updateScenarioProgress();
}

async function sendChat() {
  const input = document.getElementById("chatText");
  const text = input.value.trim();
  input.value = "";
  await sendIntakeTurn(text);
}

async function sendNextScenarioLine() {
  if (!currentIntakeScenario || intakeScenarioLineIndex >= currentIntakeScenario.lines.length) return;
  const line = currentIntakeScenario.lines[intakeScenarioLineIndex];
  intakeScenarioLineIndex += 1;
  await sendIntakeTurn(line);
}

/**
 * Plays the selected scenario's scripted lines into the real session. With
 * read-aloud on, it becomes a call you can listen to: it waits for the
 * receptionist to finish speaking, speaks the caller's line in a second
 * voice, then sends it — so nothing ever talks over anything else.
 */
async function playScenarioThrough() {
  if (intakePlayingThrough) return;
  intakePlayingThrough = true;
  setSpeaking(0);
  const runId = intakeRunId;
  const live = () => runId === intakeRunId && currentIntakeScenario && intakeScenarioLineIndex < currentIntakeScenario.lines.length && intakeSessionId;
  try {
    while (live()) {
      if (readAloudOn()) {
        await intakeSpeech;
        if (!live()) break;
        await speak(currentIntakeScenario.lines[intakeScenarioLineIndex], { speaker: "caller" }).catch(() => {});
        if (!live()) break;
        await sendNextScenarioLine();
      } else {
        await sendNextScenarioLine();
        await new Promise((resolve) => setTimeout(resolve, 650));
      }
    }
    if (runId === intakeRunId) await intakeSpeech;
  } finally {
    if (runId === intakeRunId) {
      intakePlayingThrough = false;
      setSpeaking(0);
    }
  }
}

/** One click: pick a scenario (the routine call if none is chosen), turn read-aloud on, and play the whole call out loud. */
async function playSampleCall() {
  const select = document.getElementById("intakeScenarioId");
  if (!select.value) {
    select.value = "routine-new-client";
    select.dispatchEvent(new Event("change"));
  }
  document.getElementById("intakeReadAloud").checked = true;
  await startIntake();
  if (intakeSessionId) await playScenarioThrough();
}

function stopIntakeAudio() {
  // Bumping the run id ends a play-through at its next check; the session
  // itself stays open so the trainee can carry on typing.
  intakeRunId += 1;
  intakePlayingThrough = false;
  stopSpeaking();
  intakeSpeech = Promise.resolve();
  setSpeaking(0);
  updateScenarioProgress();
}

function downloadIntakeTranscript() {
  const lines = intakeTranscript.map((t) => {
    const who = t.speaker === "caller" ? "Caller" : t.speaker === "agent" ? "Agent" : "System";
    const traceNote = t.trace ? `  [${t.trace.label}${t.trace.triggers.length ? ` · ${t.trace.triggers.join(", ")}` : ""}${t.acknowledgement ? ` · added: "${t.acknowledgement}"` : ""}]` : "";
    return `${who}: ${t.text}${traceNote}`;
  });
  const blob = new Blob([lines.join("\n")], { type: "text/plain" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `live-intake-demo-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
  link.click();
  URL.revokeObjectURL(link.href);
}

document.getElementById("startIntake").addEventListener("click", startIntake);
document.getElementById("chatSend").addEventListener("click", sendChat);
document.getElementById("chatText").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});
document.getElementById("scenarioNextLine").addEventListener("click", sendNextScenarioLine);
document.getElementById("scenarioPlayAll").addEventListener("click", () => playScenarioThrough());
document.getElementById("intakePlaySample").addEventListener("click", () => playSampleCall());
document.getElementById("intakeStopAudio").addEventListener("click", stopIntakeAudio);
document.getElementById("intakeReadAloud").addEventListener("change", (e) => {
  if (!e.target.checked) stopIntakeAudio();
});
updateVoiceStatus();
document.getElementById("downloadTranscript").addEventListener("click", downloadIntakeTranscript);

/* ===== Drafting ===== */
function draftingMatterId() {
  return document.getElementById("draftingMatterId").value;
}

/**
 * The matter a new draft is for. Without this, "Draft" with the matter
 * box empty posted to /api/drafting/matters//… and came back with the
 * server's bare "not found" — true, and no help at all.
 */
function requiredDraftingMatterId() {
  const id = draftingMatterId().trim();
  if (!id) throw new Error("Pick a matter first — the draft is filed against it.");
  return id;
}

async function loadTemplates() {
  try {
    const templates = await api("/api/drafting/templates");
    const select = document.getElementById("draftTemplateId");
    select.innerHTML = templates.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join("");
  } catch (err) {
    // Non-fatal if this account can't draft (e.g. not yet assigned) — the matter list will surface that instead.
  }
}

async function loadMatterDrafts() {
  showError("");
  document.getElementById("draftingDetail").innerHTML = "";
  const list = document.getElementById("draftingList");
  if (!draftingMatterId().trim()) {
    list.innerHTML = '<li class="static empty">Enter a matter ID above to see its drafts.</li>';
    return;
  }
  try {
    const items = await api(`/api/drafting/matters/${encodeURIComponent(draftingMatterId())}`);
    list.innerHTML = "";
    for (const item of items) {
      const li = document.createElement("li");
      li.innerHTML = `<strong>${escapeHtml(item.kind)}</strong>
        <span class="badge ${item.status}">${item.status}</span>
        ${item.flags.length ? `<div class="flags">Unresolved flags: ${escapeHtml(item.flags.join(", "))}</div>` : ""}`;
      li.addEventListener("click", () => loadDraftDetail(item.id));
      list.appendChild(li);
    }
    if (items.length === 0) list.innerHTML = '<li class="static empty">No work product on this matter yet.</li>';
  } catch (err) {
    showError(err.message);
  }
}

async function loadDraftDetail(id) {
  showError("");
  try {
    const wp = await api(`/api/drafting/matters/${encodeURIComponent(draftingMatterId())}/work-products/${id}`);
    const detail = document.getElementById("draftingDetail");
    const editable = wp.status === "draft" || wp.status === "revision_requested";
    detail.innerHTML = `
      <div class="card">
        <h3>${escapeHtml(wp.kind)} <span class="badge ${wp.status}">${wp.status}</span></h3>
        ${wp.flags.length ? `<div class="flags">Unresolved flags: ${wp.flags.map((f) => `<code>${f}</code>`).join(", ")}</div>` : ""}
        <div class="field-row">
          <label class="field grow">Content
            <textarea id="draftDetailContent" rows="8" ${editable ? "" : "disabled"}>${wp.content}</textarea>
          </label>
        </div>
        <div class="actions" id="draftDetailActions"></div>
      </div>
    `;
    if (canUseSpeechTools()) {
      document.getElementById("draftDetailActions").appendChild(listenButton(wp.content));
    }
    if (editable) {
      const actions = document.getElementById("draftDetailActions");
      const saveBtn = mkButton("Save revision", async () => {
        showError("");
        try {
          const content = document.getElementById("draftDetailContent").value;
          await api(`/api/drafting/matters/${encodeURIComponent(draftingMatterId())}/work-products/${id}/revise`, {
            method: "POST",
            body: JSON.stringify({ content }),
          });
          await loadMatterDrafts();
          await loadDraftDetail(id);
          showToast("Revision saved.", "success");
        } catch (err) {
          showError(err.message);
        }
      });
      const submitBtn = mkButton("Submit for review", async () => {
        showError("");
        try {
          await api(`/api/drafting/matters/${encodeURIComponent(draftingMatterId())}/work-products/${id}/submit`, {
            method: "POST",
            body: "{}",
          });
          await loadMatterDrafts();
          await loadDraftDetail(id);
          showToast("Submitted to the Review Queue.", "success");
        } catch (err) {
          showError(err.message);
        }
      });
      submitBtn.classList.add("primary");
      actions.append(saveBtn, submitBtn);
    }
  } catch (err) {
    showError(err.message);
  }
}

async function createTemplateDraft() {
  showError("");
  try {
    const body = {
      templateId: document.getElementById("draftTemplateId").value,
      content: document.getElementById("draftTemplateContent").value,
    };
    const deadlineDate = document.getElementById("draftDeadlineDate").value;
    if (deadlineDate) {
      body.deadlineDate = deadlineDate;
      body.deadlineType = document.getElementById("draftDeadlineType").value;
    }
    await api(`/api/drafting/matters/${encodeURIComponent(requiredDraftingMatterId())}/draft-template`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    document.getElementById("draftTemplateContent").value = "";
    document.getElementById("draftDeadlineDate").value = "";
    await loadMatterDrafts();
    showToast("Draft created.", "success");
  } catch (err) {
    showError(err.message);
  }
}

// A convenience preview only — the memo's score and level are computed by
// the server (core/risk-assessment.ts), which ignores anything sent here.
function updateRiskPreview() {
  const score = Number(document.getElementById("riskSeverity").value) * Number(document.getElementById("riskLikelihood").value);
  const level = score <= 4 ? "low" : score <= 9 ? "medium" : score <= 15 ? "high" : "critical";
  document.getElementById("riskPreview").textContent = `Score ${score} — ${level} risk`;
}
document.getElementById("riskSeverity").addEventListener("change", updateRiskPreview);
document.getElementById("riskLikelihood").addEventListener("change", updateRiskPreview);
updateRiskPreview();

async function createRiskDraft() {
  showError("");
  const lines = (id) => document.getElementById(id).value.split("\n").map((l) => l.trim()).filter(Boolean);
  try {
    await api(`/api/drafting/matters/${encodeURIComponent(requiredDraftingMatterId())}/draft-risk-assessment`, {
      method: "POST",
      body: JSON.stringify({
        description: document.getElementById("riskDescription").value,
        background: document.getElementById("riskBackground").value,
        severity: Number(document.getElementById("riskSeverity").value),
        severityRationale: document.getElementById("riskSeverityRationale").value,
        likelihood: Number(document.getElementById("riskLikelihood").value),
        likelihoodRationale: document.getElementById("riskLikelihoodRationale").value,
        contributingFactors: lines("riskContributing"),
        mitigatingFactors: lines("riskMitigating"),
        recommendedApproach: document.getElementById("riskApproach").value,
        nextSteps: lines("riskNextSteps"),
      }),
    });
    for (const id of ["riskDescription", "riskBackground", "riskSeverityRationale", "riskLikelihoodRationale", "riskContributing", "riskMitigating", "riskApproach", "riskNextSteps"]) {
      document.getElementById(id).value = "";
    }
    await loadMatterDrafts();
    showToast("Risk assessment drafted.", "success");
  } catch (err) {
    showError(err.message);
  }
}

async function createResearchDraft() {
  showError("");
  try {
    const citations = document
      .getElementById("researchCitations")
      .value.split("\n")
      .map((c) => c.trim())
      .filter(Boolean);
    await api(`/api/drafting/matters/${encodeURIComponent(requiredDraftingMatterId())}/draft-research`, {
      method: "POST",
      body: JSON.stringify({ content: document.getElementById("researchContent").value, citations }),
    });
    document.getElementById("researchContent").value = "";
    document.getElementById("researchCitations").value = "";
    await loadMatterDrafts();
    showToast("Research summary drafted.", "success");
  } catch (err) {
    showError(err.message);
  }
}

async function createBillingDraft() {
  showError("");
  try {
    await api(`/api/drafting/matters/${encodeURIComponent(requiredDraftingMatterId())}/draft-billing`, {
      method: "POST",
      body: JSON.stringify({ content: document.getElementById("billingContent").value }),
    });
    document.getElementById("billingContent").value = "";
    await loadMatterDrafts();
    showToast("Billing narrative drafted.", "success");
  } catch (err) {
    showError(err.message);
  }
}

document.getElementById("loadMatterDrafts").addEventListener("click", loadMatterDrafts);
document.getElementById("createTemplateDraft").addEventListener("click", createTemplateDraft);
document.getElementById("createRiskDraft").addEventListener("click", createRiskDraft);
document.getElementById("createResearchDraft").addEventListener("click", createResearchDraft);
document.getElementById("createBillingDraft").addEventListener("click", createBillingDraft);
document.getElementById("navDrafting").addEventListener("click", () => {
  loadTemplates();
  loadMatterDrafts();
});

/* ===== Cases ===== */
async function loadCases() {
  showError("");
  document.getElementById("caseDetail").innerHTML = "";
  try {
    const items = await api("/api/cases");
    const list = document.getElementById("casesList");
    list.innerHTML = "";
    for (const item of items) {
      const li = document.createElement("li");
      li.innerHTML = `<strong>Matter ${escapeHtml(item.matterId)}</strong>
        <span class="badge">${item.workProductCount} work product</span>
        <span class="badge">${item.documentCount} document${item.documentCount === 1 ? "" : "s"}</span>`;
      li.addEventListener("click", () => loadCaseDetail(item.matterId));
      list.appendChild(li);
    }
    if (items.length === 0) {
      list.innerHTML = emptyHero(ICON_TRAY, "No cases yet", "Draft something or upload a document to a matter to see it here.");
    }
  } catch (err) {
    showError(err.message);
  }
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

async function downloadDocument(matterId, doc) {
  showError("");
  try {
    const full = await api(`/api/documents/matters/${encodeURIComponent(matterId)}/${doc.id}`);
    const link = document.createElement("a");
    link.href = `data:${full.contentType};base64,${full.content}`;
    link.download = full.fileName;
    link.click();
  } catch (err) {
    showError(err.message);
  }
}

/* ===== Matter timeline =====
   One history across every panel. Each entry carries the panel that owns
   it; opening one puts this matter in that panel's matter field and loads
   it, so the jump lands on the record rather than an empty form. */
const TIMELINE_KIND_LABEL = {
  matter: "matter",
  work_product: "draft",
  document: "document",
  deadline: "deadline",
  appointment: "appointment",
  invoice: "invoice",
  payment: "payment",
  trust: "trust",
  client_message: "message",
  signature: "signature",
};
const PANEL_MATTER_FIELD = {
  drafting: ["draftingMatterId", "loadMatterDrafts"],
  scheduling: ["scheduleListMatterId", "refreshAppointments"],
  invoices: ["invoiceMatterId", "loadInvoices"],
  trust: ["trustMatterId", "loadTrustLedger"],
  signatures: ["signaturesMatterId", "loadSignatures"],
  conflicts: ["matterRecordId", "loadMatterRecord"],
  deadlines: ["deadlineMatterId", null],
};

function openMatterIn(panel, matterId) {
  goToPanel(panel);
  const [fieldId, loadId] = PANEL_MATTER_FIELD[panel] || [];
  const field = fieldId && document.getElementById(fieldId);
  if (!field) return;
  field.value = matterId;
  if (loadId) document.getElementById(loadId)?.click();
  field.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

function timelineWhen(at) {
  if (!at) return "date not recorded";
  const d = new Date(at);
  return `${d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} · ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

async function loadMatterTimeline(matterId) {
  const list = document.getElementById("caseTimeline");
  if (!list) return;
  const result = await tryApi(`/api/cases/${encodeURIComponent(matterId)}/timeline`);
  if (!result) {
    list.closest(".card").hidden = true;
    return;
  }
  list.innerHTML = "";
  for (const item of result.items) {
    const li = document.createElement("li");
    li.className = `timeline-item timeline-${item.kind}`;
    li.innerHTML = `<time${item.at ? ` datetime="${escapeHtml(item.at)}"` : ""}>${escapeHtml(timelineWhen(item.at))}</time>
      <div class="timeline-body"><span class="badge">${escapeHtml(TIMELINE_KIND_LABEL[item.kind] || item.kind)}</span>
      <strong>${escapeHtml(item.title)}</strong>${item.scheduledFor ? `<div class="meta-tight">For ${escapeHtml(timelineWhen(item.scheduledFor))}</div>` : ""}${item.detail ? `<div class="meta-tight">${escapeHtml(item.detail)}</div>` : ""}</div>`;
    // Documents and messages live on this same page; everything else opens its panel.
    if (item.panel !== "cases") {
      const open = document.createElement("button");
      open.className = "matter-link timeline-open";
      open.textContent = `Open in ${PANEL_TITLES[item.panel] || item.panel}`;
      open.addEventListener("click", () => openMatterIn(item.panel, matterId));
      const actions = document.createElement("div");
      actions.className = "timeline-actions";
      actions.appendChild(open);
      li.querySelector(".timeline-body").appendChild(actions);
    }
    list.appendChild(li);
  }
  if (result.items.length === 0) list.innerHTML = '<li class="timeline-empty">Nothing on file for this matter yet.</li>';
  if (result.truncated) {
    const more = document.createElement("li");
    more.className = "timeline-empty";
    more.textContent = `Showing the newest ${result.items.length} entries.`;
    list.appendChild(more);
  }
}

async function loadCaseDetail(matterId) {
  showError("");
  try {
    const detail = await api(`/api/cases/${encodeURIComponent(matterId)}`);
    const el = document.getElementById("caseDetail");
    el.innerHTML = `
      <div class="card">
        <h3>Matter ${escapeHtml(matterId)}</h3>
        <div class="field-row">
          <label class="field grow">Upload a document
            <input id="caseUploadFile" type="file" />
          </label>
          <button class="btn primary" id="caseUploadBtn">Upload</button>
        </div>
        <div id="uploadLimitNote" class="meta"></div>
      </div>
      <div class="card">
        <h3>Documents</h3>
        <ul id="caseDocuments" class="list"></ul>
      </div>
      <div class="card">
        <h3>Work product</h3>
        <ul id="caseWorkProducts" class="list"></ul>
      </div>
      <div class="card">
        <h3>Client messages</h3>
        <p class="subtitle-inline">A thread with whichever client accounts are granted this matter's portal access — not privileged the way a note to file is, since the client reads it too.</p>
        <ul id="caseMessageThread" class="list"></ul>
        <div class="field-row mt-sm">
          <label class="field grow">Reply <input id="caseMessageBody" type="text" maxlength="10000" placeholder="Type a message…" /></label>
          <button class="btn primary" id="caseMessageSend">Send</button>
        </div>
      </div>
      <div class="card">
        <h3>Timeline</h3>
        <p class="subtitle-inline">Everything on file for this matter, newest first — each entry opens the panel it belongs to. Only what you can already see on those panels appears here.</p>
        <ol id="caseTimeline" class="timeline"></ol>
      </div>
    `;

    loadMatterTimeline(matterId);
    await loadMessageThread(matterId, "caseMessageThread");
    document.getElementById("caseMessageSend").addEventListener("click", () =>
      sendMessage(matterId, "caseMessageBody", "caseMessageThread"),
    );
    document.getElementById("caseMessageBody").addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendMessage(matterId, "caseMessageBody", "caseMessageThread");
    });

    if (currentRole === "attorney") {
      const exportBtn = mkButton("Export client file", async () => {
        showError("");
        try {
          const bundle = await api(`/api/client-file/${encodeURIComponent(matterId)}`);
          // Download as JSON rather than rendering: this is the client's
          // file, meant to leave the system intact.
          const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
          const link = document.createElement("a");
          link.href = URL.createObjectURL(blob);
          link.download = `client-file-${matterId}.json`;
          link.click();
          URL.revokeObjectURL(link.href);
          const c = bundle.counts;
          showError(
            `Exported: ${c.workProducts} work product, ${c.documents} document(s), ${c.researchReferences} reference(s), ` +
              `${c.billingHours} time entr(ies), ${c.trustEntries} trust entr(ies). Review before producing — see the notice in the file.`,
          );
        } catch (err) {
          showError(err.message);
        }
      });
      document.querySelector("#caseDetail .card .field-row").appendChild(exportBtn);
    }

    api("/api/documents/limits")
      .then((limits) => {
        document.getElementById("uploadLimitNote").textContent = `Max upload size: ${formatBytes(limits.maxUploadBytes)} per file.`;
      })
      .catch(() => {});

    const docList = document.getElementById("caseDocuments");
    docList.innerHTML = "";
    for (const doc of detail.documents) {
      const isPdf = doc.contentType === "application/pdf" || doc.fileName.toLowerCase().endsWith(".pdf");
      const li = document.createElement("li");
      li.classList.add("static");
      li.innerHTML = `<strong>${escapeHtml(doc.fileName)}</strong>
        <span class="badge">${formatBytes(doc.size)}</span>
        ${doc.visibleToClient ? `<span class="badge approved">shared with client</span>` : ""}
        ${doc.uploadedByClient ? `<span class="badge pending_review">submitted by client</span>` : ""}
        <div class="meta">Uploaded by ${escapeHtml(doc.uploadedBy)} on ${new Date(doc.uploadedAt).toLocaleString()}</div>`;
      const downloadBtn = mkButton("Download", () => downloadDocument(matterId, doc));
      li.appendChild(document.createElement("br"));
      li.appendChild(downloadBtn);
      const shareBtn = mkButton(doc.visibleToClient ? "Unshare with client" : "Share with client", async () => {
        showError("");
        try {
          await api(`/api/documents/matters/${encodeURIComponent(matterId)}/${doc.id}/client-visibility`, {
            method: "POST",
            body: JSON.stringify({ visible: !doc.visibleToClient }),
          });
          await loadCaseDetail(matterId);
          showToast(doc.visibleToClient ? "No longer shared with client." : "Shared with client.", "success");
        } catch (err) {
          showError(err.message);
        }
      });
      li.appendChild(shareBtn);
      if (isPdf) {
        const draftReportBtn = mkButton("Draft report from this PDF", async () => {
          showError("");
          try {
            draftReportBtn.disabled = true;
            await api(`/api/pdf-reports/matters/${encodeURIComponent(matterId)}/${doc.id}/draft-report`, { method: "POST" });
            await loadCaseDetail(matterId);
            showToast("Report drafted from PDF.", "success");
          } catch (err) {
            showError(err.message);
          } finally {
            draftReportBtn.disabled = false;
          }
        });
        draftReportBtn.classList.add("primary");
        const condenseBtn = mkButton("Condense", async () => {
          showError("");
          try {
            condenseBtn.disabled = true;
            const result = await api(`/api/pdf-reports/matters/${encodeURIComponent(matterId)}/${doc.id}/condense`, { method: "POST" });
            await loadCaseDetail(matterId);
            showError(
              `Condensed '${result.originalDocument.fileName}': ${formatBytes(result.originalBytes)} -> ${formatBytes(result.condensedBytes)}, ` +
                `saved as a new document '${result.condensedDocument.fileName}'.`,
            );
          } catch (err) {
            showError(err.message);
          } finally {
            condenseBtn.disabled = false;
          }
        });
        li.append(draftReportBtn, condenseBtn);
      }
      docList.appendChild(li);
    }
    if (detail.documents.length === 0) docList.innerHTML = '<li class="static empty">No documents uploaded yet.</li>';

    const wpList = document.getElementById("caseWorkProducts");
    wpList.innerHTML = "";
    for (const wp of detail.workProducts) {
      const li = document.createElement("li");
      li.classList.add("static");
      li.innerHTML = `<strong>${escapeHtml(wp.kind)}</strong>
        <span class="badge ${wp.status}">${wp.status}</span>
        ${wp.flags.length ? `<div class="flags">Unresolved flags: ${escapeHtml(wp.flags.join(", "))}</div>` : ""}`;
      wpList.appendChild(li);
    }
    if (detail.workProducts.length === 0) wpList.innerHTML = '<li class="static empty">No drafted work product on this matter yet.</li>';

    document.getElementById("caseUploadBtn").addEventListener("click", async () => {
      showError("");
      try {
        const fileInput = document.getElementById("caseUploadFile");
        const file = fileInput.files[0];
        if (!file) throw new Error("choose a file first");
        const content = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(",")[1] || "");
          reader.onerror = () => reject(new Error("could not read file"));
          reader.readAsDataURL(file);
        });
        await api(`/api/documents/matters/${encodeURIComponent(matterId)}`, {
          method: "POST",
          body: JSON.stringify({ fileName: file.name, contentType: file.type, content }),
        });
        await loadCases();
        await loadCaseDetail(matterId);
        showToast("Document uploaded.", "success");
      } catch (err) {
        showError(err.message);
      }
    });
  } catch (err) {
    showError(err.message);
  }
}

document.getElementById("refreshCases").addEventListener("click", loadCases);
document.getElementById("navCases").addEventListener("click", loadCases);

/* ===== Signatures =====
   Getting an already-uploaded PDF or an attorney-released draft actually
   signed. The signer never logs in — they open a bare token link
   (`sign.html?token=...`) this panel hands back right after "Send for
   signature", since no SMTP transport may be configured to email it. */
function signaturesMatterId() {
  return document.getElementById("signaturesMatterId").value;
}

// The matter's uploaded PDFs and released drafts, cached client-side so
// switching the "Source" dropdown re-populates "Document/draft" without
// a round trip — the same reasoning `refreshMatterOptions`'s datalist
// caching already uses.
let sigDocuments = [];
let sigReleasedDrafts = [];

async function loadSignatureSources() {
  const matterId = signaturesMatterId().trim();
  if (!matterId) return;
  try {
    const [docs, drafts] = await Promise.all([
      api(`/api/documents/matters/${encodeURIComponent(matterId)}`),
      api(`/api/drafting/matters/${encodeURIComponent(matterId)}`),
    ]);
    sigDocuments = docs.filter((d) => d.contentType === "application/pdf" || d.fileName.toLowerCase().endsWith(".pdf"));
    sigReleasedDrafts = drafts.filter((d) => d.status === "released");
    renderSigSourceOptions();
  } catch (err) {
    showError(err.message);
  }
}

function renderSigSourceOptions() {
  const kind = document.getElementById("sigSourceKind").value;
  const select = document.getElementById("sigSourceId");
  select.innerHTML = "";
  const options = kind === "document" ? sigDocuments.map((d) => ({ id: d.id, label: d.fileName })) : sigReleasedDrafts.map((d) => ({ id: d.id, label: `${d.kind} (${d.id})` }));
  if (options.length === 0) {
    select.innerHTML = `<option value="">${kind === "document" ? "No uploaded PDFs on this matter" : "No released drafts on this matter"}</option>`;
    return;
  }
  for (const opt of options) {
    const el = document.createElement("option");
    el.value = opt.id;
    el.textContent = opt.label;
    select.appendChild(el);
  }
}

document.getElementById("sigSourceKind").addEventListener("change", renderSigSourceOptions);
document.getElementById("loadSignatures").addEventListener("click", async () => {
  await loadSignatureSources();
  await loadSignatures();
});

// The signers being built up for the next "Send for signature" — held
// client-side until send, same pattern as the matter record's key dates.
let currentSigners = [];

function renderSignerRows() {
  const list = document.getElementById("sigSignersList");
  list.innerHTML = "";
  currentSigners.forEach((signer, i) => {
    const row = document.createElement("div");
    row.className = "field-row signer-row";
    row.innerHTML = `
      <label class="field">Name <input type="text" maxlength="200" value="${escapeHtml(signer.name)}" data-signer-field="name" /></label>
      <label class="field">Email <input type="email" value="${escapeHtml(signer.email)}" data-signer-field="email" /></label>
    `;
    row.querySelector('[data-signer-field="name"]').addEventListener("input", (e) => { currentSigners[i].name = e.target.value; });
    row.querySelector('[data-signer-field="email"]').addEventListener("input", (e) => { currentSigners[i].email = e.target.value; });
    const remove = mkButton("Remove", () => {
      currentSigners.splice(i, 1);
      renderSignerRows();
    });
    remove.classList.add("danger");
    row.appendChild(remove);
    list.appendChild(row);
  });
  if (currentSigners.length === 0) list.innerHTML = '<p class="meta">No signers added yet.</p>';
}

document.getElementById("addSigner").addEventListener("click", () => {
  currentSigners.push({ name: "", email: "" });
  renderSignerRows();
});
renderSignerRows();

function sigStatusBadgeClass(status) {
  if (status === "completed" || status === "signed") return "approved";
  if (status === "voided" || status === "declined") return "rejected";
  return "pending_review";
}

async function loadSignatures() {
  showError("");
  const matterId = signaturesMatterId().trim();
  const list = document.getElementById("signaturesList");
  if (!matterId) {
    list.innerHTML = '<li class="static empty">Enter a matter ID above to see its signature requests.</li>';
    return;
  }
  try {
    const envelopes = await api(`/api/esignature/matters/${encodeURIComponent(matterId)}`);
    list.innerHTML = "";
    for (const envelope of envelopes) {
      const li = document.createElement("li");
      li.classList.add("static");
      const signerRows = envelope.signers
        .map((s) => `${escapeHtml(s.name)} &lt;${escapeHtml(s.email)}&gt; <span class="badge ${sigStatusBadgeClass(s.status)}">${s.status}</span>`)
        .join("<br>");
      li.innerHTML = `
        <strong>${escapeHtml(envelope.title)}</strong>
        <span class="badge ${sigStatusBadgeClass(envelope.status)}">${envelope.status}</span>
        ${envelope.voidReason ? `<div class="meta">Void reason: ${escapeHtml(envelope.voidReason)}</div>` : ""}
        <div class="mt-xs">${signerRows}</div>
        <div class="actions mt-sm" data-actions></div>
      `;
      const actions = li.querySelector("[data-actions]");
      if (envelope.status === "completed") {
        actions.appendChild(mkButton("Download final PDF", async () => {
          showError("");
          try {
            const res = await fetch(`/api/esignature/matters/${encodeURIComponent(matterId)}/${envelope.id}/final-pdf`, { credentials: "same-origin" });
            if (res.status === 401) { window.location.href = "/login.html"; return; }
            if (!res.ok) { showError((await res.json()).error || res.statusText); return; }
            const disposition = res.headers.get("content-disposition") || "";
            const name = /filename="([^"]+)"/.exec(disposition)?.[1] || `${envelope.id}.pdf`;
            const url = URL.createObjectURL(await res.blob());
            const link = document.createElement("a");
            link.href = url;
            link.download = name;
            link.click();
            URL.revokeObjectURL(url);
          } catch (err) {
            showError(err.message);
          }
        }));
      }
      if (envelope.status === "sent" && currentRole === "attorney") {
        const voidBtn = mkButton("Void", async () => {
          const reason = prompt("Reason for withdrawing this signature request?") || "";
          if (!reason.trim()) return;
          showError("");
          try {
            await api(`/api/esignature/matters/${encodeURIComponent(matterId)}/${envelope.id}/void`, {
              method: "POST",
              body: JSON.stringify({ reason }),
            });
            await loadSignatures();
            showToast("Signature request withdrawn.", "success");
          } catch (err) {
            showError(err.message);
          }
        });
        voidBtn.classList.add("danger");
        actions.appendChild(voidBtn);
      }
      list.appendChild(li);
    }
    if (envelopes.length === 0) list.innerHTML = '<li class="static empty">No signature requests on this matter yet.</li>';
  } catch (err) {
    showError(err.message);
  }
}

document.getElementById("sendForSignature").addEventListener("click", async () => {
  showError("");
  const resultEl = document.getElementById("sigSendResult");
  resultEl.innerHTML = "";
  const matterId = signaturesMatterId().trim();
  if (!matterId) { showError("Enter a matter ID first."); return; }
  const sourceId = document.getElementById("sigSourceId").value;
  if (!sourceId) { showError("Pick a document or draft to send."); return; }
  const signers = currentSigners.filter((s) => s.name.trim() && s.email.trim());
  if (signers.length === 0) { showError("Add at least one signer with a name and email."); return; }
  try {
    const result = await api(`/api/esignature/matters/${encodeURIComponent(matterId)}`, {
      method: "POST",
      body: JSON.stringify({
        title: document.getElementById("sigTitle").value,
        sourceKind: document.getElementById("sigSourceKind").value,
        sourceId,
        signers,
      }),
    });
    currentSigners = [];
    renderSignerRows();
    document.getElementById("sigTitle").value = "";
    await loadSignatures();
    const links = result.envelope.signers
      .map((s) => `${escapeHtml(s.name)}: <code>${escapeHtml(result.signingUrls[s.id])}</code>`)
      .join("<br>");
    resultEl.innerHTML = `<div class="card">
      <p class="meta">${result.emailed ? "Emailed to every signer." : "No email transport configured — share these links yourself:"}</p>
      <div class="mt-xs">${links}</div>
    </div>`;
    showToast("Sent for signature.", "success");
  } catch (err) {
    showError(err.message);
  }
});

/* ===== Research ===== */
async function searchResearch() {
  showError("");
  try {
    const query = document.getElementById("researchQuery").value.trim();
    if (!query) return;
    const results = await api(`/api/research/search?q=${encodeURIComponent(query)}`);
    const list = document.getElementById("researchResults");
    list.innerHTML = "";
    for (const result of results) {
      const li = document.createElement("li");
      li.classList.add("static");
      li.innerHTML = `<strong>${escapeHtml(result.caseName)}</strong>
        ${result.citations.length ? `<span class="badge">${escapeHtml(result.citations.join(", "))}</span>` : ""}
        ${result.court ? `<div class="meta">${escapeHtml(result.court)}${result.dateFiled ? ` — ${escapeHtml(result.dateFiled)}` : ""}</div>` : ""}
        ${result.snippet ? `<div class="body-sm">${escapeHtml(result.snippet)}</div>` : ""}
        ${safeUrl(result.url) ? `<div class="mt-md"><a href="${escapeHtml(safeUrl(result.url))}" target="_blank" rel="noopener">View on CourtListener</a></div>` : ""}`;
      const saveBtn = mkButton("Save to matter", async () => {
        showError("");
        try {
          const matterId = document.getElementById("researchMatterId").value;
          await api(`/api/research/matters/${encodeURIComponent(matterId)}`, {
            method: "POST",
            body: JSON.stringify({
              citation: result.citations.join(", ") || result.caseName,
              title: result.caseName,
              url: result.url,
            }),
          });
          await loadResearchMatter();
          showToast("Saved to matter.", "success");
        } catch (err) {
          showError(err.message);
        }
      });
      saveBtn.classList.add("primary");
      li.appendChild(saveBtn);
      list.appendChild(li);
    }
    if (results.length === 0) list.innerHTML = '<li class="static empty">No results.</li>';
  } catch (err) {
    showError(err.message);
  }
}

async function loadResearchMatter() {
  showError("");
  const matterId = document.getElementById("researchMatterId").value.trim();
  const list = document.getElementById("researchSavedList");
  if (!matterId) {
    list.innerHTML = '<li class="static empty">Enter a matter ID above to see its saved references.</li>';
    return;
  }
  try {
    const refs = await api(`/api/research/matters/${encodeURIComponent(matterId)}`);
    list.innerHTML = "";
    for (const ref of refs) {
      const li = document.createElement("li");
      li.classList.add("static");
      li.innerHTML = `<strong>${escapeHtml(ref.title)}</strong>
        <span class="badge">${escapeHtml(ref.citation)}</span>
        <div class="meta">Saved by ${escapeHtml(ref.savedBy)} on ${new Date(ref.savedAt).toLocaleString()}</div>
        ${safeUrl(ref.url) ? `<div class="mt-sm"><a href="${escapeHtml(safeUrl(ref.url))}" target="_blank" rel="noopener">View source</a></div>` : ""}`;
      const removeBtn = mkButton("Remove", async () => {
        showError("");
        try {
          await api(`/api/research/matters/${encodeURIComponent(matterId)}/${ref.id}`, { method: "DELETE" });
          await loadResearchMatter();
          showToast("Reference removed.", "success");
        } catch (err) {
          showError(err.message);
        }
      });
      removeBtn.classList.add("danger");
      li.appendChild(document.createElement("br"));
      li.appendChild(removeBtn);
      list.appendChild(li);
    }
    if (refs.length === 0) list.innerHTML = '<li class="static empty">No saved references for this matter yet.</li>';
  } catch (err) {
    showError(err.message);
  }
}

document.getElementById("researchSearchBtn").addEventListener("click", searchResearch);
document.getElementById("researchQuery").addEventListener("keydown", (e) => {
  if (e.key === "Enter") searchResearch();
});
document.getElementById("loadResearchMatter").addEventListener("click", loadResearchMatter);
document.getElementById("navResearch").addEventListener("click", loadResearchMatter);

/* ===== Staff ===== */
async function loadStaff() {
  showError("");
  try {
    const members = await api("/api/staff");
    const list = document.getElementById("staffList");
    list.innerHTML = "";
    for (const member of members) {
      const li = document.createElement("li");
      li.classList.add("static");
      li.innerHTML = `<span class="badge">${escapeHtml(member.initials)}</span>
        <strong>${escapeHtml(member.displayName)}</strong>
        <span class="badge">${escapeHtml(member.role)}</span>
        ${member.disabled ? `<span class="badge rejected">disabled</span>` : ""}
        ${member.matterAssignment ? `<span class="badge confirmed">matter: ${escapeHtml(member.matterAssignment.matterId)}</span>` : ""}
        ${member.email ? `<span class="badge muted">${escapeHtml(member.email)}</span>` : ""}
        ${member.phone ? `<span class="badge muted">${escapeHtml(member.phone)}</span>` : ""}
        <div class="meta-tight">actor id: ${escapeHtml(member.actorId)} (username: ${escapeHtml(member.username)})</div>`;
      list.appendChild(li);
    }
    if (members.length === 0) list.innerHTML = '<li class="static empty">No staff yet.</li>';
  } catch (err) {
    showError(err.message);
  }
}

document.getElementById("refreshStaff").addEventListener("click", loadStaff);
document.getElementById("navStaff").addEventListener("click", loadStaff);

/* ===== Messages ===== */
let currentConversationId = null;

// Per-viewer "have I opened this conversation since its last message"
// state — same localStorage-convenience pattern as the theme preference.
// Never sent to the server: this is purely about what *this browser*
// has scrolled to, not a cross-user read receipt.
function lastSeenAt(conversationId) {
  try {
    return localStorage.getItem(`messagesLastSeen:${conversationId}`) || undefined;
  } catch {
    return undefined;
  }
}
function markConversationSeen(conversationId, at) {
  try {
    localStorage.setItem(`messagesLastSeen:${conversationId}`, at);
  } catch {
    // Private browsing / blocked storage — the unread marker just won't
    // clear for this viewer; nothing else depends on it.
  }
}

function appendMessageBubble(logId, message) {
  const log = document.getElementById(logId);
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const time = new Date(message.sentAt).toLocaleString();
  bubble.innerHTML = `<strong>${escapeHtml(message.senderName)}</strong> <span class="meta-xs">${time}</span><div>${escapeHtml(message.body)}</div>`;
  if (canUseSpeechTools()) {
    bubble.appendChild(listenButton(message.body));
  }
  log.appendChild(bubble);
  log.scrollTop = log.scrollHeight;
}

async function loadAnnouncements() {
  showError("");
  try {
    const messages = await api("/api/messages/announcements");
    const log = document.getElementById("announcementsLog");
    log.innerHTML = "";
    for (const message of messages) appendMessageBubble("announcementsLog", message);
    if (messages.length === 0) log.innerHTML = '<div class="bubble" class="faded">No announcements yet.</div>';
  } catch (err) {
    showError(err.message);
  }
}

async function postAnnouncement() {
  showError("");
  try {
    const input = document.getElementById("announcementText");
    const body = input.value.trim();
    if (!body) return;
    await api("/api/messages/announcements", { method: "POST", body: JSON.stringify({ body }) });
    input.value = "";
    await loadAnnouncements();
  } catch (err) {
    showError(err.message);
  }
}

async function loadConversations() {
  showError("");
  try {
    const conversations = await api("/api/messages/conversations");
    const list = document.getElementById("conversationList");
    list.innerHTML = "";
    for (const conversation of conversations) {
      if (conversation.kind === "announcement") continue;
      const li = document.createElement("li");
      li.classList.add("static");
      const label =
        conversation.kind === "group"
          ? conversation.name
          : conversation.participants.map((p) => p.displayName).join(", ");
      const unread = conversation.lastMessageAt && conversation.lastMessageAt > (lastSeenAt(conversation.id) || "");
      li.innerHTML = `<strong>${escapeHtml(label || "(conversation)")}</strong> <span class="badge">${escapeHtml(conversation.kind)}</span>${unread ? ' <span class="badge pending_review">new</span>' : ""}`;
      const openBtn = mkButton("Open", () => openConversation(conversation.id));
      li.appendChild(document.createElement("br"));
      li.appendChild(openBtn);
      list.appendChild(li);
    }
    if (list.innerHTML === "") list.innerHTML = '<li class="static empty">No conversations yet — start a DM or group above.</li>';
  } catch (err) {
    showError(err.message);
  }
}

async function openConversation(conversationId) {
  showError("");
  try {
    currentConversationId = conversationId;
    document.getElementById("conversationWindow").classList.remove("hidden");
    const messages = await api(`/api/messages/conversations/${conversationId}/messages`);
    const log = document.getElementById("conversationLog");
    log.innerHTML = "";
    for (const message of messages) appendMessageBubble("conversationLog", message);
    markConversationSeen(conversationId, messages.length > 0 ? messages[messages.length - 1].sentAt : new Date().toISOString());
    await loadConversations();
  } catch (err) {
    showError(err.message);
  }
}

async function sendConversationMessage() {
  showError("");
  try {
    if (!currentConversationId) return;
    const input = document.getElementById("conversationText");
    const body = input.value.trim();
    if (!body) return;
    await api(`/api/messages/conversations/${currentConversationId}/messages`, { method: "POST", body: JSON.stringify({ body }) });
    input.value = "";
    await openConversation(currentConversationId);
  } catch (err) {
    showError(err.message);
  }
}

document.getElementById("announcementSend").addEventListener("click", postAnnouncement);
document.getElementById("announcementText").addEventListener("keydown", (e) => {
  if (e.key === "Enter") postAnnouncement();
});
document.getElementById("conversationSend").addEventListener("click", sendConversationMessage);
document.getElementById("conversationText").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendConversationMessage();
});
document.getElementById("startDm").addEventListener("click", async () => {
  showError("");
  try {
    const otherActorId = document.getElementById("dmActorId").value.trim();
    if (!otherActorId) return;
    const conversation = await api("/api/messages/conversations/direct", { method: "POST", body: JSON.stringify({ otherActorId }) });
    document.getElementById("dmActorId").value = "";
    await openConversation(conversation.id);
  } catch (err) {
    showError(err.message);
  }
});
document.getElementById("startGroup").addEventListener("click", async () => {
  showError("");
  try {
    const name = document.getElementById("groupName").value.trim();
    const memberActorIds = [...document.getElementById("groupMembers").selectedOptions].map((o) => o.value);
    if (!name) return;
    const conversation = await api("/api/messages/conversations/group", { method: "POST", body: JSON.stringify({ name, memberActorIds }) });
    document.getElementById("groupName").value = "";
    for (const o of document.getElementById("groupMembers").options) o.selected = false;
    await openConversation(conversation.id);
  } catch (err) {
    showError(err.message);
  }
});
document.getElementById("refreshConversations").addEventListener("click", loadConversations);
document.getElementById("navMessages").addEventListener("click", () => {
  loadAnnouncements();
  loadConversations();
});

/* ===== Staff Schedule ===== */
function renderScheduleEntries(listId, entries, { showActorId }) {
  const list = document.getElementById(listId);
  list.innerHTML = "";
  for (const entry of entries) {
    const li = document.createElement("li");
    li.classList.add("static");
    li.innerHTML = `${showActorId ? `<strong>${escapeHtml(entry.actorId)}</strong> ` : ""}<span class="badge">${escapeHtml(entry.date)}</span>
      <span class="badge ${entry.status === "in_office" ? "approved" : entry.status === "remote" ? "pending_review" : "rejected"}">${escapeHtml(entry.status.replace("_", " "))}</span>
      ${entry.note ? `<div class="meta-tight">${escapeHtml(entry.note)}</div>` : ""}`;
    list.appendChild(li);
  }
  if (entries.length === 0) list.innerHTML = '<li class="static empty">No entries.</li>';
}

document.getElementById("setScheduleEntry").addEventListener("click", async () => {
  showError("");
  try {
    const actorId = document.getElementById("scheduleActorId").value.trim();
    const date = document.getElementById("scheduleDate").value;
    const status = document.getElementById("scheduleStatus").value;
    const note = document.getElementById("scheduleNote").value.trim();
    if (!actorId || !date) return;
    await api(`/api/staff-schedule/actor/${encodeURIComponent(actorId)}`, {
      method: "POST",
      body: JSON.stringify({ date, status, ...(note ? { note } : {}) }),
    });
    document.getElementById("scheduleNote").value = "";
    showToast("Schedule entry saved.", "success");
  } catch (err) {
    showError(err.message);
  }
});

document.getElementById("loadScheduleForDate").addEventListener("click", async () => {
  showError("");
  try {
    const date = document.getElementById("scheduleViewDate").value;
    if (!date) return;
    const entries = await api(`/api/staff-schedule/date/${encodeURIComponent(date)}`);
    renderScheduleEntries("scheduleForDateList", entries, { showActorId: true });
  } catch (err) {
    showError(err.message);
  }
});

document.getElementById("loadScheduleForActor").addEventListener("click", async () => {
  showError("");
  try {
    const actorId = document.getElementById("scheduleViewActorId").value.trim();
    if (!actorId) return;
    const entries = await api(`/api/staff-schedule/actor/${encodeURIComponent(actorId)}`);
    renderScheduleEntries("scheduleForActorList", entries, { showActorId: false });
  } catch (err) {
    showError(err.message);
  }
});

/* ===== Billing ===== */
let lastBillingMatterEntries = [];
let lastBillingMineEntries = [];

function renderBillingEntries(listId, entries, { showActorId }) {
  const list = document.getElementById(listId);
  list.innerHTML = "";
  let total = 0;
  for (const entry of entries) {
    total += entry.hours;
    const li = document.createElement("li");
    li.classList.add("static");
    li.innerHTML = `${showActorId ? `<strong>${escapeHtml(entry.actorId)}</strong> ` : ""}<span class="badge">${escapeHtml(entry.date)}</span>
      <span class="badge confirmed">${entry.hours}h</span>
      <div class="mt-xs">${escapeHtml(entry.description)}</div>`;
    list.appendChild(li);
  }
  if (entries.length === 0) {
    list.innerHTML = '<li class="static empty">No hours logged yet.</li>';
  } else {
    const totalLi = document.createElement("li");
    totalLi.classList.add("static");
    totalLi.innerHTML = `<strong>Total: ${total.toFixed(1)}h</strong>`;
    list.appendChild(totalLi);
  }
}

document.getElementById("logBillingHours").addEventListener("click", async () => {
  showError("");
  try {
    const matterId = document.getElementById("billingMatterId").value.trim();
    const date = document.getElementById("billingDate").value;
    const hours = Number(document.getElementById("billingHoursValue").value);
    const description = document.getElementById("billingDescription").value.trim();
    if (!matterId || !date || !hours || !description) return;
    await api(`/api/billing-hours/matters/${encodeURIComponent(matterId)}`, {
      method: "POST",
      body: JSON.stringify({ date, hours, description }),
    });
    document.getElementById("billingHoursValue").value = "";
    document.getElementById("billingDescription").value = "";
    await loadBillingMatter();
    await loadMyBillingHours();
    showToast("Hours logged.", "success");
  } catch (err) {
    showError(err.message);
  }
});

async function loadBillingMatter() {
  showError("");
  const matterId = document.getElementById("billingMatterId").value.trim();
  if (!matterId) {
    document.getElementById("billingMatterList").innerHTML = '<li class="static empty">Enter a matter ID above to see its logged hours.</li>';
    return;
  }
  try {
    const entries = await api(`/api/billing-hours/matters/${encodeURIComponent(matterId)}`);
    lastBillingMatterEntries = entries;
    renderBillingEntries("billingMatterList", entries, { showActorId: true });
  } catch (err) {
    showError(err.message);
  }
}

async function loadMyBillingHours() {
  showError("");
  try {
    const entries = await api("/api/billing-hours/mine");
    lastBillingMineEntries = entries;
    renderBillingEntries("billingMineList", entries, { showActorId: false });
  } catch (err) {
    showError(err.message);
  }
}

/** Shared by both billing-hours export buttons — same shape, different source list. */
function downloadBillingCsv(entries, filenamePrefix, { showActorId }) {
  showError("");
  if (entries.length === 0) {
    showError("Nothing to export — load some hours first.");
    return;
  }
  const header = [...(showActorId ? ["Logged by"] : []), "Matter ID", "Date", "Hours", "Description"];
  const rows = entries.map((e) => [...(showActorId ? [e.actorId] : []), e.matterId, e.date, e.hours, e.description]);
  downloadCsv(`${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
}

document.getElementById("loadBillingMatter").addEventListener("click", loadBillingMatter);
document.getElementById("loadMyBillingHours").addEventListener("click", loadMyBillingHours);
document.getElementById("downloadBillingMatterCsv").addEventListener("click", () =>
  downloadBillingCsv(lastBillingMatterEntries, "billing-hours-matter", { showActorId: true }),
);
document.getElementById("downloadBillingMineCsv").addEventListener("click", () =>
  downloadBillingCsv(lastBillingMineEntries, "billing-hours-mine", { showActorId: false }),
);
document.getElementById("navBilling").addEventListener("click", () => {
  loadBillingMatter();
  loadMyBillingHours();
});

/* ===== Assistant ===== */
let assistantSessionId = null;

function appendAssistantBubble(kind, text) {
  const log = document.getElementById("assistantLog");
  const bubble = document.createElement("div");
  bubble.className = `bubble ${kind}`;
  bubble.textContent = text;
  log.appendChild(bubble);
  log.scrollTop = log.scrollHeight;
}

async function startAssistant() {
  showError("");
  try {
    document.getElementById("assistantLog").innerHTML = "";
    const { sessionId } = await api("/api/assistant/start", { method: "POST", body: "{}" });
    assistantSessionId = sessionId;
    appendAssistantBubble("system", "New conversation started.");
    document.getElementById("assistantText").disabled = false;
    document.getElementById("assistantSend").disabled = false;
    document.getElementById("assistantText").focus();
  } catch (err) {
    showError(err.message);
  }
}

async function sendAssistantMessage() {
  const input = document.getElementById("assistantText");
  const text = input.value.trim();
  if (!text || !assistantSessionId) return;
  appendAssistantBubble("caller", text);
  input.value = "";
  showError("");
  const sendBtn = document.getElementById("assistantSend");
  sendBtn.disabled = true;
  try {
    const { reply } = await api(`/api/assistant/${assistantSessionId}/message`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    appendAssistantBubble("agent", reply);
  } catch (err) {
    showError(err.message);
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

document.getElementById("startAssistant").addEventListener("click", startAssistant);
document.getElementById("assistantSend").addEventListener("click", sendAssistantMessage);
document.getElementById("assistantText").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendAssistantMessage();
});

/* ===== Accounts ===== */
async function loadAccounts() {
  showError("");
  try {
    const accountsList = await api("/api/accounts");
    const list = document.getElementById("accountList");
    list.innerHTML = "";
    for (const acct of accountsList) {
      const li = document.createElement("li");
      li.classList.add("static");
      li.innerHTML = `<span class="status-dot ${acct.disabled ? "disabled" : ""}"></span><strong>${escapeHtml(acct.username)}</strong>
        <span class="muted">${escapeHtml(acct.displayName)}</span>
        <span class="badge">${acct.role}</span>
        <span class="badge ${acct.disabled ? "rejected" : "approved"}">${acct.disabled ? "disabled" : "enabled"}</span>
        ${acct.matterAssignment ? `<span class="badge confirmed">matter: ${escapeHtml(acct.matterAssignment.matterId)}</span>` : ""}
        ${acct.mustChangePassword ? `<span class="badge pending_review">password reset pending</span>` : ""}
        ${acct.mfaEnabled ? `<span class="badge approved">2FA (TOTP) · ${acct.recoveryCodesRemaining} codes left</span>` : ""}
        ${acct.passkeyCount > 0 ? `<span class="badge approved">${acct.passkeyCount} passkey${acct.passkeyCount === 1 ? "" : "s"}</span>` : ""}
        ${acct.email ? `<span class="badge muted">${escapeHtml(acct.email)}</span>` : `<span class="badge muted">no email on file</span>`}
        ${acct.phone ? `<span class="badge muted">${escapeHtml(acct.phone)}</span>` : ""}`;
      const toggleBtn = mkButton(acct.disabled ? "Enable" : "Disable", async () => {
        showError("");
        try {
          await api(`/api/accounts/${acct.id}/${acct.disabled ? "enable" : "disable"}`, { method: "POST", body: "{}" });
          await loadAccounts();
          showToast(acct.disabled ? `${acct.username} enabled.` : `${acct.username} disabled.`, "success");
        } catch (err) {
          showError(err.message);
        }
      });
      if (!acct.disabled) toggleBtn.classList.add("danger");
      const resetBtn = mkButton("Reset password", async () => {
        showError("");
        const newPassword = prompt(`New temporary password for ${acct.username} (8+ characters)?`);
        if (!newPassword) return;
        try {
          await api(`/api/accounts/${acct.id}/reset-password`, { method: "POST", body: JSON.stringify({ newPassword }) });
          await loadAccounts();
          showToast(`Password reset for ${acct.username}.`, "success");
        } catch (err) {
          showError(err.message);
        }
      });
      const emailBtn = mkButton(acct.email ? "Change email" : "Set email", async () => {
        showError("");
        // The deadline-alert digest (see CLAUDE.md's "Proactive deadline-risk alerts")
        // routes to this address for whichever matters name this account as the
        // responsible attorney — an empty value clears it rather than leaving the
        // previous one behind.
        const newEmail = prompt(`Email for ${acct.username}? (used to route the deadline-alert digest; leave blank to clear)`, acct.email || "");
        if (newEmail === null) return;
        try {
          await api(`/api/accounts/${acct.id}/set-email`, { method: "POST", body: JSON.stringify({ email: newEmail }) });
          await loadAccounts();
          showToast(newEmail ? `Email set for ${acct.username}.` : `Email cleared for ${acct.username}.`, "success");
        } catch (err) {
          showError(err.message);
        }
      });
      const phoneBtn = mkButton(acct.phone ? "Change phone" : "Set phone", async () => {
        showError("");
        // Surfaced as contact info in the Staff directory — leave blank to clear.
        const newPhone = prompt(`Phone for ${acct.username}? (shown in the Staff directory; leave blank to clear)`, acct.phone || "");
        if (newPhone === null) return;
        try {
          await api(`/api/accounts/${acct.id}/set-phone`, { method: "POST", body: JSON.stringify({ phone: newPhone }) });
          await loadAccounts();
          showToast(newPhone ? `Phone set for ${acct.username}.` : `Phone cleared for ${acct.username}.`, "success");
        } catch (err) {
          showError(err.message);
        }
      });
      li.appendChild(document.createElement("br"));
      li.append(toggleBtn, resetBtn, emailBtn, phoneBtn);

      // Only offered where there's something to clear. This is a real
      // bypass of someone else's second factor — the confirm spells that
      // out, and the action is recorded in the audit log either way.
      // Offered for TOTP *or* passkeys: resetMfa() clears both, since an
      // account can be locked out of either kind of factor (or both at
      // once), and this is the one escape hatch for all of them.
      if (acct.mfaEnabled || acct.passkeyCount > 0) {
        li.append(
          mkButton("Reset 2FA", async () => {
            showError("");
            if (!confirm(`Turn off two-factor authentication (TOTP and any passkeys) for ${acct.username}?\n\nThey will be able to sign in with their password alone until they set it up again. This is recorded in the audit log.`)) return;
            try {
              await api(`/api/accounts/${acct.id}/reset-mfa`, { method: "POST", body: "{}" });
              await loadAccounts();
              showToast(`Two-factor authentication reset for ${acct.username}.`, "success");
            } catch (err) {
              showError(err.message);
            }
          }),
        );
      }

      if (acct.role === "paralegal") {
        const matterInput = document.createElement("input");
        matterInput.placeholder = "matter id";
        matterInput.className = "matter-input";
        matterInput.value = acct.matterAssignment ? acct.matterAssignment.matterId : "";
        const assignBtn = mkButton("Assign", async () => {
          showError("");
          try {
            await api(`/api/accounts/${acct.id}/assign-matter`, {
              method: "POST",
              body: JSON.stringify({ matterId: matterInput.value }),
            });
            await loadAccounts();
            showToast(`${acct.username} assigned to ${matterInput.value}.`, "success");
          } catch (err) {
            showError(err.message);
          }
        });
        li.append(matterInput, assignBtn);
        if (acct.matterAssignment) {
          const unassignBtn = mkButton("Unassign", async () => {
            showError("");
            try {
              await api(`/api/accounts/${acct.id}/unassign-matter`, { method: "POST", body: "{}" });
              await loadAccounts();
              showToast(`${acct.username} unassigned.`, "success");
            } catch (err) {
              showError(err.message);
            }
          });
          unassignBtn.classList.add("danger");
          li.appendChild(unassignBtn);
        }
      }

      if (acct.role === "client") {
        // Additive, unlike a paralegal's one-matter-at-a-time slot: a
        // returning client reasonably has several matters over the years.
        const grants = document.createElement("div");
        grants.className = "mt-xs";
        for (const matterId of acct.clientMatterAccess || []) {
          const chip = document.createElement("span");
          chip.className = "badge confirmed mt-xs";
          chip.textContent = matterId + " ";
          const revokeLink = document.createElement("button");
          revokeLink.textContent = "×";
          revokeLink.className = "btn danger";
          revokeLink.title = `Revoke access to ${matterId}`;
          revokeLink.addEventListener("click", async () => {
            showError("");
            try {
              await api(`/api/accounts/${acct.id}/revoke-matter-access`, { method: "POST", body: JSON.stringify({ matterId }) });
              await loadAccounts();
              showToast(`Access to ${matterId} revoked.`, "success");
            } catch (err) {
              showError(err.message);
            }
          });
          chip.appendChild(revokeLink);
          grants.appendChild(chip);
        }
        li.appendChild(grants);

        const matterInput = document.createElement("input");
        matterInput.placeholder = "matter id";
        matterInput.className = "matter-input";
        matterInput.setAttribute("list", "matterOptions");
        const grantBtn = mkButton("Grant access", async () => {
          showError("");
          if (!matterInput.value.trim()) return;
          try {
            const grantedMatterId = matterInput.value.trim();
            await api(`/api/accounts/${acct.id}/grant-matter-access`, {
              method: "POST",
              body: JSON.stringify({ matterId: grantedMatterId }),
            });
            matterInput.value = "";
            await loadAccounts();
            showToast(`Access to ${grantedMatterId} granted.`, "success");
          } catch (err) {
            showError(err.message);
          }
        });
        li.append(matterInput, grantBtn);
      }
      list.appendChild(li);
    }
    if (accountsList.length === 0) list.innerHTML = '<li class="static empty">No accounts.</li>';
  } catch (err) {
    showError(err.message);
  }
}

async function createAccount() {
  showError("");
  try {
    const username = document.getElementById("newAccountUsername").value;
    const displayName = document.getElementById("newAccountDisplayName").value;
    const email = document.getElementById("newAccountEmail").value;
    const password = document.getElementById("newAccountPassword").value;
    const role = document.getElementById("newAccountRole").value;
    await api("/api/accounts", { method: "POST", body: JSON.stringify({ username, displayName, email, password, role }) });
    document.getElementById("newAccountUsername").value = "";
    document.getElementById("newAccountDisplayName").value = "";
    document.getElementById("newAccountEmail").value = "";
    document.getElementById("newAccountPassword").value = "";
    await loadAccounts();
    showToast(`Account created for ${username}.`, "success");
  } catch (err) {
    showError(err.message);
  }
}

document.getElementById("createAccount").addEventListener("click", createAccount);
document.getElementById("refreshAccounts").addEventListener("click", loadAccounts);
document.getElementById("navAccounts").addEventListener("click", loadAccounts);

/* ===== Import ===== */
// The file is read in the browser and sent as text; the server re-plans
// it from scratch on commit and refuses unless the plan matches the one
// on screen (`fingerprint`), so nothing here needs to be trusted.
const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
const IMPORT_ROWS_SHOWN = 300;
const IMPORT_TEMPLATES = {
  matters: ["Matter Number", "Matter Name", "Client", "Client Email", "Client Phone", "Adverse Party", "Status", "Responsible Attorney", "Practice Area", "Court", "Court Case Number", "Opposing Counsel", "Description", "Open Date", "Close Date"],
  time_entries: ["Date", "Matter", "Timekeeper", "Hours", "Description", "Billed"],
};
const IMPORT_KIND_HINTS = {
  matters: "One row per matter. Clients and adverse parties are screened for conflicts against everything already in Docket and against each other. Separate several names in one cell with a semicolon.",
  time_entries: "One row per entry. Import matters first: each entry is matched to a matter already in Docket, and credited to the attorney or paralegal account with that name.",
};
const importState = { csv: "", fileName: "", mapping: {}, plan: null };

function importKind() {
  return document.getElementById("importKind").value;
}

async function readImportFile(file) {
  // Exports from older Windows tools are often Windows-1252 rather than
  // UTF-8; read as UTF-8 first and fall back if that produced replacement
  // characters, so "Muñoz" doesn't arrive as "Mu�oz" and then fail to
  // match in a conflicts check.
  const buffer = await file.arrayBuffer();
  const utf8 = new TextDecoder("utf-8").decode(buffer);
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    return new TextDecoder("windows-1252").decode(buffer);
  } catch {
    return utf8;
  }
}

function resetImport(keepFile) {
  importState.mapping = {};
  importState.plan = null;
  if (!keepFile) {
    importState.csv = "";
    importState.fileName = "";
    document.getElementById("importFile").value = "";
  }
  document.getElementById("importPreviewCard").hidden = true;
  document.getElementById("importCommitCard").hidden = true;
  document.getElementById("importKindHint").textContent = IMPORT_KIND_HINTS[importKind()];
}

async function previewImport() {
  showError("");
  if (!importState.csv) return;
  const refresh = document.getElementById("importRefresh");
  refresh.disabled = true;
  try {
    importState.plan = await api("/api/import/preview", {
      method: "POST",
      body: JSON.stringify({ kind: importKind(), csv: importState.csv, mapping: importState.mapping, fileName: importState.fileName }),
    });
    renderImportPlan();
  } catch (err) {
    importState.plan = null;
    document.getElementById("importPreviewCard").hidden = true;
    document.getElementById("importCommitCard").hidden = true;
    showError(err.message);
  } finally {
    refresh.disabled = false;
  }
}

function renderImportPlan() {
  const plan = importState.plan;
  const isMatters = plan.kind === "matters";
  const noun = isMatters ? "matter" : "time entry";
  const plural = (n) => `${n} ${n === 1 ? noun : isMatters ? "matters" : "time entries"}`;
  document.getElementById("importPreviewCard").hidden = false;
  document.getElementById("importFileMeta").textContent = `${importState.fileName} · ${plan.rows.length || "no"} rows read`;

  const tiles = [
    ["To import", plan.counts.create],
    ["Skipped", plan.counts.skip],
    ["Problems", plan.counts.error],
  ];
  if (!isMatters) tiles.push(["Hours to import", plan.hoursToCreate ?? 0]);
  document.getElementById("importCounts").innerHTML = tiles
    .map(([k, n]) => `<div class="stat"><div class="n">${escapeHtml(String(n))}</div><div class="k">${escapeHtml(k)}</div></div>`)
    .join("");

  const notes = document.getElementById("importNotes");
  notes.innerHTML = "";
  const addNote = (text, kind) => {
    const li = document.createElement("li");
    li.className = kind;
    li.textContent = text;
    notes.appendChild(li);
  };
  if (plan.missingRequired.length) {
    addNote(`This file needs a column for: ${plan.missingRequired.join(", ")}. Choose one under "Columns" below.`, "bad");
  }
  if (plan.sourceGuess) addNote(`The column names look like a ${plan.sourceGuess} export.`, "info");
  for (const note of plan.notes) addNote(note, "warn");
  if (plan.needsConflictAcknowledgement) {
    addNote("Some of these matters may conflict with matters already in Docket or with each other. Read them below before importing.", "bad");
  }

  // Columns: a select per field, showing what was guessed.
  const grid = document.getElementById("importColumns");
  grid.innerHTML = "";
  for (const column of plan.columns) {
    const label = document.createElement("label");
    if (column.required) label.classList.add("required");
    if (!column.header) label.classList.add("unmapped");
    const span = document.createElement("span");
    span.textContent = column.label;
    const select = document.createElement("select");
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "(not in this file)";
    select.appendChild(none);
    for (const header of plan.headers) {
      if (!header) continue;
      const option = document.createElement("option");
      option.value = header;
      option.textContent = header;
      select.appendChild(option);
    }
    select.value = column.header || "";
    select.addEventListener("change", () => {
      importState.mapping[column.field] = select.value;
      previewImport();
    });
    label.append(span, select);
    grid.appendChild(label);
  }
  document.getElementById("importUnused").textContent = plan.unusedHeaders.length
    ? `Not imported: ${plan.unusedHeaders.join(", ")}.`
    : "Every column in the file is used.";
  // Open the column chooser when something essential is missing.
  if (plan.missingRequired.length) document.getElementById("importColumnsBox").open = true;

  renderImportRows();

  const commitCard = document.getElementById("importCommitCard");
  const canCommit = plan.counts.create > 0 && plan.missingRequired.length === 0;
  commitCard.hidden = !canCommit;
  if (canCommit) {
    const leftOut = plan.counts.error ? ` ${plan.counts.error} row${plan.counts.error === 1 ? "" : "s"} with problems will be left out — fix them in the file and import it again later; what's already imported will be skipped.` : "";
    const hours = isMatters ? "" : ` (${plan.hoursToCreate} hours)`;
    document.getElementById("importCommitSummary").textContent = `This will add ${plural(plan.counts.create)}${hours} and change nothing that's already in Docket.${leftOut}`;
    document.getElementById("importCommit").textContent = `Import ${plural(plan.counts.create)}`;
    const ack = document.getElementById("importAckField");
    ack.hidden = !plan.needsConflictAcknowledgement;
    document.getElementById("importAck").checked = false;
    document.getElementById("importCommit").disabled = plan.needsConflictAcknowledgement;
  }
}

const IMPORT_ACTION_BADGE = { create: ["approved", "import"], skip: ["muted", "skip"], error: ["rejected", "problem"] };
const CONFLICT_SEVERITY_LABEL = { direct: "direct conflict", former_client: "former client", same_side: "same side", informational: "note" };

function renderImportRows() {
  const plan = importState.plan;
  if (!plan) return;
  const filter = document.getElementById("importRowFilter").value;
  const rows = plan.rows.filter((r) =>
    filter === "all" ? true : filter === "conflict" ? Boolean(r.conflicts && r.conflicts.length) : r.action === filter,
  );
  // Problems and conflicts first: they're what needs reading.
  const rank = (r) => (r.action === "error" ? 0 : r.conflicts && r.conflicts.length ? 1 : r.action === "create" ? 2 : 3);
  rows.sort((a, b) => rank(a) - rank(b) || a.line - b.line);
  const list = document.getElementById("importRows");
  list.innerHTML = "";
  for (const row of rows.slice(0, IMPORT_ROWS_SHOWN)) {
    const li = document.createElement("li");
    li.classList.add("static");
    if (row.action === "error") li.classList.add("is-error");
    if (row.conflicts && row.conflicts.some((c) => c.severity === "direct" || c.severity === "former_client")) li.classList.add("is-conflict");
    const [badgeClass, badgeText] = IMPORT_ACTION_BADGE[row.action];
    li.innerHTML =
      `<span class="import-line">line ${row.line}</span>` +
      `<span class="import-what"><span class="badge ${badgeClass}">${badgeText}</span> <strong>${escapeHtml(row.summary)}</strong></span>` +
      (row.reason ? `<span class="import-reason">${escapeHtml(row.reason)}</span>` : "") +
      // Plain divs, not nested <li>s: `ul.list li` styles every descendant
      // item as a card, which would box each warning inside the row.
      (row.warnings.length ? `<div class="import-warnings">${row.warnings.map((w) => `<p>${escapeHtml(w)}</p>`).join("")}</div>` : "") +
      (row.conflicts && row.conflicts.length
        ? `<div class="import-conflicts">${row.conflicts
            .map(
              (c) =>
                `<div class="import-conflict"><span class="badge ${c.severity === "direct" || c.severity === "former_client" ? "rejected" : "muted"}">${escapeHtml(CONFLICT_SEVERITY_LABEL[c.severity] || c.severity)}</span> <strong>${escapeHtml(c.searchedName)}</strong> on ${escapeHtml(c.matterTitle)} (${escapeHtml(c.matterId)})<p>${escapeHtml(c.explanation)}</p></div>`,
            )
            .join("")}</div>`
        : "");
    list.appendChild(li);
  }
  if (rows.length === 0) {
    list.innerHTML = '<li class="static empty">Nothing in this view.</li>';
  }
  document.getElementById("importRowCount").textContent =
    rows.length > IMPORT_ROWS_SHOWN ? `Showing the first ${IMPORT_ROWS_SHOWN} of ${rows.length}.` : `${rows.length} row${rows.length === 1 ? "" : "s"}.`;
}

async function commitImport() {
  showError("");
  const plan = importState.plan;
  if (!plan) return;
  const button = document.getElementById("importCommit");
  button.disabled = true;
  try {
    const res = await fetch("/api/import/commit", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: plan.kind,
        csv: importState.csv,
        mapping: importState.mapping,
        fileName: importState.fileName,
        fingerprint: plan.fingerprint,
        acknowledgeConflicts: document.getElementById("importAck").checked,
      }),
    });
    if (res.status === 401) {
      window.location.href = "/login.html";
      return;
    }
    const body = await res.json();
    if (res.status === 409) {
      // Something moved since the preview: show the new plan rather than
      // importing anything the attorney hasn't looked at.
      showToast("Records changed since the preview — check the updated preview, then import again.", "error");
      await previewImport();
      return;
    }
    if (!res.ok) throw new Error(body.error || res.statusText);

    const isMatters = body.kind === "matters";
    const card = document.getElementById("importResultCard");
    card.hidden = false;
    const result = document.getElementById("importResult");
    result.innerHTML = "";
    const p = document.createElement("p");
    p.textContent = isMatters
      ? `${body.created} matter${body.created === 1 ? "" : "s"} imported${body.skipped ? `, ${body.skipped} already in Docket` : ""}${body.leftOut ? `, ${body.leftOut} left out` : ""}. Recorded in the audit log as ${body.importId}.`
      : `${body.created} time entr${body.created === 1 ? "y" : "ies"} imported (${body.hoursCreated} hours)${body.skipped ? `, ${body.skipped} skipped` : ""}${body.leftOut ? `, ${body.leftOut} left out` : ""}. Recorded in the audit log as ${body.importId}.`;
    result.appendChild(p);
    const next = document.createElement("div");
    next.className = "field-row";
    if (isMatters) {
      next.append(
        mkButton("Review them in Conflicts", () => goToPanel("conflicts")),
        mkButton("Import time entries next", () => {
          document.getElementById("importKind").value = "time_entries";
          resetImport(false);
        }),
      );
    } else {
      next.append(mkButton("Open Billing", () => goToPanel("billing")));
    }
    result.appendChild(next);
    showToast(isMatters ? `Imported ${body.created} matters.` : `Imported ${body.created} time entries.`, "success");
    refreshPickers();
    // Re-plan the same file, which now reads as "already in Docket" —
    // the plainest confirmation that it landed.
    await previewImport();
  } catch (err) {
    showError(err.message);
  } finally {
    if (importState.plan) button.disabled = importState.plan.needsConflictAcknowledgement && !document.getElementById("importAck").checked;
  }
}

document.getElementById("importKind").addEventListener("change", () => {
  resetImport(true);
  previewImport();
});
document.getElementById("importFile").addEventListener("change", async (e) => {
  showError("");
  const file = e.target.files && e.target.files[0];
  resetImport(true);
  document.getElementById("importResultCard").hidden = true;
  if (!file) return;
  if (file.size > IMPORT_MAX_BYTES) {
    showError("That file is larger than 5 MB. Split it and import the parts one at a time.");
    e.target.value = "";
    return;
  }
  importState.fileName = file.name;
  importState.csv = await readImportFile(file);
  await previewImport();
});
document.getElementById("importRefresh").addEventListener("click", previewImport);
document.getElementById("importRowFilter").addEventListener("change", renderImportRows);
document.getElementById("importAck").addEventListener("change", (e) => {
  document.getElementById("importCommit").disabled = !e.target.checked;
});
document.getElementById("importCommit").addEventListener("click", commitImport);
document.getElementById("importTemplate").addEventListener("click", () => {
  const kind = importKind();
  downloadCsv(kind === "matters" ? "docket-matters-template.csv" : "docket-time-entries-template.csv", IMPORT_TEMPLATES[kind], []);
});
document.getElementById("importKindHint").textContent = IMPORT_KIND_HINTS.matters;

/* ===== Analytics ===== */
function minutesLabel(minutes) {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

async function loadAnalytics() {
  showError("");
  try {
    const withinDays = document.getElementById("analyticsTrendDays").value;

    const [statusCounts, caseload, aging, hoursTrend, utilizationTrend] = await Promise.all([
      api("/api/analytics/matter-status"),
      api("/api/analytics/caseload"),
      api("/api/analytics/invoice-aging"),
      api(`/api/analytics/billable-hours-trend?withinDays=${withinDays}`),
      api(`/api/analytics/utilization-trend?withinDays=${withinDays}`),
    ]);

    const statusEl = document.getElementById("analyticsMatterStatus");
    statusEl.innerHTML = ["open", "prospective", "closed"]
      .map((status) => `<div class="stat"><div class="n">${statusCounts[status] ?? 0}</div><div class="k">${status}</div></div>`)
      .join("");

    const caseloadList = document.getElementById("analyticsCaseloadList");
    caseloadList.innerHTML = caseload.length
      ? caseload
          .map(
            (row) =>
              `<li class="static"><strong>${escapeHtml(row.displayName)}</strong> <span class="badge">${row.openMatters} open</span> <span class="badge muted">${row.closedMatters} closed</span></li>`,
          )
          .join("")
      : '<li class="static empty">No matters on file.</li>';

    const agingList = document.getElementById("analyticsAgingList");
    agingList.innerHTML = aging
      .map(
        (b) =>
          `<li class="static"><strong>${b.bucket === "current" ? "Not yet due" : `${b.bucket} days overdue`}</strong> <span class="badge ${b.bucket === "current" ? "approved" : b.count > 0 ? "rejected" : "muted"}">${b.count} invoice(s)</span> <span class="badge">${escapeHtml(centsToDollars(b.totalCents))}</span></li>`,
      )
      .join("");

    const hoursList = document.getElementById("analyticsHoursTrendList");
    hoursList.innerHTML = hoursTrend.length
      ? hoursTrend.map((d) => `<li class="static">${d.date} <span class="badge">${d.hours}h</span></li>`).join("")
      : '<li class="static empty">No billable hours logged in this window.</li>';

    const utilList = document.getElementById("analyticsUtilizationTrendList");
    utilList.innerHTML = utilizationTrend.length
      ? utilizationTrend
          .map((d) => {
            const badges = Object.entries(d.minutesByTaskType)
              .map(([type, minutes]) => `<span class="badge">${type}: ${minutesLabel(minutes)}</span>`)
              .join(" ");
            return `<li class="static">${d.date} ${badges}</li>`;
          })
          .join("")
      : '<li class="static empty">No completed AI-agent activity in this window.</li>';
  } catch (err) {
    showError(err.message);
  }
}

document.getElementById("refreshAnalytics").addEventListener("click", loadAnalytics);
document.getElementById("navAnalytics").addEventListener("click", loadAnalytics);
document.getElementById("analyticsTrendDays").addEventListener("change", loadAnalytics);

/* ===== Audit Log ===== */
// Kept around so "Download CSV" exports exactly what's on screen —
// the currently applied filters — without a second round trip.
let lastAuditEntries = [];

async function loadAudit() {
  showError("");
  try {
    const query = new URLSearchParams();
    const matterId = document.getElementById("auditMatterId").value.trim();
    const actorId = document.getElementById("auditActorId").value;
    const action = document.getElementById("auditAction").value.trim();
    const from = document.getElementById("auditFrom").value;
    const to = document.getElementById("auditTo").value;
    if (matterId) query.set("matterId", matterId);
    if (actorId) query.set("actorId", actorId);
    if (action) query.set("action", action);
    if (from) query.set("from", from);
    if (to) query.set("to", to);

    const entries = await api(`/api/audit${query.toString() ? `?${query}` : ""}`);
    lastAuditEntries = entries;
    const list = document.getElementById("auditList");
    document.getElementById("auditCount").textContent =
      `${entries.length} entr${entries.length === 1 ? "y" : "ies"}${query.toString() ? " matching" : ""}`;
    list.innerHTML = "";
    for (const entry of [...entries].reverse()) {
      const li = document.createElement("li");
      li.classList.add("static");
      const who = knownStaff.find((m) => m.actorId === entry.actor.id)?.displayName || entry.actor.id;
      li.innerHTML = `<strong>${escapeHtml(entry.action)}</strong>
        <span class="badge">${escapeHtml(who)} (${escapeHtml(entry.actor.role)})</span>
        ${entry.matterId ? `<span class="badge">matter ${escapeHtml(entry.matterId)}</span>` : ""}
        <div class="meta">${new Date(entry.timestamp).toLocaleString()} · #${entry.sequence}</div>
        ${entry.detail ? `<div class="body-sm">${escapeHtml(entry.detail)}</div>` : ""}
        ${renderChanges(entry.changes)}`;
      list.appendChild(li);
    }
    if (entries.length === 0) list.innerHTML = '<li class="static empty">No audit entries match.</li>';
  } catch (err) {
    showError(err.message);
  }
}

/** Field-level before/after, so an edit shows what actually changed. */
function renderChanges(changes) {
  if (!changes || changes.length === 0) return "";
  const rows = changes
    .map(
      (c) => `<tr>
        <td class="diff-field">${escapeHtml(c.field)}</td>
        <td class="diff-from">${c.from === undefined || c.from === null ? "<em>not set</em>" : escapeHtml(c.from)}</td>
        <td class="diff-to">${c.to === undefined || c.to === null ? "<em>cleared</em>" : escapeHtml(c.to)}</td>
      </tr>`,
    )
    .join("");
  return `<table class="diff"><thead><tr><th>Field</th><th>Was</th><th>Became</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/**
 * The anchoring half of the report. Kept visually distinct from the
 * chain result because it answers a different question: the chain says
 * "was this edited in place", anchoring says "is this the same log we
 * published a fingerprint of".
 */
function renderAnchoring(anchoring) {
  if (!anchoring || !anchoring.configured) {
    return `<p class="meta-tight mt-md">No external anchor is configured, so a log rebuilt wholesale would still verify.
      Set <code>AUDIT_ANCHOR_FILE</code> or <code>AUDIT_ANCHOR_EMAILS</code> to publish the head hash somewhere outside this database.</p>`;
  }
  const last = anchoring.lastAnchor;
  const when = last
    ? `Last anchored to <strong>${escapeHtml(anchoring.target)}</strong> at entry #${last.sequence}, ${new Date(last.anchoredAt).toLocaleString()}.`
    : `Anchoring to <strong>${escapeHtml(anchoring.target)}</strong> is configured, but nothing has been published yet.`;

  if (anchoring.ok) {
    return `<p class="${last ? "integrity-ok" : "meta-tight"} mt-md">${when}
      ${last ? `Checked against ${anchoring.anchorsChecked} published anchor${anchoring.anchorsChecked === 1 ? "" : "s"} — all match.` : ""}</p>`;
  }
  const rows = anchoring.mismatches
    .map(
      (m) =>
        `<li>Entry #${m.sequence}: ${
          m.kind === "missing"
            ? "the log is now shorter than this published anchor — entries were removed from the end"
            : "the entry at this position no longer hashes to what was published — history was rewritten"
        }<div class="meta-xs">published ${escapeHtml(m.expectedHash.slice(0, 24))}… · now ${escapeHtml((m.actualHash || "absent").slice(0, 24))}…</div></li>`,
    )
    .join("");
  return `<div class="flags mt-md"><strong>The log disagrees with what was published externally.</strong>
    <ul class="mt-xs">${rows}</ul>
    <div class="mt-xs">This is the stronger finding: the internal chain can be rebuilt by anyone with database access, but the published copy could not be. Preserve the current state and the anchor destination before doing anything else.</div></div>`;
}

async function anchorAuditNow() {
  showError("");
  const out = document.getElementById("auditIntegrity");
  out.innerHTML = "Publishing…";
  try {
    const result = await api("/api/audit/anchor", { method: "POST", body: "{}" });
    if (!result.anchored) {
      out.innerHTML = `<p class="meta-tight">Nothing anchored — ${escapeHtml(result.reason || "")}</p>`;
      return;
    }
    await verifyAuditIntegrity();
  } catch (err) {
    out.innerHTML = "";
    showError(err.message);
  }
}

async function verifyAuditIntegrity() {
  showError("");
  const out = document.getElementById("auditIntegrity");
  out.innerHTML = "Checking…";
  try {
    const report = await api("/api/audit/verify");
    const unchained = report.unchainedEntries
      ? ` ${report.unchainedEntries} older entr${report.unchainedEntries === 1 ? "y predates" : "ies predate"} hashing and can't be checked.`
      : "";
    const chain = report.ok
      ? `<p class="integrity-ok">Chain intact across ${report.entriesChecked} entries.${escapeHtml(unchained)}</p>`
      : `<div class="flags"><strong>The audit chain is broken at entry #${report.brokenAtSequence}.</strong>
           <div class="mt-xs">${escapeHtml(report.reason || "")}</div>
           <div class="mt-xs">Entries after this point can no longer be relied on as a complete record. Preserve the current state file before doing anything else.</div></div>`;
    out.innerHTML = chain + renderAnchoring(report.anchoring);
  } catch (err) {
    out.innerHTML = "";
    showError(err.message);
  }
}

/** Quotes a CSV field per RFC 4180 — only when it actually needs it. */
function csvField(value) {
  let s = value === undefined || value === null ? "" : String(value);
  // A cell starting with = + - @ (or a tab/CR) is run as a formula by
  // spreadsheet programs. Names and descriptions can come from imported
  // files or the public booking form, so neutralise them on the way out —
  // but leave plain numbers like "-4" (days overdue) alone.
  if (/^[=+\-@\t\r]/.test(s) && !/^[-+]?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Shared by every "Download CSV" button — builds, downloads, and revokes the blob URL. */
function downloadCsv(filename, header, rows) {
  const csv = [header, ...rows].map((row) => row.map(csvField).join(",")).join("\r\n");
  // A BOM so Excel (still the most common opener for a CSV like this)
  // detects UTF-8 instead of guessing a legacy codepage on accented names.
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function downloadAuditCsv() {
  showError("");
  if (lastAuditEntries.length === 0) {
    showError("Nothing to export — the current filter matches no entries.");
    return;
  }
  const header = ["Sequence", "Timestamp", "Action", "Actor name", "Actor role", "Matter ID", "Detail", "Changes"];
  const rows = [...lastAuditEntries].reverse().map((entry) => {
    const who = knownStaff.find((m) => m.actorId === entry.actor.id)?.displayName || entry.actor.id;
    const changes = (entry.changes || [])
      .map((c) => `${c.field}: ${c.from ?? "(not set)"} -> ${c.to ?? "(cleared)"}`)
      .join("; ");
    return [
      entry.sequence,
      new Date(entry.timestamp).toISOString(),
      entry.action,
      who,
      entry.actor.role,
      entry.matterId || "",
      entry.detail || "",
      changes,
    ];
  });
  downloadCsv(`audit-log-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
}

document.getElementById("downloadAuditCsv").addEventListener("click", downloadAuditCsv);
document.getElementById("refreshAudit").addEventListener("click", loadAudit);
document.getElementById("verifyAudit").addEventListener("click", verifyAuditIntegrity);
document.getElementById("anchorAudit").addEventListener("click", anchorAuditNow);
document.getElementById("clearAuditFilters").addEventListener("click", () => {
  for (const id of ["auditMatterId", "auditAction", "auditFrom", "auditTo"]) document.getElementById(id).value = "";
  document.getElementById("auditActorId").value = "";
  loadAudit();
});
document.getElementById("navAudit").addEventListener("click", () => {
  // "Everyone" has to be an explicit option — an empty <select> would
  // default to the first person and quietly filter the whole log.
  const picker = document.getElementById("auditActorId");
  const previous = picker.value;
  picker.innerHTML = '<option value="">everyone</option>';
  for (const m of knownStaff) {
    const opt = document.createElement("option");
    opt.value = m.actorId;
    opt.textContent = `${m.displayName} (${m.role})`;
    picker.appendChild(opt);
  }
  picker.value = previous;
  loadAudit();
});


/* ===== Home =====
   The app used to open on the Review Queue, which is attorney-only — so
   a paralegal or receptionist landed on "attorney-only" as their first
   impression. This panel is role-aware and only asks for data the
   current role can actually read, so nothing here 403s in the
   background. Every tile is best-effort: one unavailable surface must
   not blank out the rest of the page. */
function goToPanel(panel) {
  const btn = document.querySelector(`nav.nav button[data-panel="${panel}"]`);
  if (btn) {
    btn.click();
    return;
  }
  // "search" has no sidebar button at all (it's reached only via the
  // top-bar box or a deep link from a search hit) — without this
  // fallback, every caller of goToPanel("search") silently did nothing,
  // making the whole Search panel unreachable from the UI.
  for (const b of document.querySelectorAll("nav.nav button")) b.classList.remove("active");
  for (const s of document.querySelectorAll("section.panel")) s.classList.toggle("active", s.id === `panel-${panel}`);
  setPanelHeading(panel);
}

function statTile(n, label, { tone = "", panel = null } = {}) {
  const el = document.createElement("div");
  el.className = `stat ${tone}${panel ? " clickable" : ""}`.trim();
  // Tilts toward the pointer, with the figure lifted off the card (depth.js).
  el.dataset.tilt = "7";
  el.innerHTML = `<span class="sheen" aria-hidden="true"></span><div class="n">${escapeHtml(String(n))}</div><div class="k">${escapeHtml(label)}</div>`;
  if (panel) el.addEventListener("click", () => goToPanel(panel));
  return el;
}

function listRow(html) {
  const li = document.createElement("li");
  li.classList.add("static");
  li.innerHTML = html;
  return li;
}

/** Never throws: a panel the role can't see just contributes nothing. */
async function tryApi(path) {
  try {
    return await api(path);
  } catch {
    return null;
  }
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const GETTING_STARTED_DISMISSED_KEY = "docket.gettingStartedDismissed";

/**
 * A fading onboarding checklist on Home, not a server-tracked feature —
 * every item is derived from data the app already fetched for other
 * tiles (no extra round trip but one: email-transport status, which
 * nothing else on Home needed). Deliberately attorney-only: every item
 * here is an attorney-gated setup task (inviting the team, connecting
 * email) or reads as one (the firm's first real matter), so showing it
 * to a paralegal/receptionist would just be a checklist they can't act
 * on. Dismissal is stored in localStorage — a per-viewer convenience,
 * never anything the server needs to know or that other sessions share.
 */
function renderGettingStarted({ isAttorney, cases, emailTransport }) {
  const card = document.getElementById("gettingStartedCard");
  if (!isAttorney) {
    card.hidden = true;
    return;
  }
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(GETTING_STARTED_DISMISSED_KEY) === "true";
  } catch {
    // Private-window/blocked storage: just don't persist dismissal, never break the panel.
  }
  if (dismissed) {
    card.hidden = true;
    return;
  }

  const hasRealMatter = Array.isArray(cases) && cases.some((c) => !String(c.matterId).startsWith("demo-"));
  const items = [
    {
      done: knownStaff.length > 1,
      label: "Invite your team",
      detail: "Add a login for a colleague.",
      panel: "accounts",
    },
    {
      done: hasRealMatter,
      label: "Create your first matter",
      detail: "Record who the client and adverse parties are — the input to conflicts screening. Coming from another system? Import them instead.",
      panel: "conflicts",
      alsoPanel: { panel: "import", label: "Import" },
    },
    {
      done: emailTransport ? emailTransport.canSend : false,
      label: "Connect email",
      detail: "Needed to send invoices, appointment reminders, and the deadline-risk digest.",
      panel: null,
    },
  ];

  if (items.every((i) => i.done)) {
    card.hidden = true;
    return;
  }

  card.hidden = false;
  const list = document.getElementById("gettingStartedList");
  list.innerHTML = "";
  for (const item of items) {
    const li = document.createElement("li");
    li.classList.add("static");
    li.innerHTML = `<span class="badge ${item.done ? "approved" : "muted"}">${item.done ? "done" : "to do"}</span> <strong>${escapeHtml(item.label)}</strong> <span class="muted">${escapeHtml(item.detail)}</span>`;
    if (!item.done && item.panel) {
      const goBtn = mkButton("Go", () => goToPanel(item.panel));
      li.appendChild(goBtn);
    }
    if (!item.done && item.alsoPanel) {
      li.appendChild(mkButton(item.alsoPanel.label, () => goToPanel(item.alsoPanel.panel)));
    }
    list.appendChild(li);
  }
}

document.getElementById("dismissGettingStarted").addEventListener("click", () => {
  try {
    localStorage.setItem(GETTING_STARTED_DISMISSED_KEY, "true");
  } catch {
    // Nothing to fall back to — the card just won't remember the dismissal across a reload.
  }
  document.getElementById("gettingStartedCard").hidden = true;
});

async function loadHome() {
  const stats = document.getElementById("homeStats");
  const attention = document.getElementById("homeAttention");
  const today = document.getElementById("homeToday");
  if (!stats) return;

  const me = knownStaff.find((m) => m.actorId === currentActorId);
  const hour = new Date().getHours();
  const partOfDay = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const firstWord = me?.displayName?.trim().split(/\s+/)[0];
  // A display name defaults to the username, which is often lower case.
  const firstName = firstWord ? firstWord.charAt(0).toUpperCase() + firstWord.slice(1) : "";
  document.getElementById("homeHello").textContent = firstName ? `${partOfDay}, ${firstName}.` : `${partOfDay}.`;
  document.getElementById("homeGreeting").textContent = "Everything that needs you, in one place.";
  document.getElementById("homeDateline").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  // Shaped like what's about to arrive rather than a blank panel or the
  // word "Loading…" — sets the expectation that something is coming,
  // not that the page is stuck.
  stats.innerHTML = Array.from({ length: 4 }, () => '<div class="stat skeleton"><div class="n">&nbsp;</div><div class="k">&nbsp;</div></div>').join("");
  attention.innerHTML = Array.from({ length: 2 }, () => '<li class="static skeleton-row"></li>').join("");
  today.innerHTML = Array.from({ length: 2 }, () => '<li class="static skeleton-row"></li>').join("");

  const isAttorney = currentRole === "attorney";
  const canDraft = isAttorney || currentRole === "paralegal";

  const [pending, conflicts, upcoming, cases, myHours, announcements, schedule, clock, outstanding, emailTransport] = await Promise.all([
    isAttorney ? tryApi("/api/work-products?status=pending_review") : null,
    isAttorney ? tryApi("/api/deadlines/conflicts") : null,
    isAttorney ? tryApi("/api/deadlines/upcoming?withinDays=14") : null,
    canDraft ? tryApi("/api/cases") : null,
    canDraft ? tryApi("/api/billing-hours/mine") : null,
    tryApi("/api/messages/announcements"),
    tryApi(`/api/staff-schedule/date/${todayIso()}`),
    currentActorId ? tryApi(`/api/time-clock/actor/${encodeURIComponent(currentActorId)}/summary`) : null,
    canDraft ? tryApi("/api/invoices/outstanding") : null,
    canDraft ? tryApi("/api/invoices/email-transport") : null,
  ]);

  renderGettingStarted({ isAttorney, cases, emailTransport });

  stats.innerHTML = "";
  if (pending) stats.appendChild(statTile(pending.length, "awaiting your review", { tone: pending.length ? "alert" : "ok", panel: "queue" }));
  if (upcoming) {
    // Counts what's actually at risk, not everything on the calendar: a
    // confirmed date next week doesn't need a red number against it.
    const atRisk = upcoming.filter((d) => d.confirmationState !== "confirmed" || d.daysAway <= 3 || d.overdue).length;
    stats.appendChild(
      statTile(upcoming.length, atRisk ? `due in 14 days — ${atRisk} need attention` : "due in 14 days", {
        tone: atRisk ? "alert" : "ok",
        panel: "deadlines",
      }),
    );
  }
  if (conflicts) stats.appendChild(statTile(conflicts.length, "deadline conflicts", { tone: conflicts.length ? "alert" : "ok", panel: "deadlines" }));
  if (cases) stats.appendChild(statTile(cases.length, "active matters", { panel: "cases" }));
  if (myHours) {
    const total = myHours.reduce((sum, e) => sum + e.hours, 0);
    stats.appendChild(statTile(`${total.toFixed(1)}h`, "hours you've logged", { panel: "billing" }));
  }
  if (clock) {
    stats.appendChild(
      statTile(formatMs(clock.thisWeek ? clock.thisWeek.totalMs : 0), "clocked this week", {
        tone: clock.openShift ? "ok" : "",
        panel: "time-clock",
      }),
    );
  }
  if (outstanding) {
    const dueCents = outstanding.reduce((sum, r) => sum + r.totals.balanceCents, 0);
    const overdue = outstanding.filter((r) => r.daysOverdue > 0).length;
    stats.appendChild(
      statTile(centsToDollars(dueCents), overdue ? `outstanding — ${overdue} overdue` : "outstanding", {
        tone: overdue ? "alert" : "",
        panel: "invoices",
      }),
    );
  }
  if (schedule) {
    const inOffice = schedule.filter((e) => e.status === "in_office").length;
    stats.appendChild(statTile(inOffice, "in the office today", { panel: "staff-schedule" }));
  }
  if (stats.children.length === 0) stats.appendChild(statTile("—", "nothing to summarise yet"));

  /* --- Needs your attention --- */
  attention.innerHTML = "";
  // Deadlines lead. A missed deadline is the most common malpractice
  // claim there is, and it outranks anything else competing for the top
  // of this list.
  for (const d of (upcoming || []).filter((x) => x.overdue || x.daysAway <= 7 || x.confirmationState !== "confirmed").slice(0, 4)) {
    const row = listRow(deadlineRowHtml(d));
    const open = mkButton("Open in Deadlines", () => goToPanel("deadlines"));
    row.appendChild(document.createElement("br"));
    row.appendChild(open);
    attention.appendChild(row);
  }
  for (const wp of (pending || []).slice(0, 5)) {
    const row = listRow(
      `<strong>${escapeHtml(wp.kind)}</strong> — matter ${escapeHtml(wp.matterId)}
       <span class="badge pending_review">pending review</span>
       ${wp.flags.length ? `<div class="flags">Unresolved flags: ${escapeHtml(wp.flags.join(", "))}</div>` : ""}`,
    );
    const open = mkButton("Open in Review Queue", () => { goToPanel("queue"); loadDetail(wp.id); });
    open.classList.add("primary");
    row.appendChild(document.createElement("br"));
    row.appendChild(open);
    attention.appendChild(row);
  }
  for (const row of (outstanding || []).filter((r) => r.daysOverdue > 0).slice(0, 3)) {
    const item = listRow(
      `<strong>${escapeHtml(row.number)} is ${row.daysOverdue} day${row.daysOverdue === 1 ? "" : "s"} overdue</strong>
       <span class="badge rejected">${escapeHtml(centsToDollars(row.totals.balanceCents))} due</span>
       <div class="meta-tight">${escapeHtml(row.clientName || row.matterId)} · ${escapeHtml(row.matterTitle || "")}</div>`,
    );
    const open = mkButton("Open in Invoices", () => goToPanel("invoices"));
    item.appendChild(document.createElement("br"));
    item.appendChild(open);
    attention.appendChild(item);
  }
  for (const c of (conflicts || []).slice(0, 5)) {
    attention.appendChild(
      listRow(`<strong>Deadline conflict</strong> — matter ${escapeHtml(c.matterId)} / ${escapeHtml(c.type)}
        <span class="badge rejected">sources disagree</span>`),
    );
  }
  if (attention.children.length === 0) {
    attention.innerHTML = emptyHero(
      ICON_CHECK,
      "All caught up",
      isAttorney ? "The review queue is clear." : "Nothing assigned to you right now.",
      { ok: true },
    );
  }

  /* --- Today --- */
  today.innerHTML = "";
  const mine = (schedule || []).find((e) => e.actorId === currentActorId);
  if (mine) {
    today.appendChild(listRow(`<strong>You today</strong> <span class="badge">${escapeHtml(mine.status.replace("_", " "))}</span>
      ${mine.note ? `<div class="meta-tight">${escapeHtml(mine.note)}</div>` : ""}`));
  } else {
    today.appendChild(listRow(`<strong>You today</strong> <span class="badge">not set</span>
      <div class="meta-tight">Set it on the Schedule panel so colleagues know where you are.</div>`));
  }
  if (clock) {
    const row = listRow(
      clock.openShift
        ? `<strong>On the clock</strong> <span class="badge approved">${escapeHtml(formatMs(Date.now() - Date.parse(clock.openShift.clockInAt)))}</span>
           <div class="meta-tight">Since ${escapeHtml(formatTimeOfDay(clock.openShift.clockInAt))}${
             clock.openShift.likelyForgotten ? " — that's over 16 hours; did you forget to clock out?" : ""
           }</div>`
        : `<strong>Not clocked in</strong>
           <div class="meta-tight">${escapeHtml(formatMs(clock.today ? clock.today.totalMs : 0))} recorded today.</div>`,
    );
    const punchNow = mkButton(clock.openShift ? "Clock out" : "Clock in", async () => {
      await punch(clock.openShift ? "clock-out" : "clock-in");
      loadHome();
    });
    punchNow.classList.add(clock.openShift ? "danger" : "primary");
    row.appendChild(document.createElement("br"));
    row.appendChild(punchNow);
    today.appendChild(row);
  }
  const latest = (announcements || []).slice(-2).reverse();
  for (const a of latest) {
    today.appendChild(
      listRow(`<strong>Announcement</strong> — ${escapeHtml(a.senderName)}
        <div class="mt-xs">${escapeHtml(a.body)}</div>
        <div class="meta-tight">${new Date(a.sentAt).toLocaleString()}</div>`),
    );
  }
  if (today.children.length === 0) today.innerHTML = '<li class="static empty">Nothing scheduled.</li>';
}

/* ===== Global search ===== */
const HIT_PANEL = {
  matter: "conflicts",
  work_product: "queue",
  document: "cases",
  research: "research",
  time_entry: "billing",
};

/**
 * Wraps matches in <mark>. The snippet is escaped *first* and the marks
 * inserted after, so a document containing "<script>" is highlighted as
 * text rather than executed — the search index is full of content this
 * app never wrote.
 */
function highlight(text, query) {
  const escaped = escapeHtml(text);
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}§.'-]+/u)
    .filter((w) => w.length > 1)
    .map((w) => escapeHtml(w))
    .sort((a, b) => b.length - a.length);
  if (words.length === 0) return escaped;
  const pattern = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return escaped.replace(pattern, "<mark>$1</mark>");
}

async function runSearch(query) {
  showError("");
  const box = document.getElementById("searchQuery");
  if (query !== undefined) box.value = query;
  const q = box.value.trim();
  const list = document.getElementById("searchResults");
  const summary = document.getElementById("searchSummary");
  const caveat = document.getElementById("searchCaveat");
  if (!q) {
    list.innerHTML = "";
    summary.textContent = "";
    caveat.textContent = "";
    return;
  }
  try {
    const results = await api(`/api/search?q=${encodeURIComponent(q)}`);
    summary.textContent = results.hits.length
      ? `${results.hits.length}${results.truncated ? "+" : ""} result${results.hits.length === 1 ? "" : "s"} for "${results.query}"`
      : `Nothing found for "${results.query}".`;
    caveat.textContent = `Not searched: ${results.notSearched.join("; ")}.`;

    list.innerHTML = "";
    for (const hit of results.hits) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="hit-kind">${escapeHtml(hit.kind.replace(/_/g, " "))}</span>
        <strong>${highlight(hit.title, q)}</strong>
        <span class="badge">${escapeHtml(hit.matterId)}</span>
        <div class="hit-snippet">${highlight(hit.snippet, q)}</div>
        <div class="meta-tight">${escapeHtml(hit.meta)}</div>`;
      li.addEventListener("click", () => openHit(hit));
      list.appendChild(li);
    }
    if (results.hits.length === 0) {
      list.innerHTML = emptyHero(ICON_SEARCH, "Nothing found", "Matters you aren't assigned to are never included.");
    }
  } catch (err) {
    showError(err.message);
    list.innerHTML = "";
  }
}

/** Takes you to the panel that owns the thing, with its matter prefilled. */
function openHit(hit) {
  const panel = HIT_PANEL[hit.kind];
  if (!panel) return;
  for (const id of ["matterRecordId", "casesMatterId", "researchMatterId", "billingMatterId", "invoiceMatterId"]) {
    const el = document.getElementById(id);
    if (el) el.value = hit.matterId;
  }
  goToPanel(panel);
  if (hit.kind === "work_product" && currentRole === "attorney") loadDetail(hit.id);
}

document.getElementById("runSearch").addEventListener("click", () => runSearch());
document.getElementById("searchQuery").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runSearch();
});
// The top-bar box is the one people will actually use; it hands off to
// the panel rather than trying to render results in a dropdown.
document.getElementById("globalSearch").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const q = e.target.value.trim();
  if (!q) return;
  goToPanel("search");
  runSearch(q);
  e.target.value = "";
});

/* ===== Conflicts =====
   Deliberately presents every hit rather than reducing the check to a
   yes/no. A conflicts screen is an input to an attorney's judgement
   (is this matter "substantially related" under Rule 1.9?), not a
   decision the software gets to make. */
const SEVERITY_LABEL = {
  direct: "direct conflict",
  former_client: "former-client conflict",
  same_side: "existing client",
  informational: "for information",
};
const SEVERITY_BADGE = {
  direct: "rejected",
  former_client: "pending_review",
  same_side: "confirmed",
  informational: "",
};

function linesOf(id) {
  return document
    .getElementById(id)
    .value.split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

async function runConflictCheck() {
  showError("");
  const verdict = document.getElementById("conflictVerdict");
  const hitList = document.getElementById("conflictHits");
  try {
    const names = linesOf("conflictNames");
    if (names.length === 0) {
      verdict.innerHTML = '<p class="subtitle-inline">Enter at least one name.</p>';
      hitList.innerHTML = "";
      return;
    }
    const role = document.getElementById("conflictRole").value;
    const roleByName = Object.fromEntries(names.map((n) => [n, role]));
    const result = await api("/api/conflicts/check", { method: "POST", body: JSON.stringify({ names, roleByName }) });

    verdict.innerHTML = result.requiresAttorneyReview
      ? `<div class="flags"><strong>Attorney review required.</strong> ${result.hits.length} match(es) found — do not open this matter until an attorney has cleared them.</div>`
      : result.hits.length
        ? `<p class="subtitle-inline">${result.hits.length} match(es) found, none directly adverse. Confirm they're the same people before proceeding.</p>`
        : `<p class="subtitle-inline">No matches in the firm's recorded matters. Note this only covers matters that have been written down here.</p>`;

    hitList.innerHTML = "";
    for (const h of result.hits) {
      hitList.appendChild(
        (() => {
          const li = document.createElement("li");
          li.classList.add("static");
          li.innerHTML = `<span class="badge ${SEVERITY_BADGE[h.severity] || ""}">${escapeHtml(SEVERITY_LABEL[h.severity] || h.severity)}</span>
            <span class="badge">${escapeHtml(h.matchStrength)} match</span>
            <strong>${escapeHtml(h.searchedName)}</strong> ↔ <strong>${escapeHtml(h.matchedName)}</strong>
            <div class="mt-xs">${escapeHtml(h.matterTitle)} <span class="badge">${escapeHtml(h.matterId)}</span> <span class="badge">${escapeHtml(h.matterStatus)}</span></div>
            <div class="meta-tight">${escapeHtml(h.explanation)}</div>`;
          return li;
        })(),
      );
    }
    if (result.hits.length === 0) hitList.innerHTML = '<li class="static empty">No matches.</li>';
  } catch (err) {
    showError(err.message);
  }
}

/* ===== Firm-wide conflicts audit =====
   The whole book screened against itself. Each finding names the people
   and lists the matters on each side; a matter id opens that record in
   the editor below, since fixing a finding usually means correcting a
   party list. Attorney-only server-side; the card is only shown to
   attorneys so nobody else gets a button that can only 403. */
const AUDIT_SEVERITY_LABEL = {
  current_adversity: "current client adverse",
  former_client_adversity: "former client adverse",
  past_adversity: "past adversity",
  review: "check spelling",
};
const AUDIT_SEVERITY_BADGE = {
  current_adversity: "rejected",
  former_client_adversity: "pending_review",
  past_adversity: "",
  review: "",
};
let lastConflictAudit = null;

function auditSide(appearances, role, label) {
  const mine = appearances.filter((a) => a.role === role);
  if (!mine.length) return "";
  const items = mine
    .map(
      (a) =>
        `<div class="audit-appearance"><button class="matter-link" data-matter="${escapeHtml(a.matterId)}" title="Open this matter record">${escapeHtml(a.matterId)}</button>
          ${escapeHtml(a.matterTitle)} <span class="badge">${escapeHtml(a.matterStatus)}</span>
          <span class="audit-as">as “${escapeHtml(a.name)}”${a.note ? ` · ${escapeHtml(a.note)}` : ""}</span></div>`,
    )
    .join("");
  // Divs, not a nested list: a <li> inside ul.list picks up the outer
  // list's card styling and keyboard handling.
  return `<div class="audit-side"><span class="audit-side-label">${label}</span><div class="audit-appearances">${items}</div></div>`;
}

async function runConflictAudit() {
  showError("");
  const summary = document.getElementById("conflictAuditSummary");
  const list = document.getElementById("conflictAuditList");
  const caveats = document.getElementById("conflictAuditNotCovered");
  const button = document.getElementById("runConflictAudit");
  button.disabled = true;
  try {
    const report = await api("/api/conflicts/audit", { method: "POST" });
    lastConflictAudit = report;
    const c = report.countsBySeverity;
    const adversity = c.current_adversity + c.former_client_adversity + c.past_adversity;
    const scanned = `Screened ${report.partiesCompared} client and adverse ${report.partiesCompared === 1 ? "party" : "parties"} across ${report.mattersScanned} ${report.mattersScanned === 1 ? "matter" : "matters"}`;
    summary.innerHTML =
      report.totalFindings === 0
        ? `<p class="subtitle-inline">${scanned}. Nobody recorded here is on both sides of the firm's matters. That covers only what's written on a matter record — see the notes below.</p>`
        : `<div class="audit-summary${c.current_adversity || c.former_client_adversity ? " is-serious" : ""}"><strong>${scanned}.</strong>
            ${c.current_adversity} current client${c.current_adversity === 1 ? "" : "s"} adverse elsewhere,
            ${c.former_client_adversity} former client${c.former_client_adversity === 1 ? "" : "s"} adverse,
            ${c.past_adversity} past adversity, ${c.review} spelling ${c.review === 1 ? "variant" : "variants"} to check.
            ${report.truncated ? `Showing the ${report.findings.length} most serious of ${report.totalFindings}.` : ""}
            ${adversity ? "Each needs an attorney's reading — nothing here clears itself." : ""}</div>`;

    list.innerHTML = "";
    for (const f of report.findings) {
      const names = [...new Set(f.appearances.map((a) => a.name))];
      const li = listRow(`<span class="badge ${AUDIT_SEVERITY_BADGE[f.severity] || ""}">${escapeHtml(AUDIT_SEVERITY_LABEL[f.severity] || f.severity)}</span>
        <span class="badge">${escapeHtml(f.matchStrength)} match</span>
        ${f.sameMatter ? '<span class="badge rejected">both sides of one matter</span>' : ""}
        <strong>${names.map(escapeHtml).join(" ↔ ")}</strong>
        <div class="audit-sides">${auditSide(f.appearances, "client", "Client on")}${auditSide(f.appearances, "adverse", "Adverse on")}</div>
        <div class="meta-tight">${escapeHtml(f.explanation)}</div>`);
      li.classList.add("audit-finding", `audit-${f.severity}`);
      list.appendChild(li);
    }

    caveats.innerHTML = report.notCovered.map((n) => `<li>${escapeHtml(n)}</li>`).join("");
    document.getElementById("downloadConflictAudit").hidden = report.findings.length === 0;
  } catch (err) {
    showError(err.message);
  } finally {
    button.disabled = false;
  }
}

/* ===== Calendar file =====
   Same blob-download shape as the invoice PDF: the response is binary,
   so it can't go through api(), which parses JSON. Both buttons (Deadlines
   and Scheduling) fetch the same file; the server decides what's in it
   from who's asking. */
async function downloadCalendarFile(e) {
  showError("");
  const button = e.currentTarget;
  button.disabled = true;
  try {
    const res = await fetch("/api/calendar/export.ics", { credentials: "same-origin" });
    if (res.status === 401) { window.location.href = "/login.html"; return; }
    if (!res.ok) { showError((await res.json().catch(() => ({}))).error || res.statusText); return; }
    const disposition = res.headers.get("content-disposition") || "";
    const name = /filename="([^"]+)"/.exec(disposition)?.[1] || "docket-calendar.ics";
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
    showToast("Calendar file downloaded — open it to add the events to your calendar app.");
  } catch (err) {
    showError(err.message);
  } finally {
    button.disabled = false;
  }
}
for (const btn of document.querySelectorAll("[data-calendar-export]")) btn.addEventListener("click", downloadCalendarFile);

function downloadConflictAuditCsv() {
  if (!lastConflictAudit || !lastConflictAudit.findings.length) return;
  const header = ["Finding", "Severity", "Match", "Both sides of one matter", "Role", "Matter ID", "Matter title", "Matter status", "Name as recorded", "Note"];
  const rows = [];
  lastConflictAudit.findings.forEach((f, i) => {
    for (const a of f.appearances) {
      rows.push([i + 1, AUDIT_SEVERITY_LABEL[f.severity] || f.severity, f.matchStrength, f.sameMatter ? "yes" : "no", a.role, a.matterId, a.matterTitle, a.matterStatus, a.name, a.note || ""]);
    }
  });
  const stamp = lastConflictAudit.generatedAt.slice(0, 10);
  downloadCsv(`conflicts-audit-${stamp}.csv`, header, rows);
}

document.getElementById("conflictAuditList").addEventListener("click", (e) => {
  const link = e.target.closest(".matter-link");
  if (!link) return;
  document.getElementById("matterRecordId").value = link.dataset.matter;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  loadMatterRecord().then(() => document.getElementById("matterTitle").scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" }));
});

/**
 * A party is written as `Name`, `Name <email@example.com>`,
 * `Name [+15551234567]`, or `Name <email@example.com> [+15551234567]`
 * — the email part is the same shape as a mail "To:" field, and the
 * bracketed part is the phone number the SMS appointment-reminder
 * channel texts. Both have to round-trip through this textarea: a save
 * rebuilds the whole party list, so anything the editor can't display
 * it would silently delete. The client's address/number are what the
 * Invoices panel emails a bill to and the reminder job texts.
 */
function partyToLine(party) {
  let line = party.name;
  if (party.email) line += ` <${party.email}>`;
  if (party.phone) line += ` [${party.phone}]`;
  if (party.note) line += ` — ${party.note}`;
  return line;
}

// A note goes last, after " — " (or " -- " typed on a keyboard without
// an em dash). Before notes and related parties had a place here, saving
// a matter from this panel deleted every related party and every note,
// because the save rebuilds the whole list from these boxes.
const PARTY_NOTE_RE = /^(.*?)\s+(?:—|--)\s+(.+)$/;

function lineToParty(line, role) {
  let rest = line.trim();
  const party = { name: rest, role };
  const noteMatch = PARTY_NOTE_RE.exec(rest);
  if (noteMatch) {
    party.note = noteMatch[2].trim();
    rest = noteMatch[1].trim();
  }
  const phoneMatch = /^(.*?)\s*\[([^\]]+)\]\s*$/.exec(rest);
  if (phoneMatch) {
    party.phone = phoneMatch[2].trim();
    rest = phoneMatch[1].trim();
  }
  const emailMatch = /^(.*?)\s*<([^>]+)>\s*$/.exec(rest);
  if (emailMatch) {
    party.email = emailMatch[2].trim();
    rest = emailMatch[1].trim();
  }
  party.name = rest;
  return party;
}

function partiesToTextareas(matter) {
  const pick = (role) =>
    (matter.parties || [])
      .filter((p) => p.role === role)
      .map(partyToLine)
      .join("\n");
  document.getElementById("matterClients").value = pick("client");
  document.getElementById("matterAdverse").value = pick("adverse");
  document.getElementById("matterRelated").value = pick("related");
}

// The key-dates list being edited for whatever matter is currently
// loaded — held client-side and only sent on "Save matter record",
// same as the parties textareas above.
let currentKeyDates = [];

function renderKeyDatesList() {
  const list = document.getElementById("matterKeyDatesList");
  list.innerHTML = "";
  currentKeyDates.forEach((d, i) => {
    const li = document.createElement("li");
    li.classList.add("static");
    li.innerHTML = `<strong>${escapeHtml(d.label)}</strong> <span class="badge">${escapeHtml(d.date)}</span>`;
    const remove = mkButton("Remove", () => {
      currentKeyDates.splice(i, 1);
      renderKeyDatesList();
    });
    remove.classList.add("danger");
    li.appendChild(document.createElement("br"));
    li.appendChild(remove);
    list.appendChild(li);
  });
  if (currentKeyDates.length === 0) list.innerHTML = '<li class="static empty">No key dates recorded.</li>';
}

document.getElementById("addKeyDate").addEventListener("click", () => {
  const label = document.getElementById("newKeyDateLabel").value.trim();
  const date = document.getElementById("newKeyDateValue").value;
  if (!label || !date) { showError("A key date needs both a label and a date."); return; }
  showError("");
  currentKeyDates.push({ label, date });
  currentKeyDates.sort((a, b) => a.date.localeCompare(b.date));
  renderKeyDatesList();
  document.getElementById("newKeyDateLabel").value = "";
  document.getElementById("newKeyDateValue").value = "";
});

/**
 * Closing controls, rendered from the loaded record so the button always
 * matches the matter's real state rather than whatever it was when the
 * panel first opened.
 */
function renderMatterLifecycle(matter) {
  const host = document.getElementById("matterLifecycle");
  host.innerHTML = "";
  if (!matter || currentRole !== "attorney") return;

  if (matter.status === "closed") {
    host.innerHTML = `<p class="subtitle-inline">Closed ${escapeHtml((matter.closedAt || "").slice(0, 10))}${
      matter.retentionUntil ? ` · keep the file until ${escapeHtml(matter.retentionUntil)}` : " · no retention date recorded"
    }${matter.closingNote ? `<br />${escapeHtml(matter.closingNote)}` : ""}</p>`;
    const reopen = mkButton("Reopen matter", async () => {
      const reason = prompt("Why is this matter being reopened? (kept on the record)");
      if (!reason) return;
      await matterAction(matter.matterId, "reopen", { reason });
    });
    host.appendChild(reopen);
    return;
  }

  const note = document.createElement("input");
  note.id = "closingNote";
  note.placeholder = "How did it end? e.g. charges dismissed at the suppression hearing";
  const label = document.createElement("label");
  label.className = "field grow";
  label.textContent = "Closing note ";
  label.appendChild(note);

  const row = document.createElement("div");
  row.className = "field-row";
  row.appendChild(label);
  const close = mkButton("Close matter", async () => {
    if (!note.value.trim()) { showError("A closing note is required — it records how the matter ended."); return; }
    await matterAction(matter.matterId, "close", { closingNote: note.value.trim() });
  });
  close.classList.add("danger");
  row.appendChild(close);
  host.appendChild(row);
}

async function matterAction(matterId, action, body) {
  showError("");
  try {
    const result = await api(`/api/matters/${encodeURIComponent(matterId)}/${action}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    await loadMatterRecord();
    await loadMatterList();
    // Warnings aren't failures — the close happened. They're the things
    // the attorney should know they've just left behind.
    if (result.warnings?.length) {
      showError(`Matter closed, but note: ${result.warnings.join(" ")}`);
    } else {
      showToast(action === "close" ? "Matter closed." : "Matter reopened.", "success");
    }
  } catch (err) {
    showError(err.message);
  }
}

async function loadRetentionDue() {
  showError("");
  const list = document.getElementById("retentionList");
  try {
    const due = await api("/api/matters/retention-due");
    list.innerHTML = "";
    for (const m of due) {
      list.appendChild(
        listRow(`<strong>${escapeHtml(m.title)}</strong> <span class="badge">${escapeHtml(m.matterId)}</span>
          <span class="badge rejected">retention ended ${escapeHtml(m.retentionUntil)}</span>
          <div class="meta-tight">Closed ${escapeHtml((m.closedAt || "").slice(0, 10))}${m.closingNote ? ` · ${escapeHtml(m.closingNote)}` : ""}</div>`),
      );
    }
    if (due.length === 0) list.innerHTML = '<li class="static empty">No closed file has passed its retention date.</li>';
  } catch (err) {
    showError(err.message);
  }
}

async function loadMatterRecord() {
  showError("");
  try {
    const id = document.getElementById("matterRecordId").value.trim();
    if (!id) return;
    const matter = await api(`/api/matters/${encodeURIComponent(id)}`);
    document.getElementById("matterTitle").value = matter.title || "";
    document.getElementById("matterStatus").value = matter.status || "open";
    document.getElementById("matterPracticeArea").value = matter.practiceAreaId || "";
    document.getElementById("matterResponsibleAttorney").value = matter.responsibleAttorneyId || "";
    document.getElementById("matterCourt").value = matter.court || "";
    document.getElementById("matterCaseNumber").value = matter.caseNumber || "";
    document.getElementById("matterOpposingCounsel").value = matter.opposingCounsel || "";
    document.getElementById("matterDescription").value = matter.description || "";
    currentKeyDates = (matter.keyDates || []).map((d) => ({ ...d }));
    renderKeyDatesList();
    partiesToTextareas(matter);
    renderMatterLifecycle(matter);
  } catch (err) {
    // A matter with no record yet is the normal case, not an error worth shouting about.
    if (/no matter/i.test(err.message)) {
      document.getElementById("matterTitle").value = "";
      document.getElementById("matterPracticeArea").value = "";
      document.getElementById("matterResponsibleAttorney").value = "";
      document.getElementById("matterCourt").value = "";
      document.getElementById("matterCaseNumber").value = "";
      document.getElementById("matterOpposingCounsel").value = "";
      document.getElementById("matterDescription").value = "";
      document.getElementById("matterClients").value = "";
      document.getElementById("matterAdverse").value = "";
      document.getElementById("matterRelated").value = "";
      currentKeyDates = [];
      renderKeyDatesList();
      renderMatterLifecycle(null);
      showError("No record for that matter yet — fill this in and save to create one.");
    } else {
      showError(err.message);
    }
  }
}

async function saveMatterRecord() {
  showError("");
  try {
    const id = document.getElementById("matterRecordId").value.trim();
    if (!id) return;
    const parties = [
      ...linesOf("matterClients").map((line) => lineToParty(line, "client")),
      ...linesOf("matterAdverse").map((line) => lineToParty(line, "adverse")),
      ...linesOf("matterRelated").map((line) => lineToParty(line, "related")),
    ];
    await api(`/api/matters/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({
        title: document.getElementById("matterTitle").value.trim(),
        status: document.getElementById("matterStatus").value,
        practiceAreaId: document.getElementById("matterPracticeArea").value.trim(),
        responsibleAttorneyId: document.getElementById("matterResponsibleAttorney").value,
        court: document.getElementById("matterCourt").value.trim(),
        caseNumber: document.getElementById("matterCaseNumber").value.trim(),
        opposingCounsel: document.getElementById("matterOpposingCounsel").value.trim(),
        description: document.getElementById("matterDescription").value.trim(),
        keyDates: currentKeyDates,
        parties,
      }),
    });
    await loadMatterList();
    await refreshMatterOptions();
    showToast("Matter record saved.", "success");
  } catch (err) {
    showError(err.message);
  }
}

async function loadMatterList() {
  const list = document.getElementById("matterList");
  if (!list) return;
  try {
    const all = await api("/api/matters");
    list.innerHTML = "";
    for (const m of all) {
      const li = document.createElement("li");
      li.classList.add("static");
      const clients = (m.parties || []).filter((p) => p.role === "client").map((p) => p.name);
      const adverse = (m.parties || []).filter((p) => p.role === "adverse").map((p) => p.name);
      li.innerHTML = `<strong>${escapeHtml(m.title)}</strong>
        <span class="badge">${escapeHtml(m.matterId)}</span>
        <span class="badge ${m.status === "closed" ? "rejected" : "approved"}">${escapeHtml(m.status)}</span>
        <div class="meta-tight">Client: ${escapeHtml(clients.join(", ") || "—")} · Adverse: ${escapeHtml(adverse.join(", ") || "—")}</div>`;
      const open = mkButton("Edit", () => {
        document.getElementById("matterRecordId").value = m.matterId;
        loadMatterRecord();
      });
      li.appendChild(document.createElement("br"));
      li.appendChild(open);
      list.appendChild(li);
    }
    if (all.length === 0) list.innerHTML = '<li class="static empty">No matter records yet. Conflicts screening only covers matters recorded here.</li>';
  } catch (err) {
    list.innerHTML = '<li class="static empty">Matter records are paralegal/attorney-only.</li>';
  }
}

document.getElementById("runConflictCheck").addEventListener("click", runConflictCheck);
document.getElementById("runConflictAudit").addEventListener("click", runConflictAudit);
document.getElementById("downloadConflictAudit").addEventListener("click", downloadConflictAuditCsv);
document.getElementById("loadMatterRecord").addEventListener("click", loadMatterRecord);
document.getElementById("loadRetentionDue").addEventListener("click", loadRetentionDue);
document.getElementById("saveMatterRecord").addEventListener("click", saveMatterRecord);
document.getElementById("navConflicts").addEventListener("click", loadMatterList);

/* ===== Trust / IOLTA =====
   Money is handled as integer cents everywhere below. The input is in
   dollars because that's what a human types, but it's converted once, at
   the edge, and never round-tripped through a float again — a trust
   ledger that doesn't reconcile to the penny is an audit finding. */
const TRUST_TYPE_LABEL = {
  deposit: "deposit",
  disbursement: "disbursement",
  earned_fee_transfer: "earned fee transfer",
  refund: "refund",
  reversal: "reversal",
};

function dollarsToCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  // Round after scaling: 12.34 * 100 is 1233.9999... in binary floating point.
  return Math.round(n * 100);
}

function centsToDollars(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString()}.${String(abs % 100).padStart(2, "0")}`;
}

async function loadTrustLedger() {
  showError("");
  const list = document.getElementById("trustEntries");
  try {
    const matterId = document.getElementById("trustMatterId").value.trim();
    if (!matterId) return;
    const view = await api(`/api/trust/matters/${encodeURIComponent(matterId)}`);
    document.getElementById("trustBalance").textContent = centsToDollars(view.balanceCents);
    list.innerHTML = "";
    for (const e of view.entries) {
      const li = document.createElement("li");
      li.classList.add("static");
      const outbound = e.type !== "deposit" && e.type !== "reversal";
      li.innerHTML = `<span class="badge ${e.type === "deposit" ? "approved" : e.type === "reversal" ? "pending_review" : "rejected"}">${escapeHtml(TRUST_TYPE_LABEL[e.type] || e.type)}</span>
        <strong>${outbound ? "−" : "+"}${escapeHtml(centsToDollars(e.amountCents))}</strong>
        <span class="badge">balance ${escapeHtml(centsToDollars(e.balanceAfterCents))}</span>
        <div class="mt-xs">${escapeHtml(e.description)}</div>
        <div class="meta-tight">${escapeHtml(e.recordedBy)} · ${new Date(e.recordedAt).toLocaleString()}${e.reference ? ` · ref ${escapeHtml(e.reference)}` : ""}</div>`;
      // Only an un-reversed, non-reversal entry can be corrected.
      const alreadyReversed = view.entries.some((x) => x.reversalOf === e.id);
      if (currentRole === "attorney" && e.type !== "reversal" && !alreadyReversed) {
        const btn = mkButton("Reverse", async () => {
          showError("");
          const reason = prompt("Why is this entry being reversed? (kept on the record)");
          if (!reason) return;
          try {
            await api(`/api/trust/matters/${encodeURIComponent(matterId)}/${e.id}/reverse`, {
              method: "POST",
              body: JSON.stringify({ reason }),
            });
            await loadTrustLedger();
            showToast("Entry reversed.", "success");
          } catch (err) {
            showError(err.message);
          }
        });
        btn.classList.add("danger");
        li.appendChild(document.createElement("br"));
        li.appendChild(btn);
      }
      list.appendChild(li);
    }
    if (view.entries.length === 0) list.innerHTML = '<li class="static empty">No trust activity on this matter.</li>';
  } catch (err) {
    showError(err.message);
    list.innerHTML = "";
    document.getElementById("trustBalance").textContent = "—";
  }
}

document.getElementById("loadTrustLedger").addEventListener("click", loadTrustLedger);
document.getElementById("navTrust").addEventListener("click", loadTrustLedger);

document.getElementById("recordTrustEntry").addEventListener("click", async () => {
  showError("");
  try {
    const matterId = document.getElementById("trustMatterId").value.trim();
    const amountCents = dollarsToCents(document.getElementById("trustAmount").value);
    const description = document.getElementById("trustDescription").value.trim();
    if (!matterId || !description || !Number.isFinite(amountCents) || amountCents <= 0) {
      showError("Matter, a positive amount, and a description are all required.");
      return;
    }
    await api(`/api/trust/matters/${encodeURIComponent(matterId)}`, {
      method: "POST",
      body: JSON.stringify({
        type: document.getElementById("trustType").value,
        amountCents,
        description,
        reference: document.getElementById("trustReference").value.trim(),
      }),
    });
    document.getElementById("trustAmount").value = "";
    document.getElementById("trustDescription").value = "";
    document.getElementById("trustReference").value = "";
    await loadTrustLedger();
    showToast("Trust entry recorded.", "success");
  } catch (err) {
    showError(err.message);
  }
});

document.getElementById("runReconcile").addEventListener("click", async () => {
  showError("");
  const out = document.getElementById("reconcileResult");
  const list = document.getElementById("reconcileList");
  try {
    const bankBalanceCents = dollarsToCents(document.getElementById("trustBankBalance").value);
    if (!Number.isFinite(bankBalanceCents)) {
      showError("Enter the bank statement balance.");
      return;
    }
    const r = await api("/api/trust/reconcile", { method: "POST", body: JSON.stringify({ bankBalanceCents }) });
    out.innerHTML = r.balanced
      ? `<p class="subtitle-inline">Balanced. Ledger total ${escapeHtml(centsToDollars(r.ledgerTotalCents))} matches the bank.</p>`
      : `<div class="flags"><strong>Out of balance by ${escapeHtml(centsToDollars(r.differenceCents))}.</strong>
         Ledger says ${escapeHtml(centsToDollars(r.ledgerTotalCents))}, bank says ${escapeHtml(centsToDollars(r.bankBalanceCents))}.
         Investigate before any further disbursement.</div>`;
    list.innerHTML = "";
    for (const m of r.perMatter) {
      const li = document.createElement("li");
      li.classList.add("static");
      li.innerHTML = `<strong>${escapeHtml(m.matterId)}</strong> <span class="badge">${escapeHtml(centsToDollars(m.balanceCents))}</span>`;
      list.appendChild(li);
    }
    if (r.perMatter.length === 0) list.innerHTML = '<li class="static empty">No matters hold trust funds.</li>';
  } catch (err) {
    showError(err.message);
    out.innerHTML = "";
  }
});

/* ===== Invoices ===== */
const INVOICE_BADGE = { draft: "", sent: "pending_review", partially_paid: "pending_review", paid: "approved", void: "rejected" };
let selectedInvoiceId = null;

async function loadProcessorInfo() {
  try {
    const info = await api("/api/invoices/processor");
    processorCanCharge = info.canCharge;
    document.getElementById("processorInfo").textContent = info.canCharge
      ? `card charging via ${info.name}`
      : "record manually (no processor configured)";
  } catch {
    /* Panel is role-gated; silence is correct for a role that can't see it. */
  }
}

/** Whether the configured processor can actually move money, so the panel offers "charge" only when it would work. */
let processorCanCharge = false;
/**
 * Whether mail is configured, so a reminder button isn't offered where it
 * would only fail. Fetched once and cached: the receivables list and the
 * invoice list load in parallel, so a flag set as a side effect of one
 * would race the other and the button would come and go.
 */
let emailTransportPromise = null;
function emailTransportReady() {
  emailTransportPromise ??= tryApi("/api/invoices/email-transport").then((t) => t?.canSend ?? false);
  return emailTransportPromise;
}

/**
 * Chasing a client for money is a real communication, so it confirms —
 * naming the client and the amount — and says how often they've already
 * been chased. No automatic dunning: when to press is the firm's call.
 */
async function sendReminder(row) {
  showError("");
  const already = row.reminderCount
    ? `\n\nThey have already been reminded ${row.reminderCount} time${row.reminderCount === 1 ? "" : "s"}, most recently on ${new Date(row.lastRemindedAt).toLocaleDateString()}.`
    : "";
  const who = row.clientName || "the client";
  if (!confirm(`Email ${who} a reminder that ${row.number} (${centsToDollars(row.totals.balanceCents)}) is outstanding?${already}`)) return;
  try {
    await api(`/api/invoices/matters/${encodeURIComponent(row.matterId)}/${row.id}/remind`, {
      method: "POST",
      body: "{}",
    });
    await loadOutstanding();
    showToast(`Reminder sent to ${who}.`, "success");
  } catch (err) {
    showError(err.message);
  }
}

/** The accounts-receivable view: unpaid issued invoices, most overdue first. */
// Kept around so "Download CSV" exports the same receivables list
// currently on screen without a second fetch.
let lastOutstandingRows = [];

async function loadOutstanding() {
  const list = document.getElementById("outstandingList");
  const summary = document.getElementById("outstandingSummary");
  try {
    const [rows, canRemind] = await Promise.all([api("/api/invoices/outstanding"), emailTransportReady()]);
    lastOutstandingRows = rows;
    list.innerHTML = "";
    const totalCents = rows.reduce((sum, r) => sum + r.totals.balanceCents, 0);
    const overdue = rows.filter((r) => r.daysOverdue > 0);
    summary.textContent = rows.length
      ? `${centsToDollars(totalCents)} outstanding across ${rows.length} invoice${rows.length === 1 ? "" : "s"}` +
        (overdue.length ? ` — ${overdue.length} overdue.` : ".")
      : "";

    for (const row of rows) {
      const li = document.createElement("li");
      // How often this client has already been chased, so a third
      // reminder in a week is a deliberate act rather than an accident.
      const chased = row.reminderCount
        ? ` · reminded ${row.reminderCount}×, last ${new Date(row.lastRemindedAt).toLocaleDateString()}`
        : "";
      li.innerHTML = `<strong>${escapeHtml(row.number)}</strong>
        <span class="badge ${row.daysOverdue > 0 ? "rejected" : "pending_review"}">${escapeHtml(centsToDollars(row.totals.balanceCents))} due</span>
        ${row.daysOverdue > 0 ? `<span class="badge rejected">${row.daysOverdue} day${row.daysOverdue === 1 ? "" : "s"} overdue</span>` : ""}
        <div class="meta-tight">${escapeHtml(row.clientName || "client not on record")} · ${escapeHtml(row.matterTitle || row.matterId)}${row.dueDate ? ` · due ${escapeHtml(row.dueDate)}` : " · no due date set"}${escapeHtml(chased)}</div>`;

      // Clicking the row jumps to the invoice; the button must not, or
      // "send a reminder" would also navigate away from the list.
      li.addEventListener("click", async () => {
        document.getElementById("invoiceMatterId").value = row.matterId;
        await loadInvoices();
        await showInvoice(row.matterId, row.id);
      });
      if (currentRole === "attorney" && canRemind) {
        const remind = mkButton("Send reminder", async (event) => {
          event.stopPropagation();
          await sendReminder(row);
        });
        li.appendChild(document.createElement("br"));
        li.appendChild(remind);
      }
      list.appendChild(li);
    }
    if (rows.length === 0) list.innerHTML = '<li class="static empty">Nothing outstanding — every issued invoice is paid.</li>';
  } catch (err) {
    list.innerHTML = "";
    summary.textContent = "";
    void err;
  }
}

async function loadInvoices() {
  showError("");
  loadProcessorInfo();
  const list = document.getElementById("invoiceList");
  try {
    const matterId = document.getElementById("invoiceMatterId").value.trim();
    if (!matterId) return;
    const invoices = await api(`/api/invoices/matters/${encodeURIComponent(matterId)}`);
    list.innerHTML = "";
    for (const inv of invoices) {
      const li = document.createElement("li");
      li.innerHTML = `<strong>${escapeHtml(inv.number)}</strong>
        <span class="badge ${INVOICE_BADGE[inv.status] || ""}">${escapeHtml(inv.status.replace("_", " "))}</span>
        <span class="badge">${escapeHtml(centsToDollars(inv.totals.subtotalCents))}</span>
        ${inv.totals.balanceCents > 0 && inv.status !== "void" ? `<span class="badge rejected">due ${escapeHtml(centsToDollars(inv.totals.balanceCents))}</span>` : ""}`;
      li.addEventListener("click", () => showInvoice(matterId, inv.id));
      list.appendChild(li);
    }
    if (invoices.length === 0) list.innerHTML = '<li class="static empty">No invoices on this matter yet.</li>';
  } catch (err) {
    showError(err.message);
    list.innerHTML = "";
  }
}

async function showInvoice(matterId, invoiceId) {
  showError("");
  selectedInvoiceId = invoiceId;
  const el = document.getElementById("invoiceDetail");
  try {
    const inv = await api(`/api/invoices/matters/${encodeURIComponent(matterId)}/${invoiceId}`);
    const isDraft = inv.status === "draft";
    const payable = inv.status === "sent" || inv.status === "partially_paid";
    el.innerHTML = `
      <div class="card">
        <h3>${escapeHtml(inv.number)} <span class="badge ${INVOICE_BADGE[inv.status] || ""}">${escapeHtml(inv.status.replace("_", " "))}</span></h3>
        <p class="subtitle-inline">Matter ${escapeHtml(inv.matterId)}${inv.dueDate ? ` · due ${escapeHtml(inv.dueDate)}` : ""}${inv.voidReason ? ` · voided: ${escapeHtml(inv.voidReason)}` : ""}</p>
        <ul id="invoiceLines" class="list"></ul>
        <div class="field-row">
          <div class="field"><div class="k">Total</div><div class="n">${escapeHtml(centsToDollars(inv.totals.subtotalCents))}</div></div>
          <div class="field"><div class="k">Paid</div><div class="n">${escapeHtml(centsToDollars(inv.totals.paidCents))}</div></div>
          <div class="field"><div class="k">Balance</div><div class="n">${escapeHtml(centsToDollars(inv.totals.balanceCents))}</div></div>
        </div>
        <div class="actions" id="invoiceActions"></div>
      </div>
      ${isDraft ? `<div class="card">
        <h3>Add a line</h3>
        <div class="field-row">
          <label class="field grow">Description <input id="lineDescription" /></label>
          <label class="field">Qty / hours <input id="lineQuantity" type="number" step="0.1" min="0.1" value="1" /></label>
          <label class="field">Rate / amount <input id="lineUnit" type="number" step="0.01" min="0.01" placeholder="0.00" /></label>
          <button class="btn" id="addLine">Add line</button>
        </div>
        <div class="field-row">
          <label class="field">Or pull this matter's logged time at <input id="timeRate" type="number" step="0.01" min="0.01" placeholder="hourly rate" /></label>
          <button class="btn" id="addTimeLines">Add logged time</button>
        </div>
      </div>` : ""}
      ${payable ? `<div class="card">
        <h3>Record a payment</h3>
        <div class="field-row">
          <label class="field">Amount <input id="payAmount" type="number" step="0.01" min="0.01" placeholder="0.00" /></label>
          <label class="field">Method
            <select id="payMethod"><option value="check">check</option><option value="ach">ACH</option><option value="cash">cash</option><option value="card">card</option><option value="other">other</option></select>
          </label>
          <label class="field">Reference <input id="payReference" placeholder="check no. / txn id" /></label>
          <button class="btn primary" id="recordPayment">Record payment</button>
        </div>
        <div class="field-row">
          <label class="field">Or apply from the client's trust balance <input id="trustApplyAmount" type="number" step="0.01" min="0.01" placeholder="0.00" /></label>
          <button class="btn" id="applyTrust">Apply trust funds</button>
        </div>
      </div>` : ""}
      ${payable && processorCanCharge ? `<div class="card">
        <h3>Charge a card</h3>
        <p class="subtitle-inline">Card details never reach this server — paste the token your processor's own form produced. Charges go to the operating account, never to trust.</p>
        <div class="field-row">
          <label class="field">Amount <input id="chargeAmount" type="number" step="0.01" min="0.01" placeholder="0.00" /></label>
          <label class="field grow">Payment token <input id="chargeToken" placeholder="tok_..." /></label>
          <button class="btn primary" id="chargeCard">Charge</button>
        </div>
      </div>` : ""}
      <div class="card">
        <div class="field-row">
          <h3 class="row-title">Client copy</h3>
          <button class="btn" id="previewInvoice">Preview the client's copy</button>
          <button class="btn" id="downloadInvoicePdf">Download PDF</button>
          ${currentRole === "attorney" && inv.status !== "void" ? `
            <label class="field grow">Email to <input id="invoiceEmailTo" placeholder="loading…" /></label>
            <button class="btn primary" id="emailInvoice">Email invoice</button>` : ""}
        </div>
        <p class="subtitle-inline" id="emailTransportNote"></p>
        <pre id="invoicePreview" class="preview hidden"></pre>
        <ul id="invoiceDeliveries" class="list"></ul>
      </div>
      <div class="card"><h3>Payments</h3><ul id="invoicePayments" class="list"></ul></div>
    `;

    const deliveries = document.getElementById("invoiceDeliveries");
    for (const d of inv.deliveries || []) {
      deliveries.appendChild(
        listRow(`<strong>Emailed to ${escapeHtml(d.to)}</strong>
          <div class="meta-tight">${new Date(d.at).toLocaleString()} by ${escapeHtml(d.by)}${d.messageId ? ` · ${escapeHtml(d.messageId)}` : ""}</div>`),
      );
    }
    if (!(inv.deliveries || []).length) {
      deliveries.innerHTML = '<li class="static empty">No copy has been emailed from Docket yet.</li>';
    }

    const lines = document.getElementById("invoiceLines");
    for (const l of inv.lineItems) {
      const li = document.createElement("li");
      li.classList.add("static");
      const provenance = [l.workedOn, l.timekeeperId && (knownStaff.find((m) => m.actorId === l.timekeeperId)?.displayName || l.timekeeperId)]
        .filter(Boolean)
        .join(" · ");
      li.innerHTML = `<strong>${escapeHtml(centsToDollars(l.amountCents))}</strong>
        <span class="badge">${escapeHtml(l.source)}</span>
        ${provenance ? `<span class="badge">${escapeHtml(provenance)}</span>` : ""}
        <div class="mt-xs">${escapeHtml(l.description)}</div>
        <div class="meta-tight">${(l.quantityMilli / 1000).toFixed(2)} × ${escapeHtml(centsToDollars(l.unitAmountCents))}</div>`;
      if (isDraft) {
        const rm = mkButton("Remove", async () => {
          try {
            await api(`/api/invoices/matters/${encodeURIComponent(matterId)}/${invoiceId}/lines/${l.id}`, { method: "DELETE" });
            await showInvoice(matterId, invoiceId);
            showToast("Line removed.", "success");
          } catch (err) { showError(err.message); }
        });
        rm.classList.add("danger");
        li.appendChild(document.createElement("br"));
        li.appendChild(rm);
      }
      lines.appendChild(li);
    }
    if (inv.lineItems.length === 0) lines.innerHTML = '<li class="static empty">No lines yet.</li>';

    const pays = document.getElementById("invoicePayments");
    for (const p of inv.payments) {
      const li = document.createElement("li");
      li.classList.add("static");
      li.innerHTML = `<strong>${escapeHtml(centsToDollars(p.amountCents))}</strong>
        <span class="badge ${p.method === "trust_application" ? "confirmed" : ""}">${escapeHtml(p.method.replace("_", " "))}</span>
        <div class="meta-tight">${escapeHtml(p.recordedBy)} · ${new Date(p.recordedAt).toLocaleString()}${p.reference ? ` · ${escapeHtml(p.reference)}` : ""}</div>`;
      pays.appendChild(li);
    }
    if (inv.payments.length === 0) pays.innerHTML = '<li class="static empty">Nothing received yet.</li>';

    const INVOICE_ACTION_LABEL = {
      send: "Invoice sent to client.",
      void: "Invoice voided.",
      lines: "Line added.",
      "add-time": "Logged time added.",
      payments: "Payment recorded.",
      "pay-from-trust": "Applied from trust.",
      charge: "Card charged.",
      email: "Invoice emailed.",
    };
    const actions = document.getElementById("invoiceActions");
    const act = async (path, body) => {
      showError("");
      try {
        await api(`/api/invoices/matters/${encodeURIComponent(matterId)}/${invoiceId}/${path}`, {
          method: "POST",
          body: JSON.stringify(body || {}),
        });
        await loadInvoices();
        await loadOutstanding();
        await showInvoice(matterId, invoiceId);
        showToast(INVOICE_ACTION_LABEL[path] || "Done.", "success");
      } catch (err) { showError(err.message); }
    };
    if (isDraft && currentRole === "attorney") {
      const send = mkButton("Send to client", () => act("send"));
      send.classList.add("primary");
      actions.appendChild(send);
    }
    if (inv.status !== "void" && inv.payments.length === 0 && currentRole === "attorney") {
      const v = mkButton("Void", () => {
        const reason = prompt("Why is this invoice being voided?");
        if (reason) return act("void", { reason });
      });
      v.classList.add("danger");
      actions.appendChild(v);
    }

    document.getElementById("addLine")?.addEventListener("click", () =>
      act("lines", {
        description: document.getElementById("lineDescription").value,
        source: "flat",
        quantityMilli: Math.round(Number(document.getElementById("lineQuantity").value) * 1000),
        unitAmountCents: dollarsToCents(document.getElementById("lineUnit").value),
      }),
    );
    document.getElementById("addTimeLines")?.addEventListener("click", () =>
      act("add-time", { hourlyRateCents: dollarsToCents(document.getElementById("timeRate").value) }),
    );
    document.getElementById("recordPayment")?.addEventListener("click", () =>
      act("payments", {
        amountCents: dollarsToCents(document.getElementById("payAmount").value),
        method: document.getElementById("payMethod").value,
        reference: document.getElementById("payReference").value,
      }),
    );
    document.getElementById("applyTrust")?.addEventListener("click", () =>
      act("pay-from-trust", { amountCents: dollarsToCents(document.getElementById("trustApplyAmount").value) }),
    );
    document.getElementById("chargeCard")?.addEventListener("click", () =>
      act("charge", {
        amountCents: dollarsToCents(document.getElementById("chargeAmount").value),
        instrumentToken: document.getElementById("chargeToken").value.trim(),
      }),
    );

    /* --- Preview / email --- */
    // The preview shows the plain-text alternative rather than the HTML
    // one. Both carry the same itemisation, and the HTML version styles
    // itself with inline attributes for mail clients — which this app's
    // CSP blocks on purpose, and which isn't worth an exception.
    let previewed = null;
    const loadPreview = async () => {
      if (!previewed) {
        previewed = await api(`/api/invoices/matters/${encodeURIComponent(matterId)}/${invoiceId}/preview`);
      }
      return previewed;
    };
    document.getElementById("previewInvoice")?.addEventListener("click", async () => {
      showError("");
      const pre = document.getElementById("invoicePreview");
      try {
        pre.textContent = (await loadPreview()).text;
        pre.classList.remove("hidden");
      } catch (err) { showError(err.message); }
    });

    // The PDF comes back as binary, so it's fetched as a blob and handed
    // to an object URL rather than going through api(), which parses JSON.
    document.getElementById("downloadInvoicePdf")?.addEventListener("click", async () => {
      showError("");
      try {
        const res = await fetch(
          `/api/invoices/matters/${encodeURIComponent(matterId)}/${invoiceId}/pdf`,
          { credentials: "same-origin" },
        );
        if (res.status === 401) { window.location.href = "/login.html"; return; }
        if (!res.ok) { showError((await res.json()).error || res.statusText); return; }
        const disposition = res.headers.get("content-disposition") || "";
        const name = /filename="([^"]+)"/.exec(disposition)?.[1] || `${inv.number}.pdf`;
        const url = URL.createObjectURL(await res.blob());
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        link.click();
        URL.revokeObjectURL(url);
      } catch (err) { showError(err.message); }
    });

    const emailBtn = document.getElementById("emailInvoice");
    if (emailBtn) {
      const note = document.getElementById("emailTransportNote");
      const toField = document.getElementById("invoiceEmailTo");
      // Prefill from the matter's client party, and say up front if mail
      // isn't configured rather than failing at the click.
      (async () => {
        try {
          const [transport, preview] = await Promise.all([api("/api/invoices/email-transport"), loadPreview()]);
          toField.value = preview.suggestedTo || "";
          toField.placeholder = preview.suggestedTo ? "" : "no client email on this matter — type one";
          if (transport.canSend) {
            note.textContent = `Sends from ${transport.fromAddress} via ${transport.name}, with the invoice attached as a PDF. A draft is issued only once the email is accepted.`;
          } else {
            note.textContent = "Email isn't configured on this server — use Preview and send the invoice from your own mail client.";
            emailBtn.disabled = true;
          }
        } catch {
          note.textContent = "";
        }
      })();
      emailBtn.addEventListener("click", () => {
        const to = toField.value.trim();
        if (!confirm(`Email ${inv.number} to ${to || "the client"}? This issues the invoice and locks its lines.`)) return;
        return act("email", to ? { to } : {});
      });
    }
  } catch (err) {
    showError(err.message);
  }
}

document.getElementById("loadInvoices").addEventListener("click", loadInvoices);
function downloadOutstandingCsv() {
  showError("");
  if (lastOutstandingRows.length === 0) {
    showError("Nothing to export — nothing is currently outstanding, or the list hasn't loaded yet.");
    return;
  }
  const header = ["Invoice", "Matter ID", "Matter title", "Client", "Balance due", "Due date", "Days overdue", "Times reminded", "Last reminded"];
  const rows = lastOutstandingRows.map((r) => [
    r.number,
    r.matterId,
    r.matterTitle || "",
    r.clientName || "",
    centsToDollars(r.totals.balanceCents),
    r.dueDate || "",
    r.daysOverdue > 0 ? r.daysOverdue : 0,
    r.reminderCount || 0,
    r.lastRemindedAt ? new Date(r.lastRemindedAt).toISOString().slice(0, 10) : "",
  ]);
  downloadCsv(`outstanding-invoices-${new Date().toISOString().slice(0, 10)}.csv`, header, rows);
}

document.getElementById("refreshOutstanding").addEventListener("click", loadOutstanding);
document.getElementById("downloadOutstandingCsv").addEventListener("click", downloadOutstandingCsv);
document.getElementById("navInvoices").addEventListener("click", () => {
  loadOutstanding();
  loadInvoices();
});
document.getElementById("newInvoice").addEventListener("click", async () => {
  showError("");
  try {
    const matterId = document.getElementById("invoiceMatterId").value.trim();
    if (!matterId) { showError("Pick a matter first."); return; }
    const inv = await api(`/api/invoices/matters/${encodeURIComponent(matterId)}`, { method: "POST", body: "{}" });
    await loadInvoices();
    await showInvoice(matterId, inv.id);
    showToast("Draft invoice created.", "success");
  } catch (err) { showError(err.message); }
});

/* ===== Payroll ===== */
function payrollActor() {
  return document.getElementById("payrollActorId").value || currentActorId;
}

async function loadWorkedHours() {
  showError("");
  const list = document.getElementById("workedHoursList");
  try {
    const entries = await api(`/api/payroll/actor/${encodeURIComponent(payrollActor())}/hours`);
    list.innerHTML = "";
    let totalMilli = 0;
    for (const e of entries) {
      totalMilli += e.hoursMilli;
      const li = document.createElement("li");
      li.classList.add("static");
      li.innerHTML = `<span class="badge">${escapeHtml(e.date)}</span>
        <strong>${(e.hoursMilli / 1000).toFixed(2)}h</strong>
        <div class="mt-xs">${escapeHtml(e.description)}</div>`;
      list.appendChild(li);
    }
    if (entries.length === 0) list.innerHTML = '<li class="static empty">No hours recorded.</li>';
    else {
      const li = document.createElement("li");
      li.classList.add("static");
      li.innerHTML = `<strong>Total: ${(totalMilli / 1000).toFixed(2)}h</strong>`;
      list.appendChild(li);
    }
    await loadPayRates();
  } catch (err) {
    showError(err.message);
    list.innerHTML = "";
  }
}

async function loadPayRates() {
  const list = document.getElementById("payRateList");
  try {
    const rates = await api(`/api/payroll/actor/${encodeURIComponent(payrollActor())}/rates`);
    list.innerHTML = "";
    for (const r of rates) {
      const li = document.createElement("li");
      li.classList.add("static");
      li.innerHTML = `<strong>${escapeHtml(centsToDollars(r.hourlyCents))}/hr</strong>
        <span class="badge">from ${escapeHtml(r.effectiveFrom)}</span>
        ${r.note ? `<div class="meta-tight">${escapeHtml(r.note)}</div>` : ""}`;
      list.appendChild(li);
    }
    if (rates.length === 0) list.innerHTML = '<li class="static empty">No rate on record — hours will show but gross pay can\'t be computed.</li>';
  } catch {
    list.innerHTML = '<li class="static empty">Only an attorney can view another person\'s pay rate.</li>';
  }
}

document.getElementById("recordWorkedHours").addEventListener("click", async () => {
  showError("");
  try {
    const hours = Number(document.getElementById("payrollHours").value);
    const description = document.getElementById("payrollDescription").value.trim();
    const date = document.getElementById("payrollDate").value;
    if (!date || !hours || !description) { showError("Date, hours and a description are all required."); return; }
    await api(`/api/payroll/actor/${encodeURIComponent(payrollActor())}/hours`, {
      method: "POST",
      body: JSON.stringify({ date, hoursMilli: Math.round(hours * 1000), description }),
    });
    document.getElementById("payrollHours").value = "";
    document.getElementById("payrollDescription").value = "";
    await loadWorkedHours();
    showToast("Hours recorded.", "success");
  } catch (err) { showError(err.message); }
});

document.getElementById("setPayRate").addEventListener("click", async () => {
  showError("");
  try {
    const hourlyCents = dollarsToCents(document.getElementById("payRateAmount").value);
    const effectiveFrom = document.getElementById("payRateFrom").value;
    if (!hourlyCents || !effectiveFrom) { showError("A rate and an effective date are both required."); return; }
    await api(`/api/payroll/actor/${encodeURIComponent(payrollActor())}/rates`, {
      method: "POST",
      body: JSON.stringify({ hourlyCents, effectiveFrom }),
    });
    document.getElementById("payRateAmount").value = "";
    await loadPayRates();
    showToast("Pay rate set.", "success");
  } catch (err) { showError(err.message); }
});

// Kept around so "Download CSV" exports the same summary currently on
// screen, for the same period, without re-running it.
let lastPayrollSummary = null;

document.getElementById("runPayrollSummary").addEventListener("click", async () => {
  showError("");
  const out = document.getElementById("payrollSummaryResult");
  const list = document.getElementById("payrollSummaryList");
  try {
    const from = document.getElementById("payrollFrom").value;
    const to = document.getElementById("payrollTo").value;
    if (!from || !to) { showError("Pick a period."); return; }
    const r = await api(`/api/payroll/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    lastPayrollSummary = { from, to, ...r };
    out.innerHTML = r.incomplete
      ? `<div class="flags"><strong>Total is understated.</strong> Some worked days have no pay rate on record — gross pay so far is ${escapeHtml(centsToDollars(r.totalGrossPayCents))}.</div>`
      : `<p class="subtitle-inline">Total gross pay: <strong>${escapeHtml(centsToDollars(r.totalGrossPayCents))}</strong></p>`;
    list.innerHTML = "";
    for (const line of r.lines) {
      const li = document.createElement("li");
      li.classList.add("static");
      const name = knownStaff.find((m) => m.actorId === line.actorId)?.displayName || line.actorId;
      li.innerHTML = `<strong>${escapeHtml(name)}</strong>
        <span class="badge">${(line.hoursMilli / 1000).toFixed(2)}h</span>
        <span class="badge approved">${escapeHtml(centsToDollars(line.grossPayCents))}</span>
        ${line.datesMissingRate.length ? `<div class="flags">No rate on record for: ${escapeHtml(line.datesMissingRate.join(", "))}</div>` : ""}`;
      list.appendChild(li);
    }
    if (r.lines.length === 0) list.innerHTML = '<li class="static empty">No hours recorded in this period.</li>';
  } catch (err) {
    showError(err.message);
    out.innerHTML = "";
  }
});

function downloadPayrollCsv() {
  showError("");
  if (!lastPayrollSummary || lastPayrollSummary.lines.length === 0) {
    showError("Nothing to export — run a period summary first.");
    return;
  }
  const header = ["Name", "Hours", "Gross pay", "Dates missing a rate"];
  const rows = lastPayrollSummary.lines.map((line) => [
    knownStaff.find((m) => m.actorId === line.actorId)?.displayName || line.actorId,
    (line.hoursMilli / 1000).toFixed(2),
    centsToDollars(line.grossPayCents),
    line.datesMissingRate.join("; "),
  ]);
  downloadCsv(`payroll-summary-${lastPayrollSummary.from}-to-${lastPayrollSummary.to}.csv`, header, rows);
}

document.getElementById("downloadPayrollCsv").addEventListener("click", downloadPayrollCsv);
document.getElementById("loadWorkedHours").addEventListener("click", loadWorkedHours);
document.getElementById("navPayroll").addEventListener("click", () => {
  // The rate and firm-wide summary cards are attorney-only server-side; hide
  // them for everyone else rather than showing controls that will 403.
  const attorneyOnly = currentRole === "attorney";
  document.getElementById("payRateCard").hidden = !attorneyOnly;
  document.getElementById("payrollSummaryCard").hidden = !attorneyOnly;
  fillPeopleSelect(document.getElementById("payrollActorId"));
  const el = document.getElementById("payrollActorId");
  if (el && currentActorId) el.value = currentActorId;
  loadWorkedHours();
});

/* ===== Time Clock ===== */
/**
 * The elapsed time on an open shift is recomputed client-side once a
 * second so the number on screen doesn't quietly go stale — but only
 * while the panel is actually visible, and it's never what gets stored:
 * a shift's duration always comes from its two server-side timestamps.
 */
let clockTickTimer = null;
let openShiftStartedAt = null;
let openShiftForgotten = false;

function timeClockActor() {
  const el = document.getElementById("timeClockActorId");
  return (el && el.value) || currentActorId;
}

function formatMs(ms) {
  const minutes = Math.round(ms / 60000);
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function formatTimeOfDay(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function renderClockState() {
  const el = document.getElementById("clockState");
  if (!el) return;
  if (!openShiftStartedAt) {
    el.className = "clock-state";
    el.innerHTML = '<span class="pulse"></span>Not clocked in';
    return;
  }
  const elapsed = Date.now() - Date.parse(openShiftStartedAt);
  el.className = `clock-state ${openShiftForgotten ? "stale" : "on"}`;
  el.innerHTML = `<span class="pulse"></span>On the clock — ${escapeHtml(formatMs(elapsed))}
    <span class="elapsed">since ${escapeHtml(formatTimeOfDay(openShiftStartedAt))}</span>
    ${openShiftForgotten ? '<span class="badge rejected">looks like a missed clock-out</span>' : ""}`;
}

function startClockTicking() {
  stopClockTicking();
  clockTickTimer = setInterval(renderClockState, 1000);
}

function stopClockTicking() {
  if (clockTickTimer) clearInterval(clockTickTimer);
  clockTickTimer = null;
}

async function loadClockSummary() {
  const totals = document.getElementById("clockTotals");
  try {
    const s = await api(`/api/time-clock/actor/${encodeURIComponent(currentActorId)}/summary`);
    openShiftStartedAt = s.openShift ? s.openShift.clockInAt : null;
    openShiftForgotten = Boolean(s.openShift && s.openShift.likelyForgotten);
    document.getElementById("clockInBtn").hidden = Boolean(s.openShift);
    document.getElementById("clockOutBtn").hidden = !s.openShift;
    renderClockState();
    if (s.openShift) startClockTicking();
    else stopClockTicking();

    totals.innerHTML = "";
    totals.appendChild(statTile(formatMs(s.today ? s.today.totalMs : 0), "today"));
    totals.appendChild(statTile(formatMs(s.thisWeek ? s.thisWeek.totalMs : 0), "this week"));
    totals.appendChild(statTile(formatMs(s.thisMonth ? s.thisMonth.totalMs : 0), "this month"));
    // "America/New_York" in the tile's display figure can't wrap, and
    // pushed the whole page sideways; the city reads better anyway.
    const zone = String(s.timeZone || "");
    const city = zone.includes("/") ? zone.slice(zone.lastIndexOf("/") + 1).replace(/_/g, " ") : zone;
    totals.appendChild(statTile(city, zone === city ? "firm time zone" : `firm time zone · ${zone}`));
  } catch (err) {
    showError(err.message);
  }
}

async function loadTimesheet() {
  showError("");
  const buckets = document.getElementById("timeBucketList");
  const shifts = document.getElementById("shiftList");
  const actorId = timeClockActor();
  const kind = document.getElementById("timeClockBucket").value;
  const from = document.getElementById("timeClockFrom").value;
  const to = document.getElementById("timeClockTo").value;
  const range = new URLSearchParams();
  if (from) range.set("from", from);
  if (to) range.set("to", to);
  const base = `/api/time-clock/actor/${encodeURIComponent(actorId)}`;
  try {
    const [totals, list] = await Promise.all([
      api(`${base}/totals?${new URLSearchParams({ kind, ...Object.fromEntries(range) })}`),
      api(`${base}/shifts?${range}`),
    ]);

    buckets.innerHTML = "";
    let grandTotalMs = 0;
    for (const b of totals) {
      grandTotalMs += b.totalMs;
      const label = kind === "week" ? `Week of ${b.startDate}` : b.key;
      buckets.appendChild(
        listRow(`<strong>${escapeHtml(label)}</strong>
          <span class="badge approved">${escapeHtml(formatMs(b.totalMs))}</span>
          <span class="badge">${b.shiftCount} shift${b.shiftCount === 1 ? "" : "s"}</span>`),
      );
    }
    if (totals.length === 0) buckets.innerHTML = '<li class="static empty">No completed shifts in this range.</li>';
    else buckets.appendChild(listRow(`<strong>Total: ${escapeHtml(formatMs(grandTotalMs))}</strong>`));

    shifts.innerHTML = "";
    for (const s of list) shifts.appendChild(shiftRow(s));
    if (list.length === 0) shifts.innerHTML = '<li class="static empty">No shifts in this range.</li>';
  } catch (err) {
    showError(err.message);
    buckets.innerHTML = "";
    shifts.innerHTML = "";
  }
}

function shiftRow(s) {
  const li = document.createElement("li");
  li.classList.add("static");
  const posted = Boolean(s.postedPayrollEntryId);
  li.innerHTML = `<span class="badge">${escapeHtml(s.localDate)}</span>
    <strong>${escapeHtml(formatTimeOfDay(s.clockInAt))} → ${s.clockOutAt ? escapeHtml(formatTimeOfDay(s.clockOutAt)) : "still open"}</strong>
    <span class="badge ${s.open ? "pending_review" : "approved"}">${escapeHtml(formatMs(s.durationMs))}${s.open ? " so far" : ""}</span>
    ${posted ? '<span class="badge released">posted to payroll</span>' : ""}
    ${s.likelyForgotten ? '<div class="flags">Open for more than 16 hours — almost certainly a missed clock-out. An attorney can correct it below.</div>' : ""}
    ${s.note ? `<div class="meta-tight">${escapeHtml(s.note)}</div>` : ""}
    ${s.corrections
      .map(
        (c) =>
          `<div class="meta-xs">Corrected ${escapeHtml(formatTimeOfDay(c.at))} by ${escapeHtml(c.by)} — ${escapeHtml(c.reason)}
           (was ${escapeHtml(formatTimeOfDay(c.previousClockInAt))} → ${c.previousClockOutAt ? escapeHtml(formatTimeOfDay(c.previousClockOutAt)) : "open"})</div>`,
      )
      .join("")}`;

  // Corrections and payroll posting are attorney-only server-side; don't
  // offer buttons to a role that would only get a 403 back.
  if (currentRole === "attorney" && !posted) {
    const actions = document.createElement("div");
    actions.className = "mt-md";
    actions.appendChild(mkButton("Correct punch", () => toggleShiftCorrection(s, li)));
    if (!s.open) {
      const post = mkButton("Post to payroll", () => postShiftToPayroll(s));
      post.classList.add("primary");
      actions.appendChild(post);
    }
    li.appendChild(actions);
  }
  return li;
}

/** An ISO instant as a datetime-local value in this browser's own zone. */
function toLocalInputValue(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Correcting a punch, in the corrector's own local time. This used to be
 * two prompt boxes asking for "ISO 8601, e.g. 2026-07-26T09:00:00Z" —
 * so an attorney fixing a 9am start typed 09:00Z, which is UTC, and the
 * shift moved by however far they are from Greenwich. The pickers here
 * are local, prefilled with the current punches, and converted to an
 * instant before they're sent; the server refuses a time without a zone.
 */
function toggleShiftCorrection(s, li) {
  showError("");
  const existing = li.querySelector(".shift-correction");
  if (existing) {
    existing.remove();
    return;
  }
  const form = document.createElement("div");
  form.className = "shift-correction mt-xs";
  const row = document.createElement("div");
  row.className = "field-row";
  const field = (label, input) => {
    const el = document.createElement("label");
    el.className = "field";
    el.append(label, input);
    row.appendChild(el);
    return input;
  };
  const clockIn = document.createElement("input");
  clockIn.type = "datetime-local";
  clockIn.value = toLocalInputValue(s.clockInAt);
  clockIn.max = toLocalInputValue(new Date().toISOString());
  field("Clock in", clockIn);
  const clockOut = document.createElement("input");
  clockOut.type = "datetime-local";
  clockOut.value = s.clockOutAt ? toLocalInputValue(s.clockOutAt) : "";
  clockOut.max = clockIn.max;
  field("Clock out", clockOut);
  const reason = document.createElement("input");
  reason.type = "text";
  reason.maxLength = 500;
  reason.placeholder = "e.g. forgot to clock out";
  field("Why (kept on the record)", reason);
  form.appendChild(row);

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "this device's time zone";
  const note = document.createElement("p");
  note.className = "meta-xs";
  note.textContent = `Times are in your time zone (${zone}).${s.open ? " Leave clock-out empty to keep the shift open." : ""}`;
  form.appendChild(note);

  const save = mkButton("Save correction", async () => {
    showError("");
    if (!clockIn.value) return showError("Choose the clock-in time.");
    if (!reason.value.trim()) return showError("Say why the punch is being corrected — it's kept on the shift's record.");
    if (!s.open && !clockOut.value) return showError("Choose the clock-out time.");
    const body = { reason: reason.value.trim() };
    const nextIn = new Date(clockIn.value).toISOString();
    // Only what moved is sent; seconds the picker can't show aren't "changes".
    if (toLocalInputValue(s.clockInAt) !== clockIn.value) body.clockInAt = nextIn;
    if (clockOut.value && (!s.clockOutAt || toLocalInputValue(s.clockOutAt) !== clockOut.value)) {
      body.clockOutAt = new Date(clockOut.value).toISOString();
    }
    if (!body.clockInAt && !body.clockOutAt) return showError("Nothing changed — move the clock-in or clock-out first.");
    try {
      await api(`/api/time-clock/shifts/${encodeURIComponent(s.id)}/adjust`, { method: "POST", body: JSON.stringify(body) });
      await loadTimesheet();
      await loadClockSummary();
      showToast("Punch corrected.", "success");
    } catch (err) {
      showError(err.message);
    }
  });
  save.classList.add("primary");
  const actions = document.createElement("div");
  actions.className = "mt-xs";
  actions.append(save, mkButton("Cancel", () => form.remove()));
  form.appendChild(actions);
  li.appendChild(form);
  clockIn.focus();
}

async function postShiftToPayroll(s) {
  showError("");
  if (!confirm(`Post ${formatMs(s.durationMs)} on ${s.localDate} to payroll? The shift can't be corrected afterwards.`)) return;
  try {
    await api(`/api/time-clock/shifts/${encodeURIComponent(s.id)}/post-to-payroll`, { method: "POST", body: "{}" });
    await loadTimesheet();
    showToast("Posted to payroll.", "success");
  } catch (err) { showError(err.message); }
}

async function loadOnTheClock() {
  const list = document.getElementById("onTheClockList");
  try {
    const open = await api("/api/time-clock/on-the-clock");
    list.innerHTML = "";
    for (const s of open) {
      const name = knownStaff.find((m) => m.actorId === s.actorId)?.displayName || s.actorId;
      list.appendChild(
        listRow(`<strong>${escapeHtml(name)}</strong>
          <span class="badge ${s.likelyForgotten ? "rejected" : "approved"}">${escapeHtml(formatMs(s.durationMs))}</span>
          <div class="meta-tight">Since ${escapeHtml(formatTimeOfDay(s.clockInAt))}${s.likelyForgotten ? " — probably forgot to clock out" : ""}</div>`),
      );
    }
    if (open.length === 0) list.innerHTML = '<li class="static empty">Nobody is on the clock right now.</li>';
  } catch {
    list.innerHTML = '<li class="static empty">Seeing everyone on the clock is attorney-only.</li>';
  }
}

async function punch(action) {
  showError("");
  const noteEl = document.getElementById("clockNote");
  try {
    const note = noteEl.value.trim();
    await api(`/api/time-clock/${action}`, { method: "POST", body: JSON.stringify(note ? { note } : {}) });
    noteEl.value = "";
    await loadClockSummary();
    await loadTimesheet();
    if (currentRole === "attorney") await loadOnTheClock();
    showToast(action === "clock-in" ? "Clocked in." : "Clocked out.", "success");
  } catch (err) { showError(err.message); }
}

document.getElementById("clockInBtn").addEventListener("click", () => punch("clock-in"));
document.getElementById("clockOutBtn").addEventListener("click", () => punch("clock-out"));
document.getElementById("loadTimesheet").addEventListener("click", loadTimesheet);
document.getElementById("refreshOnTheClock").addEventListener("click", loadOnTheClock);
document.getElementById("timeClockActorId").addEventListener("change", loadTimesheet);
document.getElementById("timeClockBucket").addEventListener("change", loadTimesheet);

document.getElementById("navTimeClock").addEventListener("click", () => {
  const isAttorney = currentRole === "attorney";
  document.getElementById("onTheClockCard").hidden = !isAttorney;
  // Viewing someone else's timesheet is attorney-only, so for everyone
  // else there's nothing to pick between — hide the picker rather than
  // offer a choice that 403s.
  const picker = document.getElementById("timeClockActorId");
  document.getElementById("timeClockPersonField").hidden = !isAttorney;
  if (isAttorney) fillPeopleSelect(picker);
  else {
    picker.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = currentActorId;
    opt.textContent = "you";
    picker.appendChild(opt);
  }
  if (currentActorId && [...picker.options].some((o) => o.value === currentActorId)) picker.value = currentActorId;
  loadClockSummary();
  loadTimesheet();
  if (isAttorney) loadOnTheClock();
});

// A panel that isn't on screen shouldn't be re-rendering a ticking clock.
for (const btn of document.querySelectorAll("nav.nav button")) {
  btn.addEventListener("click", () => {
    if (btn.dataset.panel !== "time-clock") stopClockTicking();
  });
}
