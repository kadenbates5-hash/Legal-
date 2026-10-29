const token = new URLSearchParams(window.location.search).get("token");

if (!token) {
  document.getElementById("resetForm").hidden = true;
  const errorEl = document.getElementById("error");
  errorEl.textContent = "This link is missing its reset token — request a new one from the sign-in page.";
}

document.getElementById("resetForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("error");
  errorEl.textContent = "";
  errorEl.classList.remove("notice");

  const newPassword = document.getElementById("newPassword").value;
  const confirmPassword = document.getElementById("confirmPassword").value;
  if (newPassword !== confirmPassword) {
    errorEl.textContent = "Those two passwords don't match.";
    return;
  }

  try {
    const res = await fetch("/api/reset-password/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ token, newPassword }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "couldn't reset your password");

    document.getElementById("resetForm").hidden = true;
    errorEl.classList.add("notice");
    errorEl.textContent = "Password set. Redirecting to sign in…";
    setTimeout(() => {
      window.location.href = "/login.html";
    }, 1800);
  } catch (err) {
    errorEl.textContent = err.message;
  }
});
