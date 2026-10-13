// Computed-style fingerprint of every Stage View element.
//
// Screenshots are taken with animations disabled, so on their own they
// cannot prove that the blink (last 30 s / overtime), the cue pulse or the
// colour/width transitions still exist. This JSON pins exactly those
// properties (plus text, fonts and geometry) and is compared as a text
// snapshot alongside the pixels.
const IDS = [
  'sv', 'sv-hdr', 'st-brand-sv', 'sv-hdr-clock', 'sv-close-btn', 'sv-exit', 'sv-top', 'sv-artist', 'sv-genre',
  'sv-cd', 'sv-idle', 'sv-bw', 'sv-bar', 'sv-next', 'sv-next-name', 'sv-clock', 'cue-overlay', 'blackout-overlay',
];
const PROPS = [
  'display', 'visibility', 'opacity', 'position', 'color', 'background-color', 'background-image',
  'font-family', 'font-size', 'font-weight', 'font-variant-numeric', 'letter-spacing', 'line-height', 'text-transform',
  'text-align', 'border-radius', 'box-shadow', 'cursor', 'z-index',
  'animation-name', 'animation-duration', 'animation-timing-function', 'animation-iteration-count',
  'transition-property', 'transition-duration', 'transition-timing-function',
];

async function fingerprint(page) {
  return page.evaluate(({ IDS, PROPS }) => {
    // Computed styles of a running animation/transition are time-dependent
    // (real time, not page.clock). Freeze them the way the screenshot does:
    // finite transitions jump to their end, infinite animations sit at their
    // first keyframe; the infinite ones are resumed afterwards.
    const resumed = [];
    for (const a of document.getAnimations()) {
      const it = a.effect && a.effect.getTiming ? a.effect.getTiming().iterations : 1;
      if (it === Infinity) { a.pause(); a.currentTime = 0; resumed.push(a); } else { try { a.finish(); } catch (_) {} }
    }
    const out = {};
    for (const id of IDS) {
      const el = document.getElementById(id);
      if (!el) { out[id] = null; continue; }
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const styles = {};
      for (const p of PROPS) styles[p] = cs.getPropertyValue(p);
      out[id] = {
        text: el.children.length && id !== 'sv-cd' ? undefined : el.textContent,
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        styles,
      };
    }
    out.__runningAnimations = resumed
      .map((a) => `${a.effect && a.effect.target && a.effect.target.id}:${a.animationName || a.transitionProperty || ''}`)
      .sort();
    for (const a of resumed) a.play();
    return out;
  }, { IDS, PROPS });
}

module.exports = { fingerprint, IDS, PROPS };
