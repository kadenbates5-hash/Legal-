/**
 * The signer's page — no Docket session, no account of any kind. The
 * token in the URL is the entire authentication story (see
 * `esignature-service.ts`'s doc comment), so every call below is a bare
 * fetch with no cookie/credential handling at all.
 */
const token = new URLSearchParams(window.location.search).get("token");

const tagline = document.getElementById("tagline");
const loadError = document.getElementById("loadError");
const signArea = document.getElementById("signArea");
const doneArea = document.getElementById("doneArea");
const doneMessage = document.getElementById("doneMessage");
const docTitle = document.getElementById("docTitle");
const pdfFrame = document.getElementById("pdfFrame");
const signForm = document.getElementById("signForm");
const formError = document.getElementById("formError");
const declineBtn = document.getElementById("declineBtn");

function showDone(message) {
  signArea.hidden = true;
  tagline.hidden = true;
  doneArea.hidden = false;
  doneMessage.textContent = message;
}

async function load() {
  if (!token) {
    tagline.hidden = true;
    loadError.textContent = "This link is missing its signing token — check the link you were sent.";
    return;
  }
  try {
    const res = await fetch(`/api/sign/${encodeURIComponent(token)}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "This signing link isn't valid.");

    if (body.signerStatus === "signed") {
      showDone("You've already signed this document. No further action is needed.");
      return;
    }
    if (body.signerStatus === "declined" || body.envelopeStatus === "declined") {
      showDone("You declined to sign this document.");
      return;
    }
    if (body.envelopeStatus === "voided") {
      showDone("This signature request was withdrawn. Contact the firm if you have questions.");
      return;
    }

    tagline.textContent = `${body.signerName}, please review the document below and sign when you're ready.`;
    docTitle.textContent = body.title;
    pdfFrame.src = `/api/sign/${encodeURIComponent(token)}/document`;
    signArea.hidden = false;
  } catch (err) {
    tagline.hidden = true;
    loadError.textContent = err.message;
  }
}

signForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.textContent = "";
  const signatureText = document.getElementById("signatureText").value;
  try {
    const res = await fetch(`/api/sign/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signatureText }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "couldn't record your signature");
    showDone("Signed. Thank you — you can close this page now.");
  } catch (err) {
    formError.textContent = err.message;
  }
});

declineBtn.addEventListener("click", async () => {
  const reason = prompt("Optional: let the firm know why you're declining to sign.") || "";
  try {
    const res = await fetch(`/api/sign/${encodeURIComponent(token)}/decline`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "couldn't record your decision");
    showDone("You've declined to sign. The firm has been notified.");
  } catch (err) {
    formError.textContent = err.message;
  }
});

load();
