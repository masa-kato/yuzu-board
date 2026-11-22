// A small line chart of one exercise variant's progress (workout.js): each
// day's best set, by date. Drawn as SVG at the width it's given (and again
// when that changes). A hairline snaps to the day nearest the pointer (or the
// arrow keys) and a tooltip gives its value and date; the history below the
// charts lists every value, so nothing is only in the tooltip.

import { h, svg } from './ui.js';

const HEIGHT = 168;
const PAD = { top: 22, right: 18, bottom: 26, left: 44 };
const DAY_MS = 86400000;

const toMs = (iso) => new Date(`${iso}T00:00:00`).getTime();

// Round tick values covering [lo, hi]: 1, 2 or 5 times a power of ten apart.
function niceTicks(lo, hi, count = 4) {
  if (lo === hi) {
    const pad = Math.abs(lo) * 0.1 || 1;
    lo -= pad;
    hi += pad;
  }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
  if (ticks[ticks.length - 1] < hi) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

function dateLabel(iso, withYear) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined,
    withYear ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' });
}

// points: [{date, value, …}] oldest first. format(value) -> "155 lb";
// detail(point) -> extra tooltip text or ''. Returns { el, destroy }.
export function progressChart({ points, format, detail = () => '', label }) {
  const el = h('div', { class: 'chart' });
  const tip = h('div', { class: 'chart-tip', role: 'status', hidden: true });
  let width = 0;
  let focused = -1;
  let parts = null;

  function draw() {
    const w = width;
    const innerW = w - PAD.left - PAD.right;
    const innerH = HEIGHT - PAD.top - PAD.bottom;
    const values = points.map((p) => p.value);
    const ticks = niceTicks(Math.min(...values), Math.max(...values));
    const yLo = ticks[0];
    const yHi = ticks[ticks.length - 1];
    const t0 = toMs(points[0].date);
    const t1 = toMs(points[points.length - 1].date);
    const span = t1 - t0;
    const x = (p) => (span ? PAD.left + ((toMs(p.date) - t0) / span) * innerW : PAD.left + innerW / 2);
    const y = (v) => PAD.top + (1 - (v - yLo) / (yHi - yLo)) * innerH;
    const xs = points.map(x);
    const ys = points.map((p) => y(p.value));

    const grid = ticks.map((t) => svg('g', {},
      svg('line', { class: 'chart-grid', x1: PAD.left, x2: w - PAD.right, y1: y(t), y2: y(t) }),
      svg('text', { class: 'chart-tick', x: PAD.left - 8, y: y(t), 'text-anchor': 'end', 'dominant-baseline': 'middle' },
        Number.isInteger(t) ? t : t.toFixed(1))));
    // First and last day under the axis (and the middle one, given room).
    const withYear = span > 300 * DAY_MS;
    const xLabels = [0, points.length - 1];
    if (points.length > 2 && innerW > 280) xLabels.splice(1, 0, Math.floor((points.length - 1) / 2));
    const xTicks = [...new Set(xLabels)].map((i, n, all) => svg('text', {
      class: 'chart-tick', x: xs[i], y: HEIGHT - 6,
      'text-anchor': all.length === 1 ? 'middle' : n === 0 ? 'start' : n === all.length - 1 ? 'end' : 'middle',
    }, dateLabel(points[i].date, withYear)));

    const line = xs.map((px, i) => `${i ? 'L' : 'M'}${px.toFixed(1)} ${ys[i].toFixed(1)}`).join('');
    const base = PAD.top + innerH;
    const area = points.length > 1 ? `${line}L${xs[xs.length - 1].toFixed(1)} ${base}L${xs[0].toFixed(1)} ${base}Z` : null;

    // Direct labels, sparingly: the latest value, and the best if it's higher
    // and far enough along not to run into it.
    const last = points.length - 1;
    const top = values.indexOf(Math.max(...values));
    const labelBest = values[top] > values[last] && Math.abs(xs[top] - xs[last]) > 64;
    const labels = [last, labelBest && top].filter((i) => i !== false).map((i) => svg('text', {
      class: 'chart-value', x: xs[i], y: ys[i] - 10,
      'text-anchor': xs[i] > w - PAD.right - 30 ? 'end' : xs[i] < PAD.left + 30 ? 'start' : 'middle',
    }, format(points[i].value)));

    const cross = svg('line', { class: 'chart-cross', y1: PAD.top, y2: base, visibility: 'hidden' });
    const dots = points.map((_, i) => svg('circle', { class: 'chart-dot', cx: xs[i], cy: ys[i], r: 4 }));
    const hit = svg('rect', { class: 'chart-hit', x: PAD.left - 12, y: 0, width: innerW + 24, height: HEIGHT });

    const root = svg('svg', {
      class: 'chart-svg', width: w, height: HEIGHT, viewBox: `0 0 ${w} ${HEIGHT}`, tabindex: 0,
      role: 'img', 'aria-label': `${label}: ${points.length} days, latest ${format(values[last])}, best ${format(values[top])}. Arrow keys step through the days.`,
    },
    grid, xTicks,
    area && svg('path', { class: 'chart-area', d: area }),
    points.length > 1 && svg('path', { class: 'chart-line', d: line }),
    cross, dots, labels, hit);
    parts = { root, xs, ys, cross, dots, hit };

    const nearest = (clientX) => {
      const left = root.getBoundingClientRect().left;
      let best = 0;
      xs.forEach((px, i) => {
        if (Math.abs(px + left - clientX) < Math.abs(xs[best] + left - clientX)) best = i;
      });
      return best;
    };
    hit.addEventListener('pointermove', (e) => show(nearest(e.clientX)));
    hit.addEventListener('pointerdown', (e) => show(nearest(e.clientX)));
    hit.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') hide();
    });
    root.addEventListener('focus', () => show(focused >= 0 ? focused : last));
    root.addEventListener('blur', hide);
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      show(Math.max(0, Math.min(last, (focused >= 0 ? focused : last) + (e.key === 'ArrowLeft' ? -1 : 1))));
    });
    el.replaceChildren(root, tip);
    if (focused >= 0) show(focused);
  }

  function show(i) {
    focused = i;
    const { xs, ys, cross, dots } = parts;
    cross.setAttribute('x1', xs[i]);
    cross.setAttribute('x2', xs[i]);
    cross.setAttribute('visibility', 'visible');
    dots.forEach((d, n) => d.setAttribute('r', n === i ? 6 : 4));
    const p = points[i];
    const more = detail(p);
    tip.replaceChildren(
      h('strong', {}, format(p.value)),
      h('span', {}, new Date(`${p.date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })),
      more && h('span', {}, more));
    tip.hidden = false;
    // Beside the point, kept inside the chart.
    const tipW = tip.offsetWidth;
    tip.style.left = `${Math.max(0, Math.min(width - tipW, xs[i] - tipW / 2))}px`;
    tip.style.top = `${Math.max(0, ys[i] - tip.offsetHeight - 14)}px`;
  }

  function hide() {
    focused = -1;
    if (!parts) return;
    parts.cross.setAttribute('visibility', 'hidden');
    parts.dots.forEach((d) => d.setAttribute('r', 4));
    tip.hidden = true;
  }

  const observer = new ResizeObserver(([entry]) => {
    const w = Math.round(entry.contentRect.width);
    if (!w || w === width) return;
    width = w;
    draw();
  });
  observer.observe(el);
  return { el, destroy: () => observer.disconnect() };
}
