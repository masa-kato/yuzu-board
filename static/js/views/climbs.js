import { GRADES, append, cap, fmtDate, gradePips, h, icon, trackListScroll } from '../ui.js';

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

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// The /api/routes query for the list as it is filtered and sorted now. The
// route page uses it too, to step through the same climbs.
export function listQuery(state, legacy) {
  const f = legacy ? state.legacyFilters : state.filters;
  return {
    q: f.q.trim(),
    scope: f.scope,
    grade: f.grades.join(','),
    hold_id: legacy ? null : f.holdId,
    me: state.me,
    hide_sent_by: f.hideSent && state.me ? state.me : null,
    legacy: legacy ? 1 : null,
    sort: f.sort,
    dir: f.dir,
  };
}

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
  const legacyCount = h('span', { class: 'segment-count' });
  const segments = h('nav', { class: 'segmented-nav', 'aria-label': 'Which routes' },
    h('a', { href: '#/climbs', 'aria-current': legacy ? null : 'page' }, 'Active'),
    h('a', { href: '#/legacy', 'aria-current': legacy ? 'page' : null }, 'Legacy', legacyCount));

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
      ...GRADES.map((g) => chip(cap(g), f.grades.includes(g), () => {
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
      ...f.grades.map((g) => removable(cap(g), () => {
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
  const slots = { show: h('div'), scope: h('div'), filters: h('div'), sort: h('div') };
  const section = (label, slot) => h('section', { class: 'sheet-section' }, h('h3', { class: 'sheet-label' }, label), slot);
  const sheet = h('dialog', { class: 'dialog sheet filter-sheet', 'aria-label': 'Filter and sort' },
    h('div', { class: 'sheet-head' },
      h('h2', {}, 'Filter & sort'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onClick: () => sheet.close() }, icon('x', { size: 18 }))),
    h('div', { class: 'sheet-body' },
      section('Show', slots.show), section('Search in', slots.scope), section('Filters', slots.filters), section('Sort', slots.sort)),
    h('div', { class: 'sheet-foot' }, showButton));
  const borrowed = [];   // [node, placeholder] while the sheet holds them

  function openSheet() {
    for (const [node, slot] of [[segments, slots.show], [scope, slots.scope], [chips, slots.filters], [sortRow, slots.sort]]) {
      const mark = document.createComment('');
      node.replaceWith(mark);
      slot.append(node);
      borrowed.push([node, mark]);
    }
    document.body.append(sheet);
    sheet.showModal();
  }
  sheet.addEventListener('close', () => {
    for (const [node, mark] of borrowed.splice(0)) mark.replaceWith(node);
    sheet.remove();
  });
  // A tap on the dimmed backdrop closes it.
  sheet.addEventListener('click', (e) => {
    if (e.target !== sheet) return;
    const box = sheet.getBoundingClientRect();
    if (e.clientY < box.top || e.clientY > box.bottom || e.clientX < box.left || e.clientX > box.right) sheet.close();
  });

  // ---- list ----------------------------------------------------------------------
  const list = h('div', { class: 'route-list' });
  const scroller = h('div', { class: 'list-scroll' },
    legacy && h('p', { class: 'hint list-note' }, 'Routes retired because a hold they use was removed from the wall. Removed holds show as faded, red-ringed ghosts.'),
    list);
  const scrolling = trackListScroll(root, scroller, state.listScroll, legacy ? 'legacy' : 'climbs');

  function previewOn(route) {
    return {
      onMouseenter: () => board.preview(route.holds),
      onMouseleave: () => board.preview(null),
      onFocus: () => board.preview(route.holds),
      onBlur: () => board.preview(null),
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
      onClick: () => ctx.go(`#/route/${v.id}`), ...previewOn(v),
    },
    gradePips(v.grade, { label: false }),
    h('span', { class: 'route-name' }, v.name),
    v.sent_by_me && h('span', { class: 'sent-check', title: 'You have sent this' }, icon('check', { size: 14, label: 'Sent' })),
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
        onClick: () => ctx.go(`#/route/${route.id}`), ...previewOn(route),
      },
      h('div', { class: 'route-title' },
        gradePips(route.grade, { label: false }),
        h('span', { class: 'route-name' }, route.name),
        route.sent_by_me && h('span', { class: 'sent-check', title: 'You have sent this' }, icon('check', { size: 15, label: 'Sent' })),
        baseImpossible && impossibleTag()),
      metaLines(route),
      legacy && h('div', { class: 'route-meta removed-note' }, `Retired — removed hold${removed.length > 1 ? 's' : ''}: ${removed.join(', ')}`),
      !route.matched && h('div', { class: 'route-meta' }, 'Only a variation matches these filters')),
      someImpossible && h('div', { class: 'family-warning' }, icon('alert', { size: 14 }),
        `Not all variations are possible — ${route.impossible_total} of ${total + 1} use${route.impossible_total === 1 ? 's' : ''} a removed hold`),
      total > 0 && h('details', { class: 'variations', open: !route.matched || someImpossible || null },
        h('summary', {}, shown === total ? plural(total, 'variation') : `${shown} of ${plural(total, 'variation')}`),
        route.variations.map(variationRow)));
  }

  // Briefly outlines the climb that was open before coming back to the list.
  function markLastViewed() {
    const id = state.lastRouteId;
    state.lastRouteId = null;
    if (!id) return;
    const row = list.querySelector(`[data-route-id="${id}"]`);
    if (!row) return;
    row.closest('details')?.setAttribute('open', '');   // a variation: show it
    const target = row.closest('.route-card') || row;
    target.classList.add('recent');
    const box = target.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    if (box.top < view.top || box.bottom > view.bottom) target.scrollIntoView({ block: 'nearest' });
  }

  // `reset` (a filter or sort change) jumps back to the top of the list;
  // otherwise the list returns to where it was left.
  async function load({ reset = false } = {}) {
    const token = ++loadToken;
    ctx.savePrefs();
    list.setAttribute('aria-busy', 'true');
    const routes = await ctx.api.routes(listQuery(state, legacy));
    if (token !== loadToken || ctx.stale()) return;
    list.removeAttribute('aria-busy');
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
    if (reset) scrolling.reset();
    else scrolling.restore();
  }

  root.classList.add('view-list');
  root.replaceChildren(controls, scroller);
  list.replaceChildren(...skeletonCards());
  if (!legacy) board.setMode('pick');
  board.setPicked(legacy ? null : f.holdId);
  renderChips();
  renderDir();

  ctx.api.routes({ legacy: 1 }).then((families) => {
    if (!ctx.stale()) legacyCount.textContent = families.length ? String(families.length) : '';
  }).catch(() => {});

  await load();
  if (!ctx.stale()) markLastViewed();

  return {
    onHoldClick(hold) {
      if (!legacy) setHold(f.holdId === hold.id ? null : hold.id);
    },
    destroy() {
      clearTimeout(debounce);
      scrolling.stop();
      if (sheet.open) sheet.close();   // e.g. Legacy was tapped inside it
    },
  };
}
