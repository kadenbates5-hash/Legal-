document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("error");
  errorEl.textContent = "";
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        username: document.getElementById("username").value,
        password: document.getElementById("password").value,
        remember: document.getElementById("remember").checked,
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "sign-in failed");
    window.location.href = "/";
  } catch (err) {
    errorEl.textContent = err.message;
  }
});
