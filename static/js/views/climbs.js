import { GRADES, PHONE, append, fmtDate, gradeLabel, gradePips, h, icon, plural, sentMark, trackListScroll } from '../ui.js';
import { enableSheet } from '../sheet.js';
import { consumeSwipe, enableSwipe, settleSwipe } from '../swipe.js';
import { prefetchRoute } from './routeDetail.js';
import { listQuery, listSwitch } from './shared.js';

const HOVER = window.matchMedia('(hover: hover)');

const SCOPES = [
  ['all', 'All fields'],
  ['name', 'Name'],
  ['setter', 'Setter'],
  ['fa', 'First ascent'],
];

// Labels for each sort key and what its two directions mean.
const SORTS = {
  set_date: { label: 'Set date', desc: 'Newest first', asc: 'Oldest first', initial: 'desc' },
  grade: { label: 'Difficulty', desc: 'Hardest first', asc: 'Easiest first', initial: 'asc' },
  fa_date: { label: 'First ascent date', desc: 'Newest first', asc: 'Oldest first', initial: 'desc' },
  ascents: { label: 'Ascents (no repeats)', desc: 'Most first', asc: 'Fewest first', initial: 'desc' },
  sends: { label: 'Ascents (with repeats)', desc: 'Most first', asc: 'Fewest first', initial: 'desc' },
};

// Used by app.js to validate filters restored from localStorage.
export const SCOPE_KEYS = SCOPES.map(([key]) => key);
export const SORT_KEYS = Object.keys(SORTS);

function impossibleTag() {
  return h('span', { class: 'badge impossible-tag' }, 'Not possible');
}

function skeletonCards(n = 3) {
  return Array.from({ length: n }, () => h('div', { class: 'route-card skeleton', 'aria-hidden': 'true' },
    h('div', { class: 'skeleton-line w40' }), h('div', { class: 'skeleton-line w70' }), h('div', { class: 'skeleton-line w55' })));
}

