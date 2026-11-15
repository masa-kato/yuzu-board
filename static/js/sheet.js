// The climb lists' sheet on phones (app.css body.list-mode). Lowered, it sits
// under the board; raised (body.sheet-up), it covers the board to show more
// of the list. Lowered, a drag up anywhere on it raises it (on touch screens
// the list doesn't scroll in this state); raised, the list scrolls as usual,
// and a drag down on the sheet's top part, or on the list once it's at its
// top, lowers it. The sheet follows the finger and settles either way when
// let go. Touch only: with a mouse the list just scrolls.

const DECIDE = 10;       // px of movement before we know which way the finger is going
const COMMIT = 60;       // px that always commits
const FLICK = 20;        // px that commits when fast enough
const FLICK_SPEED = 0.4; // px per ms
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const PHONE = window.matchMedia('(max-width: 900px)');

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// `panel` is the sheet and `scroller` the list inside it. Returns
// { raise, lower, isUp, stop }; stop() lowers it at once and lets go of the
// panel (which outlives the page).
export function enableSheet(panel, scroller) {
  const body = document.body;
  let start = null;      // { y, x, up, fromList, atTop } of the touch being tracked
  let mode = null;       // null until decided, then 'drag' (moves the sheet) or 'native'
  let offset = 0;        // px the sheet is dragged from where it rests
  let samples = [];      // recent [y, time], for the speed on letting go
  let anim = null;
  let swallowClick = false;

  const isUp = () => body.classList.contains('sheet-up');

  function setOffset(px) {
    offset = px;
    panel.style.transform = px ? `translateY(${px}px)` : '';
  }

  // Rests the sheet raised or lowered, sliding there from where it's drawn now.
  function settle(up) {
    anim?.cancel();
    const before = panel.getBoundingClientRect().top;   // with any drag offset
    setOffset(0);
    panel.style.willChange = '';
    body.classList.toggle('sheet-up', up);
    // Lowered, the search would sit under the keyboard: let the keyboard go.
    if (!up && panel.contains(document.activeElement)) document.activeElement.blur();
    const after = panel.getBoundingClientRect().top;
    if (Math.abs(before - after) > 1 && !reducedMotion()) {
      anim = panel.animate([{ transform: `translateY(${before - after}px)` }, { transform: 'none' }], { duration: 260, easing: EASE });
    }
  }

  function onStart(e) {
    if (!PHONE.matches || e.touches.length !== 1) {
      start = null;
      return;
    }
    const t = e.touches[0];
    start = { y: t.clientY, x: t.clientX, up: isUp(), fromList: scroller.contains(e.target), atTop: scroller.scrollTop <= 0 };
    samples = [[t.clientY, e.timeStamp]];
    mode = null;
  }

  function onMove(e) {
    if (!start) return;
    const t = e.touches[0];
    if (e.touches.length !== 1) {
      if (mode === 'drag') settle(start.up);
      start = null;
      return;
    }
    if (mode === null) {
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (Math.abs(dx) < DECIDE && Math.abs(dy) < DECIDE) return;
      // Sideways is the chip row's own scroll. Raised, the list scrolls as
      // usual unless it's pulled down from its top.
      const vertical = Math.abs(dy) > Math.abs(dx);
      mode = vertical && (!start.up || !start.fromList || (start.atTop && dy > 0)) ? 'drag' : 'native';
      if (mode !== 'drag') return;
      anim?.cancel();
      panel.style.willChange = 'transform';
      start.y = t.clientY;   // follow from here, so the sheet doesn't jump
    }
    if (mode !== 'drag') return;
    e.preventDefault();
    const d = t.clientY - start.y;
    // Toward the other state it follows the finger; the other way it only gives a little.
    setOffset(start.up ? (d > 0 ? d : d / 4) : (d < 0 ? d : d / 4));
    samples.push([t.clientY, e.timeStamp]);
    while (samples.length > 2 && e.timeStamp - samples[0][1] > 100) samples.shift();
  }

  function onEnd() {
    if (!start) return;
    const { up } = start;
    const dragged = mode === 'drag';
    start = null;
    mode = null;
    if (!dragged) return;
    swallowClick = true;
    setTimeout(() => (swallowClick = false), 0);
    const [[y0, t0], [y1, t1]] = [samples[0], samples[samples.length - 1]];
    const speed = t1 > t0 ? (y1 - y0) / (t1 - t0) : 0;
    const toward = up ? offset : -offset;       // px toward the other state
    const towardSpeed = up ? speed : -speed;
    settle(toward > COMMIT || (toward > FLICK && towardSpeed > FLICK_SPEED) ? !up : up);
  }

  // A drag that ends over a row isn't a tap on it.
  function onClick(e) {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  }

  panel.addEventListener('touchstart', onStart, { passive: true });
  panel.addEventListener('touchmove', onMove, { passive: false });
  panel.addEventListener('touchend', onEnd);
  panel.addEventListener('touchcancel', onEnd);
  panel.addEventListener('click', onClick, true);

  return {
    isUp,
    raise() {
      if (!isUp()) settle(true);
    },
    lower() {
      if (isUp()) settle(false);
    },
    stop() {
      anim?.cancel();
      setOffset(0);
      panel.style.willChange = '';
      body.classList.remove('sheet-up');
      panel.removeEventListener('touchstart', onStart);
      panel.removeEventListener('touchmove', onMove);
      panel.removeEventListener('touchend', onEnd);
      panel.removeEventListener('touchcancel', onEnd);
      panel.removeEventListener('click', onClick, true);
    },
  };
}
