// Same best-effort registration as app.js — see sw.js's doc comment.
// Registered from here too so a PWA install prompt can fire from the
// login page itself, before anyone's signed in.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}

/* WebAuthn's JSON<->ArrayBuffer translation — see app.js's identical
   copy for why this is hand-rolled rather than a client library: no
   bundler on this page and the CSP only loads scripts from 'self'. */
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

async function performPasskeyAuthentication(optionsJSON) {
  const publicKey = {
    ...optionsJSON,
    challenge: base64urlToBuffer(optionsJSON.challenge),
    allowCredentials: (optionsJSON.allowCredentials || []).map((c) => ({ ...c, id: base64urlToBuffer(c.id) })),
  };
  const credential = await navigator.credentials.get({ publicKey });
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
      authenticatorData: bufferToBase64url(credential.response.authenticatorData),
      signature: bufferToBase64url(credential.response.signature),
      userHandle: credential.response.userHandle ? bufferToBase64url(credential.response.userHandle) : undefined,
    },
    clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
  };
}

const errorEl = document.getElementById("error");
const mfaField = document.getElementById("mfaField");
const mfaCode = document.getElementById("mfaCode");
const passkeyBtn = document.getElementById("passkeyLoginBtn");

function showNotice(message) {
  errorEl.classList.add("notice");
  errorEl.textContent = message;
}

function showFailure(message) {
  errorEl.classList.remove("notice");
  errorEl.textContent = message;
}

/**
 * Two-step sign-in. The code field (and, once a passkey is on file, the
 * "use a passkey instead" link) stay hidden until the server confirms
 * this account has a second factor: most accounts don't, and prompting
 * for one you don't have is the sort of thing that makes people think
 * they're on the wrong page.
 */
document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  showFailure("");
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
      passkeyBtn.hidden = !body.hasPasskey;
      mfaCode.focus();
      showNotice(body.hasPasskey ? "Enter the code from your authenticator app, or use a passkey instead." : "Enter the code from your authenticator app.");
      return;
    }
    if (!res.ok) throw new Error(body.error || "sign-in failed");
    window.location.href = "/";
  } catch (err) {
    mfaCode.value = "";
    showFailure(err.message);
  }
});

passkeyBtn.addEventListener("click", async () => {
  showFailure("");
  const username = document.getElementById("username").value;
  const password = document.getElementById("password").value;
  const remember = document.getElementById("remember").checked;
  try {
    const beginRes = await fetch("/api/login/passkey/begin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ username, password }),
    });
    const options = await beginRes.json();
    if (!beginRes.ok) throw new Error(options.error || "could not start passkey sign-in");

    const response = await performPasskeyAuthentication(options);

    const completeRes = await fetch("/api/login/passkey/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ username, response, remember }),
    });
    const completeBody = await completeRes.json();
    if (!completeRes.ok) throw new Error(completeBody.error || "could not verify the passkey");
    window.location.href = "/";
  } catch (err) {
    showFailure(err.name === "NotAllowedError" ? "Passkey sign-in was cancelled." : err.message);
  }
});
