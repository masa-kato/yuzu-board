// The board's zoom and pan (board.js), in every view: the − 1× + buttons, the
// + − 0 keys, Ctrl + scroll, pinches, dragging and gliding, and the pointer's
// place on the wall in "place" mode. The SVG always holds the whole wall,
// drawn at `drawnK` times the size of its frame (the container, which clips
// it), and a CSS transform moves it to show `view`. Moving the drawn wall is
// the GPU's job, so panning never redraws it. While a zoom is under way the
// drawn wall is stretched (a little soft when enlarged), and settle() draws it
// again once the zoom stops. toWall() measures from the frame, so placement
// stays exact.

import { TOUCH, h, icon } from './ui.js';

// The closest view: 6× (about 7 columns) with a mouse, 4× (about 12) on touch
// screens.
export const maxZoom = () => (TOUCH.matches ? 4 : 6);
const ZOOM_STEP = 1.6;  // per zoom button / key press
const SETTLE_DELAY = 150;  // ms after the last wheel zoom before the wall is drawn again
// A quick pan glides on: its speed over the last GLIDE_WINDOW ms (if the finger
// didn't pause for GLIDE_PAUSE before lifting) falls by 1/e every GLIDE_TAU ms,
// as iOS scrolling does, until it's below GLIDE_STOP. Speeds in px per ms.
const GLIDE_WINDOW = 100;
const GLIDE_PAUSE = 50;
const GLIDE_TAU = 325;
const GLIDE_MIN = 0.3;
const GLIDE_STOP = 0.02;
const TOUCH_DELAY = 90;   // ms a touch waits before it counts as a press, in "place" mode
const PAN_SLOP = 6;       // px a press may wander before it becomes a pan
const TOUCH_PAN_SLOP = 10;   // and a finger, which wanders more in a tap

