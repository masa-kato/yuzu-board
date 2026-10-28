// Swiping the wall sideways (touch and pen only) to step between climbs.
// The element follows the finger; a committed swipe slides it out, and the
// next page slides it back in from the other side with consumeSwipe().

const DECIDE = 10;       // px of movement before we know which way the finger is going
const COMMIT = 60;       // px that always commits
const FLICK = 30;        // px that commits when fast enough
const FLICK_SPEED = 0.4; // px per ms
const OUT = 35;          // % of the width the element slides out / in
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

let pending = 0;         // direction of a swipe still waiting for the next page

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function place(el, x, opacity, ms = 0) {
  el.style.transition = ms ? `transform ${ms}ms ${EASE}, opacity ${ms}ms ${EASE}` : 'none';
  el.style.transform = x ? `translateX(${x})` : '';
  el.style.opacity = opacity === 1 ? '' : String(opacity);
}

// `canStep(dir)` says whether there is a climb that way; `onStep(dir)` goes
// there. dir is +1 for next (swipe left) and -1 for previous (swipe right).
// `canSwipe()` turns it off for now (e.g. while the board is zoomed in, when a
// drag pans instead). A second finger means a pinch, so the swipe gives way.
// Returns a function that turns swiping off again.
export function enableSwipe(el, { canStep, onStep, canSwipe = () => true }) {
  let start = null;      // { id, x, y, t } of the touch being tracked
  let horizontal = null; // null until decided
  let swallowClick = false;
  const fingers = new Set();
  const touchAction = el.style.touchAction;
  el.style.touchAction = 'pan-y';   // pinches go to the board's own zoom

  function abort() {
    if (start && horizontal && !reducedMotion()) place(el, 0, 1, 220);
    start = null;
  }

  function down(e) {
    if (e.pointerType === 'mouse') return;
    fingers.add(e.pointerId);
    if (fingers.size > 1) {
      abort();
      return;
    }
    if (!e.isPrimary || pending || !canSwipe()) return;
    start = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp };
    horizontal = null;
  }

  function move(e) {
    if (!start || e.pointerId !== start.id) return;
    if (!canSwipe()) {
      abort();
      return;
    }
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (horizontal === null) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < DECIDE) return;
      horizontal = Math.abs(dx) > Math.abs(dy);
      if (!horizontal) {
        start = null;   // a vertical drag: leave it to page scrolling
        return;
      }
    }
    if (!reducedMotion()) {
      const free = canStep(dx < 0 ? 1 : -1);
      place(el, `${dx * (free ? 0.6 : 0.25)}px`, free ? 1 - Math.min(Math.abs(dx) / 600, 0.35) : 1);
    }
  }

  function up(e) {
    fingers.delete(e.pointerId);
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    const dt = Math.max(e.timeStamp - start.t, 1);
    const wasHorizontal = horizontal;
    start = null;
    if (!wasHorizontal) return;
    swallowClick = true;
    setTimeout(() => (swallowClick = false), 0);
    const dir = dx < 0 ? 1 : -1;
    const far = Math.abs(dx) >= COMMIT || (Math.abs(dx) >= FLICK && Math.abs(dx) / dt >= FLICK_SPEED);
    if (!far || !canStep(dir)) {
      if (!reducedMotion()) place(el, 0, 1, 220);
      return;
    }
    pending = dir;
    if (reducedMotion()) {
      onStep(dir);
      return;
    }
    place(el, `${-dir * OUT}%`, 0, 160);
    setTimeout(() => onStep(dir), 150);
  }

  function cancel(e) {
    fingers.delete(e.pointerId);
    if (!start || e.pointerId !== start.id) return;
    abort();
  }

  // A swipe that ends over a hold must not also count as a tap on it.
  function click(e) {
    if (!swallowClick) return;
    e.stopPropagation();
    e.preventDefault();
  }

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('click', click, true);
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', cancel);
    el.removeEventListener('click', click, true);
    el.style.touchAction = touchAction;
  };
}

// On the page a swipe led to: slide in from the side opposite the swipe.
export function consumeSwipe(el) {
  const dir = pending;
  pending = 0;
  if (!dir || reducedMotion()) {
    place(el, 0, 1);
    return;
  }
  place(el, `${dir * OUT}%`, 0);
  el.getBoundingClientRect();   // commit the start position before animating
  place(el, 0, 1, 220);
}

// Clears any leftover offset (a swipe that ended on an error or another view).
export function settleSwipe(el) {
  if (!pending) return;
  pending = 0;
  place(el, 0, 1);
}
