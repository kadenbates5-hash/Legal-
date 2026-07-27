const PANEL_TITLES = {
  home: "Home",
  search: "Search",
  queue: "Review Queue",
  deadlines: "Deadlines",
  scheduling: "Scheduling",
  intake: "Live Intake Demo",
  drafting: "Drafting",
  cases: "Cases",
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
  audit: "Audit Log",
};

for (const btn of document.querySelectorAll("nav.nav button")) {
  btn.addEventListener("click", () => {
    const panel = btn.dataset.panel;
    for (const b of document.querySelectorAll("nav.nav button")) b.classList.toggle("active", b === btn);
    for (const s of document.querySelectorAll("section.panel")) s.classList.toggle("active", s.id === `panel-${panel}`);
    document.getElementById("panelTitle").textContent = PANEL_TITLES[panel] || "";
    if (["messages", "staff-schedule", "drafting", "billing", "research", "cases", "scheduling", "conflicts", "trust", "invoices", "payroll"].includes(panel)) {
      refreshPickers();
    }
    if (panel === "home") loadHome();
    if (panel === "security") loadMfaStatus();
  });
}

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

let currentRole = null;
let currentActorId = null;

async function loadWhoami() {
  try {
    const me = await api("/api/me");
    currentRole = me.role;
    currentActorId = me.id;
    document.getElementById("whoami").textContent = `Signed in as ${me.username || me.id} (${me.role})`;
    if (me.mustChangePassword) {
      showError("An attorney reset your password — please change it (top right) to one only you know.");
    }
    if (me.role === "client") {
      // A client sees only its own matters plus its own login security —
      // everything else here is a firm-internal surface (staff directory,
      // messaging, scheduling, billing internals) that a client account
      // has no server-side access to anyway; hiding the nav for it is
      // just not showing doors that would all 403.
      for (const btn of document.querySelectorAll("nav.nav button")) {
        if (btn.id !== "navMyMatters" && btn.dataset.panel !== "security") btn.hidden = true;
      }
      document.getElementById("navMyMatters").hidden = false;
      document.getElementById("navMyMatters").click();
      loadMyMatters();
      return;
    }
    if (me.role === "attorney") {
      document.getElementById("navAccounts").hidden = false;
      document.getElementById("navAudit").hidden = false;
    }
    if (me.role === "attorney" || me.role === "paralegal") {
      document.getElementById("globalSearch").hidden = false;
      document.getElementById("navDrafting").hidden = false;
      document.getElementById("navCases").hidden = false;
      document.getElementById("navConflicts").hidden = false;
      document.getElementById("navResearch").hidden = false;
      document.getElementById("navAssistant").hidden = false;
      document.getElementById("navBilling").hidden = false;
      document.getElementById("navTrust").hidden = false;
      document.getElementById("navInvoices").hidden = false;
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
    // Pickers first: Home greets you by display name, which comes from the
    // staff directory those pickers load.
    await refreshPeoplePickers();
    refreshMatterOptions();
    loadHome();
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

async function loadUpcomingDeadlines() {
  const list = document.getElementById("upcomingList");
  if (currentRole && currentRole !== "attorney") {
    renderAttorneyOnly("upcomingList", "Deadlines are attorney-only.");
    return;
  }
  try {
    const withinDays = Number(document.getElementById("deadlineHorizon").value) || 14;
    const due = await api(`/api/deadlines/upcoming?withinDays=${withinDays}`);
    list.innerHTML = "";
    for (const d of due) list.appendChild(listRow(deadlineRowHtml(d)));
    if (due.length === 0) {
      list.innerHTML = `<li class="static empty">Nothing due in the next ${withinDays} days. Deadlines only appear here once someone has recorded one.</li>`;
    }
  } catch (err) {
    showError(err.message);
  }
}

function renderAttorneyOnly(listId, message) {
  document.getElementById(listId).innerHTML = `<li class="static empty">${message}</li>`;
}

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

document.getElementById("mfaBeginBtn").addEventListener("click", async () => {
  showError("");
  try {
    const { secret, uri } = await api("/api/mfa/begin", { method: "POST" });
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
      list.innerHTML = '<li class="static empty">No matters on file for you yet. If you were expecting to see one here, ask the firm to grant portal access.</li>';
    } else if (matters.length === 1) {
      // The common case — a client with one matter shouldn't have to click through to it.
      openMyMatter(matters[0].matterId);
    }
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
        return `<li class="static">
          <strong>Invoice ${escapeHtml(inv.number)}</strong>
          <span class="badge ${statusBadge}">${escapeHtml(inv.status)}</span>
          <span class="meta-xs">balance ${escapeHtml(centsToDollars(inv.totals.balanceCents))} of ${escapeHtml(centsToDollars(inv.totals.subtotalCents))}</span>
          <div class="mt-xs">
            <button class="btn" data-preview="${inv.id}">View itemization</button>
            <a class="btn" href="/api/client-portal/matters/${encodeURIComponent(matterId)}/invoices/${inv.id}/pdf">Download PDF</a>
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
      </div>`;

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
    const opt = document.createElement("option");
    opt.value = m.actorId;
    opt.textContent = `${m.displayName} (${m.role})`;
    el.appendChild(opt);
  }
  if (previous && knownStaff.some((m) => m.actorId === previous)) el.value = previous;
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
  // Default the schedule pickers to yourself — by far the common case.
  for (const id of ["scheduleActorId", "scheduleViewActorId"]) {
    const el = document.getElementById(id);
    if (el && me && knownStaff.some((m) => m.actorId === me)) el.value = me;
  }
}

async function refreshMatterOptions() {
  const list = document.getElementById("matterOptions");
  if (!list) return;
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
    if (items.length === 0) list.innerHTML = '<li class="static empty">No work product pending review.</li>';
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

async function act(path, body, id) {
  showError("");
  try {
    await api(path, { method: "POST", body: JSON.stringify(body) });
    await loadQueue();
    await loadDetail(id);
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
  try {
    await api("/api/deadlines/confirm", {
      method: "POST",
      body: JSON.stringify({
        matterId: document.getElementById("deadlineMatterId").value,
        type: document.getElementById("deadlineType").value,
        date: document.getElementById("deadlineDate").value,
        source: document.getElementById("deadlineSource").value,
      }),
    });
    await checkDeadline();
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

document.getElementById("checkDeadline").addEventListener("click", checkDeadline);
document.getElementById("loadUpcoming").addEventListener("click", loadUpcomingDeadlines);
document.getElementById("confirmDeadline").addEventListener("click", confirmDeadline);

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
        allowOutsideBusinessHours: document.getElementById("apptOverrideHours").checked,
      }),
    });
    document.getElementById("scheduleListMatterId").value = document.getElementById("apptMatterId").value;
    await loadAppointments();
    await loadDueReminders();
  } catch (err) {
    showError(err.message);
  }
}

async function loadAppointments() {
  showError("");
  try {
    const matterId = document.getElementById("scheduleListMatterId").value;
    const items = await api(`/api/appointments?matterId=${encodeURIComponent(matterId)}`);
    const list = document.getElementById("appointmentList");
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
          await api(`/api/appointments/${appt.id}/cancel`, { method: "POST", body: JSON.stringify({ reason }) });
          await loadAppointments();
        });
        cancelBtn.classList.add("danger");
        const completeBtn = mkButton("Complete", async () => {
          await api(`/api/appointments/${appt.id}/complete`, { method: "POST", body: "{}" });
          await loadAppointments();
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
loadAppointments();
loadDueReminders();

/* ===== Live Intake Demo ===== */
let intakeSessionId = null;

function appendBubble(kind, text) {
  const log = document.getElementById("chatLog");
  const bubble = document.createElement("div");
  bubble.className = `bubble ${kind}`;
  bubble.textContent = text;
  log.appendChild(bubble);
  log.scrollTop = log.scrollHeight;
}

async function startIntake() {
  showError("");
  try {
    document.getElementById("chatLog").innerHTML = "";
    const { sessionId, reply } = await api("/api/intake/start", { method: "POST", body: "{}" });
    intakeSessionId = sessionId;
    appendBubble("agent", reply);
    document.getElementById("chatText").disabled = false;
    document.getElementById("chatSend").disabled = false;
    document.getElementById("chatText").focus();
  } catch (err) {
    showError(err.message);
  }
}

async function sendChat() {
  const input = document.getElementById("chatText");
  const text = input.value.trim();
  if (!text || !intakeSessionId) return;
  appendBubble("caller", text);
  input.value = "";
  showError("");
  try {
    const { reply, done } = await api(`/api/intake/${intakeSessionId}/message`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    appendBubble("agent", reply);
    if (done) {
      appendBubble("system", "Conversation ended. Start a new one to try another scenario.");
      input.disabled = true;
      document.getElementById("chatSend").disabled = true;
      intakeSessionId = null;
    }
  } catch (err) {
    showError(err.message);
  }
}

document.getElementById("startIntake").addEventListener("click", startIntake);
document.getElementById("chatSend").addEventListener("click", sendChat);
document.getElementById("chatText").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});

/* ===== Drafting ===== */
function draftingMatterId() {
  return document.getElementById("draftingMatterId").value;
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
  try {
    const items = await api(`/api/drafting/matters/${encodeURIComponent(draftingMatterId())}`);
    const list = document.getElementById("draftingList");
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
    await api(`/api/drafting/matters/${encodeURIComponent(draftingMatterId())}/draft-template`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    document.getElementById("draftTemplateContent").value = "";
    document.getElementById("draftDeadlineDate").value = "";
    await loadMatterDrafts();
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
    await api(`/api/drafting/matters/${encodeURIComponent(draftingMatterId())}/draft-research`, {
      method: "POST",
      body: JSON.stringify({ content: document.getElementById("researchContent").value, citations }),
    });
    document.getElementById("researchContent").value = "";
    document.getElementById("researchCitations").value = "";
    await loadMatterDrafts();
  } catch (err) {
    showError(err.message);
  }
}

async function createBillingDraft() {
  showError("");
  try {
    await api(`/api/drafting/matters/${encodeURIComponent(draftingMatterId())}/draft-billing`, {
      method: "POST",
      body: JSON.stringify({ content: document.getElementById("billingContent").value }),
    });
    document.getElementById("billingContent").value = "";
    await loadMatterDrafts();
  } catch (err) {
    showError(err.message);
  }
}

document.getElementById("loadMatterDrafts").addEventListener("click", loadMatterDrafts);
document.getElementById("createTemplateDraft").addEventListener("click", createTemplateDraft);
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
    if (items.length === 0) list.innerHTML = '<li class="static empty">No cases yet — draft something or upload a document to a matter.</li>';
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
    `;

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
  try {
    const matterId = document.getElementById("researchMatterId").value;
    const refs = await api(`/api/research/matters/${encodeURIComponent(matterId)}`);
    const list = document.getElementById("researchSavedList");
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

function appendMessageBubble(logId, message) {
  const log = document.getElementById(logId);
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const time = new Date(message.sentAt).toLocaleString();
  bubble.innerHTML = `<strong>${escapeHtml(message.senderName)}</strong> <span class="meta-xs">${time}</span><div>${escapeHtml(message.body)}</div>`;
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
      li.innerHTML = `<strong>${escapeHtml(label || "(conversation)")}</strong> <span class="badge">${escapeHtml(conversation.kind)}</span>`;
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
    await loadConversations();
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
    await loadConversations();
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
  } catch (err) {
    showError(err.message);
  }
});

async function loadBillingMatter() {
  showError("");
  try {
    const matterId = document.getElementById("billingMatterId").value.trim();
    if (!matterId) return;
    const entries = await api(`/api/billing-hours/matters/${encodeURIComponent(matterId)}`);
    renderBillingEntries("billingMatterList", entries, { showActorId: true });
  } catch (err) {
    showError(err.message);
  }
}

async function loadMyBillingHours() {
  showError("");
  try {
    const entries = await api("/api/billing-hours/mine");
    renderBillingEntries("billingMineList", entries, { showActorId: false });
  } catch (err) {
    showError(err.message);
  }
}

document.getElementById("loadBillingMatter").addEventListener("click", loadBillingMatter);
document.getElementById("loadMyBillingHours").addEventListener("click", loadMyBillingHours);
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
        ${acct.mfaEnabled ? `<span class="badge approved">2FA · ${acct.recoveryCodesRemaining} codes left</span>` : ""}`;
      const toggleBtn = mkButton(acct.disabled ? "Enable" : "Disable", async () => {
        showError("");
        try {
          await api(`/api/accounts/${acct.id}/${acct.disabled ? "enable" : "disable"}`, { method: "POST", body: "{}" });
          await loadAccounts();
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
        } catch (err) {
          showError(err.message);
        }
      });
      li.appendChild(document.createElement("br"));
      li.append(toggleBtn, resetBtn);

      // Only offered where there's something to clear. This is a real
      // bypass of someone else's second factor — the confirm spells that
      // out, and the action is recorded in the audit log either way.
      if (acct.mfaEnabled) {
        li.append(
          mkButton("Reset 2FA", async () => {
            showError("");
            if (!confirm(`Turn off two-factor authentication for ${acct.username}?\n\nThey will be able to sign in with their password alone until they set it up again. This is recorded in the audit log.`)) return;
            try {
              await api(`/api/accounts/${acct.id}/reset-mfa`, { method: "POST", body: "{}" });
              await loadAccounts();
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
            await api(`/api/accounts/${acct.id}/grant-matter-access`, {
              method: "POST",
              body: JSON.stringify({ matterId: matterInput.value.trim() }),
            });
            matterInput.value = "";
            await loadAccounts();
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
    const password = document.getElementById("newAccountPassword").value;
    const role = document.getElementById("newAccountRole").value;
    await api("/api/accounts", { method: "POST", body: JSON.stringify({ username, displayName, password, role }) });
    document.getElementById("newAccountUsername").value = "";
    document.getElementById("newAccountDisplayName").value = "";
    document.getElementById("newAccountPassword").value = "";
    await loadAccounts();
  } catch (err) {
    showError(err.message);
  }
}

document.getElementById("createAccount").addEventListener("click", createAccount);
document.getElementById("refreshAccounts").addEventListener("click", loadAccounts);
document.getElementById("navAccounts").addEventListener("click", loadAccounts);

/* ===== Audit Log ===== */
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
  if (btn) btn.click();
}

function statTile(n, label, { tone = "", panel = null } = {}) {
  const el = document.createElement("div");
  el.className = `stat ${tone}${panel ? " clickable" : ""}`.trim();
  el.innerHTML = `<div class="n">${escapeHtml(String(n))}</div><div class="k">${escapeHtml(label)}</div>`;
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

async function loadHome() {
  const stats = document.getElementById("homeStats");
  const attention = document.getElementById("homeAttention");
  const today = document.getElementById("homeToday");
  if (!stats) return;

  const me = knownStaff.find((m) => m.actorId === currentActorId);
  document.getElementById("homeGreeting").textContent = me
    ? `Signed in as ${me.displayName}. Here's what needs you.`
    : "Everything that needs you, in one place.";

  stats.innerHTML = "";
  attention.innerHTML = '<li class="static empty">Loading…</li>';
  today.innerHTML = '<li class="static empty">Loading…</li>';

  const isAttorney = currentRole === "attorney";
  const canDraft = isAttorney || currentRole === "paralegal";

  const [pending, conflicts, upcoming, cases, myHours, announcements, schedule, clock, outstanding] = await Promise.all([
    isAttorney ? tryApi("/api/work-products?status=pending_review") : null,
    isAttorney ? tryApi("/api/deadlines/conflicts") : null,
    isAttorney ? tryApi("/api/deadlines/upcoming?withinDays=14") : null,
    canDraft ? tryApi("/api/cases") : null,
    canDraft ? tryApi("/api/billing-hours/mine") : null,
    tryApi("/api/messages/announcements"),
    tryApi(`/api/staff-schedule/date/${todayIso()}`),
    currentActorId ? tryApi(`/api/time-clock/actor/${encodeURIComponent(currentActorId)}/summary`) : null,
    canDraft ? tryApi("/api/invoices/outstanding") : null,
  ]);

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
    attention.innerHTML = `<li class="static empty">${
      isAttorney ? "Nothing pending — the review queue is clear." : "Nothing assigned to you right now."
    }</li>`;
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
      list.innerHTML = '<li class="static empty">No matches. Matters you aren\'t assigned to are never included.</li>';
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

/**
 * A party is written as `Name` or `Name <email@example.com>` — the same
 * shape as an email "To:" field, so it needs no explanation. The email
 * has to round-trip through this textarea: a save rebuilds the whole
 * party list, so anything the editor can't display it would silently
 * delete, and the client's address is what the Invoices panel emails a
 * bill to.
 */
function partyToLine(party) {
  return party.email ? `${party.name} <${party.email}>` : party.name;
}

function lineToParty(line, role) {
  const match = /^(.*?)\s*<([^>]+)>\s*$/.exec(line);
  return match
    ? { name: match[1].trim(), role, email: match[2].trim() }
    : { name: line, role };
}

function partiesToTextareas(matter) {
  const pick = (role) =>
    (matter.parties || [])
      .filter((p) => p.role === role)
      .map(partyToLine)
      .join("\n");
  document.getElementById("matterClients").value = pick("client");
  document.getElementById("matterAdverse").value = pick("adverse");
}

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
    partiesToTextareas(matter);
    renderMatterLifecycle(matter);
  } catch (err) {
    // A matter with no record yet is the normal case, not an error worth shouting about.
    if (/no matter/i.test(err.message)) {
      document.getElementById("matterTitle").value = "";
      document.getElementById("matterClients").value = "";
      document.getElementById("matterAdverse").value = "";
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
    ];
    await api(`/api/matters/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({
        title: document.getElementById("matterTitle").value.trim(),
        status: document.getElementById("matterStatus").value,
        parties,
      }),
    });
    await loadMatterList();
    await refreshMatterOptions();
    showError("Matter record saved.");
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
  } catch (err) {
    showError(err.message);
  }
}

/** The accounts-receivable view: unpaid issued invoices, most overdue first. */
async function loadOutstanding() {
  const list = document.getElementById("outstandingList");
  const summary = document.getElementById("outstandingSummary");
  try {
    const [rows, canRemind] = await Promise.all([api("/api/invoices/outstanding"), emailTransportReady()]);
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
document.getElementById("refreshOutstanding").addEventListener("click", loadOutstanding);
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
  } catch (err) { showError(err.message); }
});

document.getElementById("runPayrollSummary").addEventListener("click", async () => {
  showError("");
  const out = document.getElementById("payrollSummaryResult");
  const list = document.getElementById("payrollSummaryList");
  try {
    const from = document.getElementById("payrollFrom").value;
    const to = document.getElementById("payrollTo").value;
    if (!from || !to) { showError("Pick a period."); return; }
    const r = await api(`/api/payroll/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
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
    totals.appendChild(statTile(s.timeZone, "firm timezone"));
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
    actions.appendChild(mkButton("Correct punch", () => correctShift(s)));
    if (!s.open) {
      const post = mkButton("Post to payroll", () => postShiftToPayroll(s));
      post.classList.add("primary");
      actions.appendChild(post);
    }
    li.appendChild(actions);
  }
  return li;
}

/**
 * Corrections take full ISO timestamps because a punch is an instant,
 * not a date — and the firm's day boundary is a timezone away from UTC.
 * Prefilling with the current values means the common case (fixing only
 * the clock-out) is a single edit.
 */
async function correctShift(s) {
  showError("");
  const clockInAt = prompt("Clock-in time (ISO 8601, e.g. 2026-07-26T09:00:00Z):", s.clockInAt);
  if (clockInAt === null) return;
  const clockOutAt = prompt("Clock-out time (ISO 8601), or leave blank to keep it open:", s.clockOutAt || "");
  if (clockOutAt === null) return;
  const reason = prompt("Why is this being corrected? (kept on the record)");
  if (!reason) return;
  try {
    await api(`/api/time-clock/shifts/${encodeURIComponent(s.id)}/adjust`, {
      method: "POST",
      body: JSON.stringify({ clockInAt, ...(clockOutAt.trim() ? { clockOutAt: clockOutAt.trim() } : {}), reason }),
    });
    await loadTimesheet();
    await loadClockSummary();
  } catch (err) { showError(err.message); }
}

async function postShiftToPayroll(s) {
  showError("");
  if (!confirm(`Post ${formatMs(s.durationMs)} on ${s.localDate} to payroll? The shift can't be corrected afterwards.`)) return;
  try {
    await api(`/api/time-clock/shifts/${encodeURIComponent(s.id)}/post-to-payroll`, { method: "POST", body: "{}" });
    await loadTimesheet();
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
