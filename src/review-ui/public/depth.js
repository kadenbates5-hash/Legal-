/*
 * Depth: the pointer-driven 3D layer shared by the sign-in page and the
 * dashboard. Two effects, both opt-in by attribute so markup decides
 * where depth belongs:
 *
 *   [data-tilt]      the element turns toward the pointer while it's over
 *                    it (data-tilt="6" = up to 6 degrees), and a light
 *                    sheen follows the pointer across it.
 *   [data-parallax]  layers inside drift with the pointer's position on
 *                    the page, each by its own depth in CSS.
 *
 * Everything is expressed as CSS custom properties (--rx/--ry/--mx/--my,
 * --px/--py); the stylesheets do the actual transforms. Setting a custom
 * property from script is CSSOM, which the strict CSP (no inline styles)
 * permits — no style attributes are ever written.
 *
 * Off entirely — no listeners doing work, no `depth-on` class, so the CSS
 * applies no transforms — when the person has asked their system to
 * reduce motion, or on a touch screen, where "toward the pointer" means
 * nothing and a card twisting under a finger is just disorienting.
 */
(() => {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
  const root = document.documentElement;

  const enabled = () => !reduceMotion.matches && finePointer.matches;
  const sync = () => {
    root.classList.toggle("depth-on", enabled());
    if (!enabled()) resetAll();
  };

  let activeTilt = null;
  let latest = null;
  let frame = 0;

  function resetTilt(el) {
    if (!el) return;
    el.classList.remove("is-tilting");
    el.style.setProperty("--rx", "0deg");
    el.style.setProperty("--ry", "0deg");
  }

  function resetAll() {
    resetTilt(activeTilt);
    activeTilt = null;
    for (const scene of document.querySelectorAll("[data-parallax]")) {
      scene.style.setProperty("--px", "0");
      scene.style.setProperty("--py", "0");
    }
  }

  function render() {
    frame = 0;
    if (!latest) return;
    const { x, y, target } = latest;

    const tilt = target instanceof Element ? target.closest("[data-tilt]") : null;
    if (tilt !== activeTilt) {
      resetTilt(activeTilt);
      activeTilt = tilt;
    }
    if (tilt) {
      const rect = tilt.getBoundingClientRect();
      const fx = Math.min(1, Math.max(0, (x - rect.left) / rect.width));
      const fy = Math.min(1, Math.max(0, (y - rect.top) / rect.height));
      const max = Number(tilt.dataset.tilt) || 6;
      tilt.classList.add("is-tilting");
      tilt.style.setProperty("--rx", `${((0.5 - fy) * max * 2).toFixed(2)}deg`);
      tilt.style.setProperty("--ry", `${((fx - 0.5) * max * 2).toFixed(2)}deg`);
      tilt.style.setProperty("--mx", `${(fx * 100).toFixed(1)}%`);
      tilt.style.setProperty("--my", `${(fy * 100).toFixed(1)}%`);
    }

    const px = ((x / window.innerWidth) * 2 - 1).toFixed(3);
    const py = ((y / window.innerHeight) * 2 - 1).toFixed(3);
    for (const scene of document.querySelectorAll("[data-parallax]")) {
      scene.style.setProperty("--px", px);
      scene.style.setProperty("--py", py);
    }
  }

  document.addEventListener(
    "pointermove",
    (event) => {
      if (!enabled() || event.pointerType === "touch") return;
      latest = { x: event.clientX, y: event.clientY, target: event.target };
      if (!frame) frame = requestAnimationFrame(render);
    },
    { passive: true },
  );
  document.addEventListener("pointerleave", resetAll);
  window.addEventListener("blur", resetAll);
  reduceMotion.addEventListener("change", sync);
  finePointer.addEventListener("change", sync);
  sync();
})();
