/**
 * Always shows the same message regardless of what the server actually
 * did — the server itself never reveals whether the username existed
 * or had an email on file, so there is nothing more specific this page
 * could honestly show anyway.
 */
document.getElementById("forgotForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = document.getElementById("forgotForm");
  const errorEl = document.getElementById("error");
  errorEl.textContent = "";
  errorEl.classList.remove("notice");
  try {
    const res = await fetch("/api/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ username: document.getElementById("username").value }),
    });
    const body = await res.json();
    form.hidden = true;
    errorEl.classList.add("notice");
    errorEl.textContent = body.message || "Check your email for a reset link.";
  } catch {
    errorEl.textContent = "Something went wrong — try again in a moment.";
  }
});
