/*
 * Applies the light/dark choice made inside the app (the top bar's theme
 * control, stored per viewer in localStorage) to the pages around it —
 * sign-in and the password pages — so signing out doesn't flash the
 * other theme. Absent a choice, the stylesheet follows the system. An
 * external file because the CSP allows no inline script.
 */
(() => {
  try {
    const stored = localStorage.getItem("theme");
    if (stored === "light" || stored === "dark") document.documentElement.dataset.theme = stored;
  } catch {
    // Storage blocked (private window, policy): follow the system theme.
  }
})();