// `legacy` lists retired routes (every climb in the family uses a removed hold).
// Layout: fixed controls on top, and a list below that is the only thing that scrolls.
export async function render(root, ctx, { legacy = false } = {}) {
  const { state, board } = ctx;
  const f = legacy ? state.legacyFilters : state.filters;
  let loadToken = 0;
  let debounce;

  // ---- controls ------------------------------------------------------------
  const count = h('span', { class: 'muted list-count' });
  const segments = listSwitch(ctx, legacy ? 'legacy' : 'climbs');

  const search = h('input', {
    type: 'search', class: 'search-input', value: f.q, 'aria-label': 'Search climbs',
    placeholder: legacy ? 'Search legacy routes' : 'Search, or tap a hold on the board',
    onInput: () => {
      f.q = search.value;
      clearTimeout(debounce);
      debounce = setTimeout(() => load({ reset: true }), 200);
      renderClear();
    },
  });
  const scope = h('select', {
    class: 'search-scope', 'aria-label': 'Search in', value: f.scope,
    onChange: () => {
      f.scope = scope.value;
      load({ reset: true });
    },
  }, SCOPES.map(([value, label]) => h('option', { value }, label)));

  const chips = h('div', { class: 'chip-row', role: 'group', 'aria-label': 'Filters' });
  const clearButton = h('button', { type: 'button', class: 'btn btn-small clear-filters', onClick: clearFilters });

  const sortSelect = h('select', {
    class: 'input sort-select', 'aria-label': 'Sort by', value: f.sort,
    onChange: () => {
      f.sort = sortSelect.value;
      f.dir = SORTS[f.sort].initial;
      renderDir();
      load({ reset: true });
    },
  }, Object.entries(SORTS).map(([value, s]) => h('option', { value }, s.label)));
  const dirButton = h('button', {
    type: 'button', class: 'btn dir-button',
    onClick: () => {
      f.dir = f.dir === 'asc' ? 'desc' : 'asc';
      renderDir();
      load({ reset: true });
    },
  });
  function renderDir() {
    const label = SORTS[f.sort][f.dir];
    dirButton.replaceChildren(icon(f.dir === 'asc' ? 'arrow-up' : 'arrow-down', { size: 15 }), h('span', { class: 'dir-label' }, label));
    dirButton.title = f.sort === 'fa_date' ? `${label}; unsent climbs always last. Click to reverse.` : `${label}. Click to reverse.`;
    dirButton.setAttribute('aria-label', `Order: ${label}`);
  }

  // Filters other than the search text (which is always in view).
  function chipFilterCount() {
    return f.grades.length + (f.hideSent && state.me ? 1 : 0) + (!legacy && f.holdId ? 1 : 0);
  }

  function activeFilterCount() {
    return (f.q.trim() ? 1 : 0) + chipFilterCount();
  }

  function renderClear() {
    const n = activeFilterCount();
    clearButton.hidden = n === 0;
    clearButton.textContent = `Clear all (${n})`;
    const on = chipFilterCount();
    badge.textContent = on ? String(on) : '';
    filtersButton.setAttribute('aria-label', on ? `Filters and sort, ${on} on` : 'Filters and sort');
  }

  function chip(label, on, onClick, extra = {}) {
    return h('button', { type: 'button', class: `chip${on ? ' on' : ''} ${extra.class || ''}`, 'aria-pressed': String(on), onClick, ...extra.attrs }, label);
  }

  function renderChips() {
    const hold = !legacy && f.holdId && state.holdById.get(f.holdId);
    // `append` skips the hold chip when there is none (replaceChildren would print "null").
    chips.replaceChildren();
    append(chips, [
      ...GRADES.map((g) => chip(gradeLabel(g), f.grades.includes(g), () => {
        f.grades = f.grades.includes(g) ? f.grades.filter((x) => x !== g) : [...f.grades, g];
        filtersChanged();
      }, { class: `grade-${g}` })),
      chip('Not sent by me', f.hideSent && !!state.me, () => {
        f.hideSent = !f.hideSent;
        filtersChanged();
      }, { class: 'chip-unsent', attrs: { disabled: !state.me, title: state.me ? 'Hide climbs you have already sent' : 'Choose who you are (top right) to use this' } }),
      hold && h('span', { class: 'chip on hold-chip' }, `Uses ${hold.name}`,
        h('button', { type: 'button', class: 'chip-x', 'aria-label': `Stop filtering by ${hold.name}`, onClick: () => setHold(null) }, icon('x', { size: 12 }))),
      clearButton,
    ]);
    // Phones: the filters that are on, each removable, under the search.
    const removable = (label, remove) => h('span', { class: 'chip on removable' }, label,
      h('button', { type: 'button', class: 'chip-x', 'aria-label': `Remove filter: ${label}`, onClick: remove }, icon('x', { size: 12 })));
    activeRow.replaceChildren();
    append(activeRow, [
      ...f.grades.map((g) => removable(gradeLabel(g), () => {
        f.grades = f.grades.filter((x) => x !== g);
        filtersChanged();
      })),
      f.hideSent && state.me && removable('Not sent by me', () => {
        f.hideSent = false;
        filtersChanged();
      }),
      hold && removable(`Uses ${hold.name}`, () => setHold(null)),
    ]);
    activeRow.hidden = !activeRow.childElementCount;
    renderClear();
  }

  function filtersChanged() {
    renderChips();
    load({ reset: true });
  }

  function clearFilters() {
    Object.assign(f, { q: '', grades: [], hideSent: false, holdId: null });
    search.value = '';
    board.setPicked(null);
    filtersChanged();
  }

  function setHold(holdId) {
    f.holdId = holdId;
    board.setPicked(holdId);
    filtersChanged();
  }

  // Phones show only the search and a Filters button; the rest moves into a
  // sheet (the same nodes, moved while it is open, so their handlers keep working).
  const badge = h('span', { class: 'filters-badge' });
  const filtersButton = h('button', { type: 'button', class: 'btn filters-button', 'aria-haspopup': 'dialog', onClick: openSheet },
    icon('sliders', { size: 16 }), h('span', {}, 'Filters'), badge);
  const activeRow = h('div', { class: 'chip-row active-filters', role: 'group', 'aria-label': 'Filters that are on' });
  const sortRow = h('div', { class: 'sort-row' }, sortSelect, dirButton);

  const controls = h('div', { class: 'list-controls' },
    h('h1', { class: 'visually-hidden' }, legacy ? 'Legacy routes' : 'Climbs'),
    h('div', { class: 'list-head' }, segments, count),
    h('div', { class: 'search-field' }, search, scope),
    filtersButton,
    activeRow,
    chips,
    sortRow);

  // ---- the Filters sheet (phones) -----------------------------------------------
  const showButton = h('button', { type: 'button', class: 'btn btn-primary', onClick: () => sheet.close() }, 'Show climbs');
  const slots = { show: h('div'), search: h('div', { class: 'search-field' }), scope: h('div'), filters: h('div'), sort: h('div') };
  const section = (label, ...slot) => h('section', { class: 'sheet-section' }, h('h3', { class: 'sheet-label' }, label), slot);
  const sheet = h('dialog', { class: 'dialog sheet filter-sheet', 'aria-label': 'Filter and sort' },
    h('div', { class: 'sheet-head' },
      h('h2', {}, 'Filter & sort'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onClick: () => sheet.close() }, icon('x', { size: 18 }))),
    h('div', { class: 'sheet-body' },
      section('Show', slots.show), section('Search', slots.search, slots.scope), section('Filters', slots.filters), section('Sort', slots.sort)),
    h('div', { class: 'sheet-foot' }, showButton));
  const borrowed = [];   // [node, placeholder] while the sheet holds them
  const listPlaceholder = search.placeholder;

  function openSheet() {
    for (const [node, slot] of [[segments, slots.show], [search, slots.search], [scope, slots.scope], [chips, slots.filters], [sortRow, slots.sort]]) {
      const mark = document.createComment('');
      node.replaceWith(mark);
      slot.append(node);
      borrowed.push([node, mark]);
    }
    if (!legacy) search.placeholder = 'Search climbs';   // the board is out of reach here
    document.body.append(sheet);
    sheet.showModal();
  }
  sheet.addEventListener('close', () => {
    dropFilters();
    for (const [node, mark] of borrowed.splice(0)) mark.replaceWith(node);
    search.placeholder = listPlaceholder;
    sheet.remove();
  });
  // A tap on the dimmed backdrop closes it.
  sheet.addEventListener('click', (e) => {
    if (e.target !== sheet) return;
    const box = sheet.getBoundingClientRect();
    if (e.clientY < box.top || e.clientY > box.bottom || e.clientX < box.left || e.clientX > box.right) sheet.close();
  });

  // ---- list ----------------------------------------------------------------------
  // (climb-list: on phones each climb is one line, its name and yuzus)
  const list = h('div', { class: 'route-list climb-list' });
  const scroller = h('div', { class: 'list-scroll' },
    legacy && h('p', { class: 'hint list-note' }, 'Routes retired because a hold they use was removed from the wall. Removed holds show as faded, red-ringed ghosts.'),
    list);
  const scrolling = trackListScroll(root, scroller, state.listScroll, legacy ? 'legacy' : 'climbs');
  // On phones the list is a sheet under the board that a swipe up raises over it (sheet.js).
  const listSheet = enableSheet(root.parentElement, scroller);

  // ---- typing on phones ------------------------------------------------------------
  // The keyboard covers the lower half of a phone's screen, and the search
  // sits under the board, so focusing it raises the list's sheet; it stays
  // up until swiped down or a climb is picked. The Filters sheet instead takes
  // the whole screen while its search is typed in (app.css `typing`), and
  // drops back a moment after the keyboard closes, so the tap that closed it
  // still lands where aimed. The keyboard's Search key closes the keyboard.
  let dropTimer;
  function dropFilters() {
    clearTimeout(dropTimer);
    sheet.classList.remove('typing');
  }
  search.addEventListener('focus', () => {
    clearTimeout(dropTimer);
    if (!PHONE.matches) return;
    if (sheet.open) sheet.classList.add('typing');
    else listSheet.raise();
  });
  search.addEventListener('blur', () => {
    clearTimeout(dropTimer);
    if (sheet.classList.contains('typing')) dropTimer = setTimeout(dropFilters, 300);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && PHONE.matches) search.blur();
  });

  // ---- the climb on the board ------------------------------------------------------
  // On phones a tap on a climb shows it on the board, its row outlined, and a
  // second tap (or its ›) opens it. With a mouse, hovering a climb shows it
  // for as long as the pointer stays, and a click opens it. Coming back from
  // a climb, that climb stays on the board and outlined.
  let climbById = new Map();   // every climb drawn (problems and variations), by id

  const open = (id) => ctx.go(`#/route/${id}`);

  // Shows climb `id` on the board (none if it isn't in the list) and returns
  // its card, now outlined.
  function showOnBoard(id) {
    const climb = id != null ? climbById.get(id) : null;
    state.boardRouteId = climb ? id : null;
    board.setRoute(climb ? climb.holds : [], { instant: true });
    list.querySelector('.route-card.on-board')?.classList.remove('on-board');
    const row = climb && list.querySelector(`[data-route-id="${id}"]`);
    const card = row ? row.closest('.route-card') : null;
    card?.classList.add('on-board');
    return card;
  }

  // Scrolls the list so `card` is its top row.
  function toTop(card) {
    const pad = parseFloat(getComputedStyle(scroller).paddingTop) || 0;
    scroller.scrollTop += card.getBoundingClientRect().top - scroller.getBoundingClientRect().top - pad;
  }

  // A tap on a climb's row on a phone: onto the board, or open if it's there.
  // Picked from the raised sheet, the sheet lowers with that climb on top.
  function pick(id) {
    if (state.boardRouteId === id) return open(id);
    const raised = listSheet.isUp();
    const card = showOnBoard(id);
    if (raised && card) {
      listSheet.lower();
      toTop(card);
    }
  }

  // On phones a swipe across the board steps to the problem before or after
  // the one on it, in list order (variations are skipped, as on a climb's
  // page). That one goes on the board and becomes the top row; its holds slide
  // in while the wall stays put.
  function neighbour(dir) {
    const ids = state.climbSequence?.ids || [];
    const on = climbById.get(state.boardRouteId);
    const at = on ? ids.indexOf(on.parent_id ?? on.id) : -1;
    if (at < 0) return dir > 0 ? ids[0] : undefined;   // nothing on the board yet: start at the top
    return ids[at + dir];
  }
  const stopSwipe = enableSwipe(ctx.boardEl, {
    moving: board.swipeLayer,
    canStep: (dir) => !!neighbour(dir),
    // not zoomed in (a drag pans then), nor with the sheet raised over the board
    canSwipe: () => PHONE.matches && !board.isZoomed() && !listSheet.isUp(),
    onStep: (dir) => {
      if (ctx.stale()) {
        settleSwipe(board.swipeLayer);   // left the page mid-swipe
        return;
      }
      const card = showOnBoard(neighbour(dir));
      if (card) toTop(card);
      consumeSwipe(board.swipeLayer);
    },
  });

  function previewOn(route) {
    const show = (holds) => () => {
      if (HOVER.matches) board.preview(holds);
    };
    return {
      onMouseenter: show(route.holds),
      onMouseleave: show(null),
      onFocus: show(route.holds),
      onBlur: show(null),
    };
  }

  // Meta parts tagged with the sort key they show, so the active one stands out.
  function metaParts(parts) {
    const nodes = [];
    parts.filter(Boolean).forEach(([key, text], i) => {
      if (i) nodes.push(' · ');
      nodes.push(h('span', { class: key === f.sort ? 'sorted-by' : null }, text));
    });
    return nodes;
  }

  function metaLines(route) {
    return [
      h('div', { class: 'route-meta' }, metaParts([
        [null, route.setter_name ? `Set by ${route.setter_name}` : 'Setter unknown'],
        ['set_date', fmtDate(route.set_date)],
      ])),
      h('div', { class: 'route-meta' }, route.fa_name
        ? metaParts([
          [null, `FA ${route.fa_name}`],
          ['fa_date', fmtDate(route.fa_date)],
          ['ascents', plural(route.ascent_count, 'ascent')],
          ['sends', `${route.send_count} incl. repeats`],
        ])
        : metaParts([[f.sort === 'ascents' || f.sort === 'sends' || f.sort === 'fa_date' ? f.sort : null, 'No ascents yet']])),
    ];
  }

  // The right-hand detail on a variation row follows the active sort.
  function variationStat(v) {
    if (!v.fa_name && ['fa_date', 'ascents', 'sends'].includes(f.sort)) return 'No ascents yet';
    switch (f.sort) {
      case 'set_date': return `Set ${fmtDate(v.set_date)}`;
      case 'fa_date': return `FA ${fmtDate(v.fa_date)}`;
      case 'ascents': return plural(v.ascent_count, 'ascent');
      case 'sends': return `${v.send_count} incl. repeats`;
      default: return v.fa_name ? `FA ${v.fa_name}` : 'No ascents yet';
    }
  }

  function variationRow(v) {
    return h('button', {
      type: 'button', class: `variation-row${v.possible || legacy ? '' : ' impossible'}`, dataset: { routeId: v.id },
      title: v.possible ? '' : `Uses removed hold${v.removed_holds.length > 1 ? 's' : ''}: ${v.removed_holds.join(', ')}`,
      onPointerdown: () => prefetchRoute(ctx, v.id),
      onClick: () => ctx.go(`#/route/${v.id}`), ...previewOn(v),
    },
    gradePips(v.grade, { label: false }),
    h('span', { class: 'route-name' }, v.name),
    v.sent_by_me && sentMark(14),
    !v.possible && !legacy && impossibleTag(),
    h('span', { class: 'muted small' }, variationStat(v)));
  }

  function familyRemovedHolds(route) {
    return [...new Set([route, ...route.variations].flatMap((r) => r.removed_holds))];
  }

  function card(route) {
    const shown = route.variations.length;
    const total = route.variation_total;
    const someImpossible = !legacy && route.impossible_total > 0;
    const baseImpossible = !legacy && !route.possible;
    const removed = legacy ? familyRemovedHolds(route) : [];
    return h('article', { class: `route-card${route.matched ? '' : ' unmatched'}${legacy ? ' legacy' : ''}`, dataset: { routeId: route.id } },
      h('button', {
        type: 'button', class: `route-main${baseImpossible ? ' impossible' : ''}`,
        // fetched while the finger is still down, so the climb opens at once
        // (on phones, only once it's on the board: then a tap opens it)
        onPointerdown: () => {
          if (!PHONE.matches || state.boardRouteId === route.id) prefetchRoute(ctx, route.id);
        },
        onClick: () => (PHONE.matches ? pick(route.id) : open(route.id)), ...previewOn(route),
      },
      h('div', { class: 'route-title' },
        gradePips(route.grade, { label: false }),
        h('span', { class: 'route-name' }, route.name),
        route.sent_by_me && sentMark(16),
        route.variation_sent && sentMark(16, { half: true }),
        baseImpossible && impossibleTag()),
      metaLines(route),
      legacy && h('div', { class: 'route-meta removed-note' }, `Retired — removed hold${removed.length > 1 ? 's' : ''}: ${removed.join(', ')}`),
      !route.matched && h('div', { class: 'route-meta' }, 'Only a variation matches these filters')),
      // phones: opens the climb (a tap on the row shows it on the board)
      h('button', {
        type: 'button', class: 'route-open', 'aria-label': `Open ${route.name}`, title: 'Open',
        onPointerdown: () => prefetchRoute(ctx, route.id),
        onClick: () => open(route.id),
      }, icon('chevron-right', { size: 18 })),
      someImpossible && h('div', { class: 'family-warning' }, icon('alert', { size: 14 }),
        `Not all variations are possible — ${route.impossible_total} of ${total + 1} use${route.impossible_total === 1 ? 's' : ''} a removed hold`),
      total > 0 && h('details', { class: 'variations', open: !route.matched || someImpossible || null },
        h('summary', {}, shown === total ? plural(total, 'variation') : `${shown} of ${plural(total, 'variation')}`),
        route.variations.map(variationRow)));
  }

  // Coming back from a climb (the last one shown, after any swipes), it is
  // the one on the board: the top row on a phone, in view otherwise.
  const returned = state.lastRouteId != null;
  if (returned) {
    state.boardRouteId = state.lastRouteId;
    state.lastRouteId = null;
  }

  function revealReturned() {
    const card = returned && list.querySelector('.route-card.on-board');
    if (!card) return;
    if (PHONE.matches) return toTop(card);
    list.querySelector(`.variation-row[data-route-id="${state.boardRouteId}"]`)?.closest('details')?.setAttribute('open', '');
    const box = card.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    if (box.top < view.top || box.bottom > view.bottom) card.scrollIntoView({ block: 'nearest' });
  }

  // The list as last fetched, per page and query: coming back draws it at
  // once, and redraws it only if the fresh copy differs.
  const cacheKey = legacy ? 'legacy' : 'climbs';
  const queryKey = () => JSON.stringify(listQuery(state, legacy));
  let drawn = null;   // the JSON of the climbs on show

  // `reset` (a filter or sort change) jumps back to the top of the list;
  // otherwise the list returns to where it was left.
  async function load({ reset = false } = {}) {
    const token = ++loadToken;
    ctx.savePrefs();
    const key = queryKey();
    list.setAttribute('aria-busy', 'true');
    const routes = await ctx.api.routes(listQuery(state, legacy));
    if (token !== loadToken || ctx.stale()) return;
    list.removeAttribute('aria-busy');
    const json = JSON.stringify(routes);
    state.listCache[cacheKey] = { key, json, routes };
    if (json !== drawn) {
      draw(routes, json);
      if (!reset) scrolling.restore();
    }
    if (reset) scrolling.reset();
  }

  function draw(routes, json) {
    drawn = json;
    // The route page steps through these problems, in this order, with a swipe.
    state.climbSequence = { legacy, ids: routes.map((r) => r.id) };
    const climbCount = routes.reduce((n, r) => n + (r.matched ? 1 : 0) + r.variations.length, 0);
    count.textContent = plural(climbCount, legacy ? 'retired climb' : 'climb');
    showButton.textContent = climbCount ? `Show ${count.textContent}` : 'No climbs match';
    let empty;
    if (activeFilterCount()) {
      empty = h('div', { class: 'empty' }, 'No climbs match these filters.',
        h('button', { type: 'button', class: 'btn', onClick: clearFilters }, 'Clear all filters'));
    } else if (legacy) {
      empty = h('div', { class: 'empty' }, 'No legacy routes. Routes land here when a hold they use is removed from the wall.');
    } else {
      empty = h('div', { class: 'empty' }, 'No routes yet.',
        h('button', { type: 'button', class: 'btn btn-primary', onClick: () => ctx.go('#/new') }, 'Set the first boulder'));
    }
    list.replaceChildren(...(routes.length ? routes.map(card) : [empty]));
    climbById = new Map(routes.flatMap((r) => [[r.id, r], ...r.variations.map((v) => [v.id, v])]));
    showOnBoard(state.boardRouteId);
  }

  root.classList.add('view-list');
  root.replaceChildren(controls, scroller);
  if (!legacy) board.setMode('pick');
  board.setPicked(legacy ? null : f.holdId);
  renderChips();
  renderDir();

  const cached = state.listCache[cacheKey];
  if (cached && cached.key === queryKey()) {
    draw(cached.routes, cached.json);
    scrolling.restore();
    revealReturned();
    load();   // and quietly check for changes
  } else {
    list.replaceChildren(...skeletonCards());
    await load();
    if (!ctx.stale()) revealReturned();
  }

  return {
    onHoldClick(hold) {
      if (!legacy) setHold(f.holdId === hold.id ? null : hold.id);
    },
    destroy() {
      clearTimeout(debounce);
      scrolling.stop();
      listSheet.stop();
      stopSwipe();
      dropFilters();
      if (sheet.open) sheet.close();   // e.g. Legacy was tapped inside it
    },
  };
}
