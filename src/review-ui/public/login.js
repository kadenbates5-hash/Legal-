/**
 * Two-step sign-in. The code field stays hidden until the server says
 * this account has a second factor: most accounts don't, and a field
 * asking for a code you don't have is the sort of thing that makes
 * people think they're on the wrong page.
 */
document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("error");
  const mfaField = document.getElementById("mfaField");
  const mfaCode = document.getElementById("mfaCode");
  errorEl.textContent = "";
  errorEl.classList.remove("notice");
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        username: document.getElementById("username").value,
        password: document.getElementById("password").value,
        remember: document.getElementById("remember").checked,
        mfaCode: mfaCode.value.trim(),
      }),
    });
    const body = await res.json();
    if (body.mfaRequired) {
      // The password was right; this is the normal first half of the
      // flow, not a failure — so it reads as a prompt, not an error.
      mfaField.hidden = false;
      mfaCode.focus();
      errorEl.classList.add("notice");
      errorEl.textContent = "Enter the code from your authenticator app.";
      return;
    }
    if (!res.ok) throw new Error(body.error || "sign-in failed");
    window.location.href = "/";
  } catch (err) {
    mfaCode.value = "";
    errorEl.textContent = err.message;
  }
});
