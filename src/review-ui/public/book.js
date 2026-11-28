/*
 * The public booking page. No session, no account — it asks the server
 * for what to show (`/api/public/booking/config`) and sends one request
 * (`/api/public/booking/requests`). What it collects is deliberately
 * narrow; see core/booking-requests.ts for why there's no "what
 * happened" box. An urgent situation is never sent at all: ticking the
 * urgent box replaces the form with "call us now".
 */
(() => {
  const $ = (id) => document.getElementById(id);

  function localDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function showError(message) {
    $("error").textContent = message || "";
  }

  async function init() {
    let config;
    try {
      const res = await fetch("/api/public/booking/config", { credentials: "omit" });
      if (!res.ok) throw new Error("unavailable");
      config = await res.json();
    } catch {
      $("bookForm").hidden = true;
      $("unavailable").hidden = false;
      return;
    }

    // Without a configured firm name, say nothing rather than a placeholder.
    $("firmName").textContent = config.firmName || "";
    if (config.firmName) document.title = `Request a consultation · ${config.firmName}`;
    $("urgentPhone").textContent = config.phone ? ` on ${config.phone}` : "";

    const select = $("matterType");
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choose one";
    select.appendChild(placeholder);
    for (const type of config.matterTypes) {
      const option = document.createElement("option");
      option.value = type.id;
      option.textContent = type.label;
      select.appendChild(option);
    }

    // The firm's today, from the server, so the picker opens on the same
    // window the server checks — a visitor in another zone, or a device
    // with its clock wrong, otherwise picks a day that's then refused.
    const [y, m, d] = /^\d{4}-\d{2}-\d{2}$/.test(config.today || "")
      ? config.today.split("-").map(Number)
      : [new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate()];
    $("preferredDate").min = localDate(new Date(y, m - 1, d));
    $("preferredDate").max = localDate(new Date(y, m - 1, d + config.maxDaysAhead));

    $("isUrgent").addEventListener("change", (e) => {
      const urgent = e.target.checked;
      $("urgentNotice").hidden = !urgent;
      $("restOfForm").hidden = urgent;
      showError("");
    });

    $("bookForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      showError("");
      if ($("isUrgent").checked) return;
      const button = $("submitBtn");
      button.disabled = true;
      button.textContent = "Sending…";
      try {
        const res = await fetch("/api/public/booking/requests", {
          method: "POST",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: $("name").value,
            email: $("email").value,
            phone: $("phone").value,
            matterType: $("matterType").value,
            otherPartyName: $("otherPartyName").value,
            preferredDate: $("preferredDate").value,
            preferredTime: $("preferredTime").value,
            website: $("website").value,
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          showError(body.error || "Something went wrong. Please try again, or call the office.");
          return;
        }
        $("bookForm").hidden = true;
        $("done").hidden = false;
      } catch {
        showError("We couldn't reach the server. Please try again, or call the office.");
      } finally {
        button.disabled = false;
        button.textContent = "Request a time";
      }
    });
  }

  void init();
})();