// `container` is the board's frame, and `root` the SVG the pointers land on.
// `layers` move together (the SVG, and on touch screens the wall and the
// holds' picture under it). `base` is the whole wall, as the SVG's viewBox.
// `placing()` says whether a drag moves what's being placed rather than
// panning; the pointer is then reported to `onWallPointer`. `onScale` runs
// whenever the wall is drawn at a new size on screen.
export function createViewport({ container, root, layers, base, placing, onWallPointer, onScale }) {
  let view = { ...base };
  let goal = view;    // where the view is heading (differs from `view` mid-animation)
  let viewAnim = 0;   // a zoom animation or glide under way
  let gliding = false;
  let drawnK = 1;     // the zoom the wall is drawn at
  let placed = '';    // the transform last written
  let settleTimer = 0;
  const frame = { w: container.getBoundingClientRect().width };   // CSS pixels
  const zoomLevel = () => base.w / view.w;
  const zoomed = () => zoomLevel() > 1.001;
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const zoomOut = h('button', { type: 'button', class: 'icon-btn', title: 'Zoom out (−)', 'aria-label': 'Zoom out', onClick: () => zoomBy(1 / ZOOM_STEP) }, icon('minus', { size: 16 }));
  const zoomIn = h('button', { type: 'button', class: 'icon-btn', title: 'Zoom in (+)', 'aria-label': 'Zoom in', onClick: () => zoomBy(ZOOM_STEP) }, icon('plus', { size: 16 }));
  const zoomReset = h('button', { type: 'button', class: 'zoom-level', title: 'Show the whole wall (0)', 'aria-label': 'Show the whole wall', onClick: () => resetZoom(true) });
  const zoomControls = h('div', { class: 'zoom-controls', role: 'group', 'aria-label': 'Zoom' }, zoomOut, zoomReset, zoomIn);

  function clampView(v) {
    const w = Math.min(base.w, Math.max(base.w / maxZoom(), v.w));
    const ht = (w * base.h) / base.w;
    return {
      x: Math.min(base.x + base.w - w, Math.max(base.x, v.x)),
      y: Math.min(base.y + base.h - ht, Math.max(base.y, v.y)),
      w,
      h: ht,
    };
  }

  // Moves the drawn wall to show `view`: a transform, so nothing is redrawn.
  function place() {
    const k = zoomLevel();
    const px = (k * frame.w) / base.w;   // screen pixels per wall inch
    const transform = `translate(${-(view.x - base.x) * px}px, ${-(view.y - base.y) * px}px) scale(${k / drawnK})`;
    if (transform === placed) return;
    placed = transform;
    for (const layer of layers) layer.style.transform = transform;
  }

  // Draws the wall again at zoom `k`. The frame's `zoomed` class changes only
  // here too: it changes the wall's touch-action (and, with a mouse, its
  // cursor), and Safari redraws the whole wall for that, so it goes with this
  // redraw rather than adding one mid-gesture.
  function drawAt(k) {
    drawnK = k;
    for (const layer of layers) {
      layer.style.width = layer.style.height = `${k * 100}%`;
      layer.style.setProperty('--zoom', k);   // keeps grid lines hairline (app.css)
    }
    container.classList.toggle('zoomed', k > 1.001);
    onScale();
    place();
  }

  // Draws the wall again at the zoom it has come to. A pinch settles when its
  // fingers lift.
  function settle() {
    clearTimeout(settleTimer);
    const k = zoomLevel();
    if (pinch || k === drawnK) return;
    drawAt(k);
  }

  // For zooms that come in many small steps (a wheel or trackpad pinch).
  function settleSoon() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, SETTLE_DELAY);
  }

  // Stops a zoom animation or glide where it is.
  function stopMoving() {
    cancelAnimationFrame(viewAnim);
    gliding = false;
    goal = view;
  }

  // `final` is false only for the in-between frames of an animation.
  function applyView(v, final = true) {
    view = clampView(v);
    if (final) goal = view;
    place();
    const k = zoomLevel();
    const level = `${Math.round(k * 10) / 10}×`;
    if (zoomReset.textContent !== level) zoomReset.textContent = level;
    zoomOut.disabled = !zoomed();
    zoomIn.disabled = k >= maxZoom() - 0.001;
    zoomControls.classList.toggle('zoomed', zoomed());
  }

  applyView(base);

  function animateTo(v, animate) {
    stopMoving();
    const target = clampView(v);
    if (!animate || reducedMotion()) {
      applyView(target);
      settle();
      return;
    }
    goal = target;
    // Zooming out, the wall is drawn at the new zoom first: shrinking the one
    // drawn closer up would show all of it, which the browser would then paint
    // at that size.
    if (base.w / target.w < drawnK) drawAt(base.w / target.w);
    const from = { ...view };
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 180);
      const e = 1 - (1 - t) ** 3;
      applyView({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, w: from.w + (target.w - from.w) * e, h: 0 }, t >= 1);
      if (t < 1) viewAnim = requestAnimationFrame(step);
      else settle();
    };
    viewAnim = requestAnimationFrame(step);
  }

  // The view at zoom `k` that keeps wall point (fx, fy) where it is on screen.
  function zoomAt(k, fx, fy) {
    const w = base.w / Math.min(maxZoom(), Math.max(1, k));
    const ht = (w * base.h) / base.w;
    return { x: fx - ((fx - view.x) / view.w) * w, y: fy - ((fy - view.y) / view.h) * ht, w, h: ht };
  }

  // Buttons and keys: zoom around the centre of what is shown (or about to be,
  // when a zoom is still animating), so quick repeated presses add up.
  function zoomBy(factor) {
    const w = base.w / Math.min(maxZoom(), Math.max(1, (base.w / goal.w) * factor));
    const ht = (w * base.h) / base.w;
    const cx = goal.x + goal.w / 2;
    const cy = goal.y + goal.h / 2;
    animateTo({ x: cx - w / 2, y: cy - ht / 2, w, h: ht }, true);
  }

  function resetZoom(animate = false) {
    animateTo(base, animate);
  }

  // After a move, bring the hold back into view if it has drifted out.
  function reveal(x, y) {
    if (!zoomed() || dragging || pinch) return;
    const mx = view.w * 0.12;
    const my = view.h * 0.12;
    if (x > view.x + mx && x < view.x + view.w - mx && y > view.y + my && y < view.y + view.h - my) return;
    animateTo({ ...view, x: x - view.w / 2, y: y - view.h / 2 }, true);
  }

  // Wall inches under a screen point, measured from the frame (the drawn wall
  // is larger, and moved by a transform).
  const toWall = (e) => {
    const r = container.getBoundingClientRect();
    const perPx = view.w / r.width;
    return { x: view.x + (e.clientX - r.left) * perPx, y: view.y + (e.clientY - r.top) * perPx };
  };

  // Ctrl/⌘ + wheel (also a trackpad pinch) zooms at the pointer, in every view;
  // a plain wheel pans once zoomed in (and scrolls the page as usual when not).
  root.addEventListener('wheel', (e) => {
    const lines = e.deltaMode === 1 ? 16 : 1;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      stopMoving();
      const p = toWall(e);
      applyView(zoomAt(zoomLevel() * Math.exp(-e.deltaY * lines * 0.01), p.x, p.y));
      settleSoon();
    } else if (zoomed()) {
      e.preventDefault();
      stopMoving();
      const perPx = view.w / frame.w;
      applyView({ ...view, x: view.x + e.deltaX * lines * perPx, y: view.y + e.deltaY * lines * perPx });
      settleSoon();   // in case it cut a zoom short
    }
  }, { passive: false });

  // + / − zoom around the middle of the view and 0 shows the whole wall, unless
  // typing in a field or a dialog is open.
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    const act = { '+': () => zoomBy(ZOOM_STEP), '=': () => zoomBy(ZOOM_STEP), '-': () => zoomBy(1 / ZOOM_STEP), _: () => zoomBy(1 / ZOOM_STEP), 0: () => resetZoom(true) }[e.key];
    if (!act) return;
    e.preventDefault();
    act();
  });

  // Pointers. In every view, two fingers pinch to zoom and pan, and once zoomed
  // in, dragging the wall pans it (a tap still picks a hold; the click ending a
  // pan does not). In "place" mode a drag moves what is being placed instead:
  // pressing or dragging anywhere on the wall reports the pointer position in
  // wall inches, and a touch waits a moment before it counts as a press, so
  // that starting a pinch never moves the hold.
  const touches = new Map();   // pointerId -> { clientX, clientY }
  let dragging = false;
  let pending = null;          // { id, at, timer } a touch not yet reported as a press
  let pinch = null;            // { dist, k, anchor } at the start of a pinch
  let settling = false;        // a finger left over from a pinch: ignore it until lifted
  let last = null;             // latest pointer position while dragging
  let edgeFrame = 0;
  let pan = null;              // { id, at, view, moved, trail } a press that may turn into a pan
  let swallowClick = false;    // the click after a pan or pinch is not a tap on a hold

  const capture = (id) => {
    try {
      root.setPointerCapture(id);
    } catch {
      // the pointer is already gone
    }
  };

  const spread = () => {
    const [a, b] = [...touches.values()];
    return { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, mid: { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 } };
  };

  // Where a screen point is on the wall, and how many wall inches one screen
  // pixel spans there (so hit areas feel the same at any zoom).
  const wallPoint = (at) => ({ ...toWall(at), px: view.w / frame.w });

  // Tells the view where the pointer is on the wall.
  function report(type, at) {
    onWallPointer?.(type, { ...wallPoint(at), touch: !!at.touch });
  }

  function press(at) {
    pending = null;
    dragging = true;
    last = at;
    report('down', at);
  }

  function endDrag(at) {
    if (!dragging) return;
    dragging = false;
    cancelAnimationFrame(edgeFrame);
    edgeFrame = 0;
    report('up', at);
  }

  function endPan() {
    pan = null;
    container.classList.remove('panning');
  }

  // A quick pan keeps going once released, slowing down as a scroll does.
  // `trail` is the pan's last few moves, `upAt` when the finger lifted.
  function glide(trail, upAt) {
    const a = trail[0];
    const b = trail[trail.length - 1];
    if (reducedMotion() || b.t <= a.t || upAt - b.t > GLIDE_PAUSE) return;
    let vx = (b.x - a.x) / (b.t - a.t);   // screen pixels per ms
    let vy = (b.y - a.y) / (b.t - a.t);
    if (Math.hypot(vx, vy) < GLIDE_MIN) return;
    gliding = true;
    let prev = upAt;
    const step = (now) => {
      const decay = Math.exp(-Math.max(0, now - prev) / GLIDE_TAU);
      const travel = GLIDE_TAU * (1 - decay);   // how far one px/ms carries over this frame
      prev = now;
      const perPx = view.w / frame.w;
      const before = view;
      applyView({ ...view, x: view.x - vx * travel * perPx, y: view.y - vy * travel * perPx }, false);
      // Against an edge, that way stops at once.
      if (view.x === before.x) vx = 0;
      if (view.y === before.y) vy = 0;
      vx *= decay;
      vy *= decay;
      if (Math.hypot(vx, vy) > GLIDE_STOP) viewAnim = requestAnimationFrame(step);
      else stopMoving();
    };
    viewAnim = requestAnimationFrame(step);
  }

  // While dragging near the board's edge, zoomed in: pan that way, and keep
  // the hold under the pointer.
  function edgePan() {
    edgeFrame = 0;
    if (!dragging || !zoomed() || !last) return;
    const r = container.getBoundingClientRect();
    const band = 0.08;
    const push = (f) => Math.max(-1, Math.min(1, f < band ? (f - band) / band : f > 1 - band ? (f - 1 + band) / band : 0));
    const dx = push((last.clientX - r.left) / r.width);
    const dy = push((last.clientY - r.top) / r.height);
    if (!dx && !dy) return;
    const before = { x: view.x, y: view.y };
    applyView({ ...view, x: view.x + dx * view.w * 0.012, y: view.y + dy * view.w * 0.012 });
    if (view.x !== before.x || view.y !== before.y) report('move', last);
    edgeFrame = requestAnimationFrame(edgePan);
  }

  // Swallows the click that ends a pan or pinch, before it reaches a hold.
  root.addEventListener('click', (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
  }, true);

  root.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    const at = { clientX: e.clientX, clientY: e.clientY, touch: e.pointerType === 'touch' };
    if (e.pointerType === 'touch') touches.set(e.pointerId, at);
    if (touches.size === 2) {
      // A second finger: a pinch (ending any press, drag or pan under way).
      if (pending) clearTimeout(pending.timer);
      pending = null;
      if (dragging) endDrag(last);
      endPan();
      stopMoving();
      touches.forEach((_, id) => capture(id));
      const { dist, mid } = spread();
      pinch = { dist, k: zoomLevel(), anchor: toWall(mid) };
      swallowClick = true;
      return;
    }
    if (touches.size > 2 || settling) return;
    if (placing()) {
      e.preventDefault();
      capture(e.pointerId);
      if (e.pointerType !== 'touch') press(at);
      else pending = { id: e.pointerId, at, timer: setTimeout(() => pending && press(pending.at), TOUCH_DELAY) };
      return;
    }
    // Any other view: once zoomed in, this press may become a pan. The pointer
    // is only captured when it does, so a plain tap still lands on its hold.
    swallowClick = false;
    if (zoomed()) {
      if (e.pointerType === 'mouse') e.preventDefault();   // no text selection while dragging
      // A touch stops a glide, as on a scrolling page, and isn't a tap on a hold.
      if (gliding) swallowClick = true;
      stopMoving();
      pan = { id: e.pointerId, at, view: { ...view }, moved: false, trail: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }] };
    }
  });

  root.addEventListener('pointermove', (e) => {
    const at = { clientX: e.clientX, clientY: e.clientY };
    if (touches.has(e.pointerId)) touches.set(e.pointerId, at);
    if (pinch) {
      if (touches.size < 2) return;
      // Zoom with the fingers' spread; keep the wall point that started under
      // their midpoint under it, so moving both fingers pans.
      const { dist, mid } = spread();
      const r = container.getBoundingClientRect();
      const w = base.w / Math.min(maxZoom(), Math.max(1, (pinch.k * dist) / pinch.dist));
      const ht = (w * base.h) / base.w;
      applyView({ x: pinch.anchor.x - ((mid.clientX - r.left) / r.width) * w, y: pinch.anchor.y - ((mid.clientY - r.top) / r.height) * ht, w, h: ht });
      return;
    }
    if (pan && pan.id === e.pointerId) {
      if (e.pointerType === 'mouse' && !e.buttons) {
        endPan();   // released somewhere we didn't hear about
        settle();
        return;
      }
      const dx = at.clientX - pan.at.clientX;
      const dy = at.clientY - pan.at.clientY;
      if (!pan.moved) {
        if (Math.hypot(dx, dy) < (e.pointerType === 'touch' ? TOUCH_PAN_SLOP : PAN_SLOP)) return;
        pan.moved = true;
        swallowClick = true;
        capture(e.pointerId);
        container.classList.add('panning');
      }
      const perPx = pan.view.w / frame.w;
      applyView({ ...pan.view, x: pan.view.x - dx * perPx, y: pan.view.y - dy * perPx });
      pan.trail.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
      while (pan.trail.length > 2 && e.timeStamp - pan.trail[0].t > GLIDE_WINDOW) pan.trail.shift();
      return;
    }
    if (pending && pending.id === e.pointerId && Math.hypot(at.clientX - pending.at.clientX, at.clientY - pending.at.clientY) > 6) {
      clearTimeout(pending.timer);
      press(pending.at);
    }
    if (!dragging) return;
    last = at;
    report('move', at);
    if (!edgeFrame) edgeFrame = requestAnimationFrame(edgePan);
  });

  const lift = (e) => {
    const at = { clientX: e.clientX, clientY: e.clientY };
    touches.delete(e.pointerId);
    if (pending && pending.id === e.pointerId) {
      clearTimeout(pending.timer);
      if (e.type === 'pointercancel') pending = null;
      else press(pending.at);   // a quick tap: press and release right here
    }
    if (pinch) {
      if (touches.size < 2) {
        pinch = null;
        settling = touches.size > 0;
        settle();   // draw the wall at its new zoom
      }
      return;
    }
    if (!touches.size) settling = false;
    if (pan && pan.id === e.pointerId) {
      const { moved, trail } = pan;
      endPan();
      settle();   // if the pan cut a zoom short
      if (moved && e.type === 'pointerup') glide(trail, e.timeStamp);
    }
    endDrag(at);
  };
  root.addEventListener('pointerup', lift);
  root.addEventListener('pointercancel', lift);

  // The frame changes size with the page. It has none while a calendar takes
  // the wall's place (app.js PAGES, layout 'calendar'), so it keeps the last one.
  new ResizeObserver(([entry]) => {
    if (!entry.contentRect.width) return;
    frame.w = entry.contentRect.width;
    place();
    onScale();
  }).observe(container);

  return {
    // The − 1× + buttons, for the board to put where it wants them.
    controls: zoomControls,
    zoomed,
    zoomIn: () => zoomBy(ZOOM_STEP),
    zoomOut: () => zoomBy(1 / ZOOM_STEP),
    resetZoom,
    reveal,
    // A click's place on the wall, as wallPoint() gives it.
    pointAt: wallPoint,
    // The frame's width in CSS pixels (0 until it has been laid out).
    frameWidth: () => frame.w,
    // Wall inches per screen pixel, as the wall is drawn (settle()).
    drawnPerPx: () => base.w / (drawnK * frame.w),
  };
}
