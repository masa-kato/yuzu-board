import { h, trackListScroll } from '../ui.js';
import { stat } from './logbook.js';

// Light yellow for a hold on one climb to dark red for the most used hold
// (ColorBrewer YlOrRd), stopping short of its near-black reds, which would
// sink into the dark wall.
const HEAT_STOPS = ['#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#b10026'];
// Holds on no active climb: a neutral gray, darker than the ramp's light end
// so the holds in use stand out from the many that aren't.
const UNUSED = '#626966';
const POP_MS = 3000;   // how long a tapped hold's count stays up
const POP_GAP = 8;     // px between the count and its hold, or the screen's edge

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function mix(a, b, t) {
  const from = channels(a);
  const to = channels(b);
  return `#${from.map((c, i) => Math.round(c + (to[i] - c) * t).toString(16).padStart(2, '0')).join('')}`;
}

// The color of a hold on `n` climbs, when the most used hold is on `max`.
function heatColor(n, max) {
  if (!n) return UNUSED;
  const at = (max > 1 ? (n - 1) / (max - 1) : 0) * (HEAT_STOPS.length - 1);
  const i = Math.min(HEAT_STOPS.length - 2, Math.floor(at));
  return mix(HEAT_STOPS[i], HEAT_STOPS[i + 1], at - i);
}

const swatch = (color) => h('span', { class: 'usage-swatch', style: `background:${color}` });

export async function render(root, ctx) {
  const { state, board } = ctx;
  const routes = await ctx.api.routes();
  if (ctx.stale()) return;

  // Every active climb (variations too, legacy ones never) counts once for
  // each hold on it, whatever the hold's role.
  const climbs = routes.flatMap((r) => [r, ...r.variations]).filter((c) => c.possible);
  const uses = new Map();
  for (const climb of climbs) {
    for (const { hold_id: id } of climb.holds) uses.set(id, (uses.get(id) || 0) + 1);
  }
  const count = (hold) => uses.get(hold.id) || 0;
  const wall = state.holds.filter((hold) => !hold.removed);
  const max = Math.max(0, ...wall.map(count));
  const colors = new Map(wall.map((hold) => [hold.id, heatColor(count(hold), max)]));
  const used = wall.filter(count).sort((a, b) => count(b) - count(a) || byName(a, b));
  const unused = wall.filter((hold) => !count(hold)).sort(byName);
  board.setHeat(colors);

  // A hold's count, over the hold on the wall (below it when there's no room
  // above inside the wall's frame, so it never covers the tabs). Nothing shows
  // for a hold zoomed out of view.
  const pop = h('div', { class: 'hold-pop', 'aria-hidden': 'true' });
  document.body.append(pop);
  let popTimer = 0;

  function hidePop() {
    clearTimeout(popTimer);
    pop.classList.remove('show');
  }

  function showPop(hold, { linger = false } = {}) {
    hidePop();
    const art = hold && colors.has(hold.id) && ctx.boardEl.querySelector(`.hold[data-id="${hold.id}"] :is(.hold-art, .body)`);
    if (!art) return;
    const box = art.getBoundingClientRect();
    const frame = ctx.boardEl.getBoundingClientRect();
    if (box.right < frame.left || box.left > frame.right || box.bottom < frame.top || box.top > frame.bottom) return;
    const n = count(hold);
    pop.replaceChildren(swatch(colors.get(hold.id)), h('span', { class: 'hold-pop-name' }, hold.name),
      h('span', { class: 'hold-pop-count' }, n ? `Used in ${plural(n, 'climb')}` : 'Unused'));
    pop.classList.add('show');
    const left = Math.min(window.innerWidth - pop.offsetWidth - POP_GAP, Math.max(POP_GAP, box.left + box.width / 2 - pop.offsetWidth / 2));
    const above = box.top - POP_GAP - pop.offsetHeight;
    pop.style.left = `${left}px`;
    pop.style.top = `${above >= Math.max(POP_GAP, frame.top) ? above : box.bottom + POP_GAP}px`;
    if (linger) popTimer = setTimeout(hidePop, POP_MS);
  }

  // The count would stay put while the page scrolls or the wall pans under it.
  window.addEventListener('scroll', hidePop, { passive: true });
  ctx.boardEl.addEventListener('wheel', hidePop, { passive: true });

  const list = h('ul', { class: 'usage-list' });
  const scroller = h('div', { class: 'list-scroll' }, list);
  const scrolling = trackListScroll(root, scroller, state.listScroll, 'stats');
  const unusedToggle = h('input', {
    type: 'checkbox', checked: state.statsUnusedOnly,
    onChange: () => {
      state.statsUnusedOnly = unusedToggle.checked;
      renderList();
      scrolling.reset();
    },
  });

  function row(hold) {
    const n = count(hold);
    return h('li', {
      class: 'usage-row',
      onMouseenter: () => {
        board.setPicked(hold.id);
        showPop(hold);
      },
      onMouseleave: () => {
        board.setPicked(null);
        hidePop();
      },
    },
    swatch(colors.get(hold.id)),
    h('span', { class: 'usage-name' }, hold.name),
    n > 0 && h('span', { class: 'usage-count' }, plural(n, 'climb')));
  }

  // Ranked by use, or the unused holds by name when they're the ones lit.
  function renderList() {
    const onlyUnused = state.statsUnusedOnly;
    board.setLit(onlyUnused ? unused.map((hold) => hold.id) : null);
    const holds = onlyUnused ? unused : used;
    if (!holds.length) {
      list.replaceChildren(h('li', { class: 'empty' }, onlyUnused
        ? 'Every hold is on at least one active climb.'
        : 'No active climbs yet — set one to see hold stats.'));
      return;
    }
    list.replaceChildren(h('li', { class: 'usage-head' }, onlyUnused ? 'Unused holds' : 'Most used'), ...holds.map(row));
  }

  const legend = h('div', { class: 'heat-legend' },
    max > 1 && h('span', { class: 'heat-key' }, '1',
      h('span', { class: 'heat-bar', style: `background:linear-gradient(to right, ${HEAT_STOPS.join(', ')})` }), `${max} climbs`),
    max === 1 && h('span', { class: 'heat-key' }, swatch(HEAT_STOPS[0]), '1 climb'),
    h('span', { class: 'heat-key' }, swatch(UNUSED), 'Unused'));

  // Title, stats, key and toggle stay put; only the holds scroll.
  const controls = h('div', { class: 'list-controls' },
    h('div', { class: 'panel-head' }, h('h1', {}, 'Hold stats')),
    h('div', { class: 'stats' },
      stat(climbs.length, climbs.length === 1 ? 'active climb' : 'active climbs'),
      stat(used.length, `of ${wall.length} holds used`),
      stat(unused.length, 'unused holds')),
    h('div', { class: 'log-controls' },
      h('label', { class: 'toggle' }, unusedToggle, h('span', {}, 'Only unused holds')),
      legend));
  root.classList.add('view-list');
  root.replaceChildren(controls, scroller);
  renderList();
  scrolling.restore();

  return {
    onHoldHover: (hold) => (hold ? showPop(hold) : hidePop()),
    // No hover on a touch screen: a tap shows the count for a moment.
    onHoldClick: (hold) => showPop(hold, { linger: true }),
    destroy() {
      hidePop();
      pop.remove();
      window.removeEventListener('scroll', hidePop);
      ctx.boardEl.removeEventListener('wheel', hidePop);
      scrolling.stop();
    },
  };
}
