import { GRADES, append, confirmDialog, gradeLabel, gradePips, h, icon, promptDialog, sentMark, trackListScroll } from '../ui.js';

// Circuits: named, ordered playlists of climbs, shared by everyone.
export const NAME_MAX = 80;

export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// "Easy–Hard", or a single grade when every climb has it.
function gradeRange(grades) {
  if (!grades.length) return null;
  const levels = grades.map((g) => GRADES.indexOf(g));
  const lo = GRADES[Math.min(...levels)];
  const hi = GRADES[Math.max(...levels)];
  return lo === hi ? gradeLabel(lo) : `${gradeLabel(lo)}–${gradeLabel(hi)}`;
}

function metaLine(circuit) {
  return [plural(circuit.route_count, 'climb'), gradeRange(circuit.grades), circuit.creator_name && `by ${circuit.creator_name}`]
    .filter(Boolean).join(' · ');
}

// How much of the circuit the current climber has sent.
function progress(circuit, me) {
  if (!me || !circuit.route_count) return null;
  const { sent_count: sent, route_count: total } = circuit;
  return h('div', { class: `circuit-progress${sent === total ? ' done' : ''}` },
    h('div', {
      class: 'progress-track', role: 'progressbar', 'aria-label': 'Climbs you have sent',
      'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': sent,
    }, h('span', { class: 'progress-fill', style: `width:${(100 * sent) / total}%` })),
    h('span', { class: 'progress-label' }, sent === total ? `You've sent all ${total}` : `You've sent ${sent} of ${total}`));
}

function impossibleTag() {
  return h('span', { class: 'badge impossible-tag' }, 'Not possible');
}

function removedTitle(route) {
  return route.possible ? null : `Uses removed hold${route.removed_holds.length > 1 ? 's' : ''}: ${route.removed_holds.join(', ')}`;
}

// Asks for a name, creates the circuit and opens it ready to add climbs.
async function newCircuit(ctx) {
  const name = await promptDialog('New circuit', 'Name', 'e.g. Tuesday warm-up', { confirmLabel: 'Create', maxLength: NAME_MAX });
  if (!name) return;
  try {
    const circuit = await ctx.api.createCircuit({ name, created_by: ctx.state.me }, ctx.state.me);
    ctx.go(`#/circuit/${circuit.id}?add=1`);
  } catch (err) {
    ctx.toast(err.message, 'error');
  }
}

// ---- the list of circuits ------------------------------------------------------

export async function render(root, ctx) {
  const { state } = ctx;
  const circuits = await ctx.api.circuits(state.me);
  if (ctx.stale()) return;

  const list = h('div', { class: 'route-list' });
  const scroller = h('div', { class: 'list-scroll' }, list);
  const scrolling = trackListScroll(root, scroller, state.listScroll, 'circuits');
  const controls = h('div', { class: 'list-controls' },
    h('div', { class: 'list-head' },
      h('div', { class: 'circuits-title' }, h('h1', {}, 'Circuits'), h('span', { class: 'list-count' }, circuits.length ? plural(circuits.length, 'circuit') : '')),
      h('button', { type: 'button', class: 'btn btn-primary btn-small', onClick: () => newCircuit(ctx) }, icon('plus', { size: 15 }), 'New circuit')),
    h('p', { class: 'hint' }, 'Playlists of climbs to do as a set, in order.'));

  function card(c) {
    const impossible = c.route_count - c.possible_count;
    return h('article', { class: 'route-card circuit-card', dataset: { circuitId: c.id } },
      h('button', { type: 'button', class: 'route-main', onClick: () => ctx.go(`#/circuit/${c.id}`) },
        h('div', { class: 'route-title' },
          h('span', { class: 'route-name' }, c.name),
          c.route_count > 0 && c.sent_count === c.route_count && state.me && sentMark(15)),
        h('div', { class: 'route-meta' }, metaLine(c)),
        progress(c, state.me)),
      impossible > 0 && h('div', { class: 'family-warning' }, icon('alert', { size: 14 }),
        `${impossible} of ${c.route_count} climbs ${impossible === 1 ? 'is' : 'are'} no longer possible`));
  }

  list.replaceChildren(...(circuits.length
    ? circuits.map(card)
    : [h('div', { class: 'empty' }, 'No circuits yet. Group climbs into a playlist to do as a set.',
      h('button', { type: 'button', class: 'btn btn-primary', onClick: () => newCircuit(ctx) }, 'New circuit'))]));
  root.classList.add('view-list');
  root.replaceChildren(controls, scroller);
  scrolling.restore();

  // Briefly outline the circuit that was open before coming back.
  const recent = state.lastCircuitId && list.querySelector(`[data-circuit-id="${state.lastCircuitId}"]`);
  state.lastCircuitId = null;
  if (recent) {
    recent.classList.add('recent');
    recent.scrollIntoView({ block: 'nearest' });
  }

  return {
    destroy() {
      scrolling.stop();
    },
  };
}

// ---- one circuit -------------------------------------------------------------------
// Two modes: the circuit's climbs in order (reorder, remove, open), and
// "adding", which lists every climb with an Add / Added toggle. While adding,
// tapping a hold on the board filters the climbs to those that use it.

export async function renderDetail(root, ctx, { circuitId, adding = false }) {
  const { state, board } = ctx;
  let circuit = await ctx.api.circuit(circuitId, state.me);
  if (ctx.stale()) return;
  state.lastCircuitId = circuit.id;

  let addMode = false;
  let candidates = null;   // climbs offered while adding (null while loading)
  let q = '';
  let holdId = null;
  let debounce;
  let loadToken = 0;

  const heading = h('h1', { class: 'route-heading circuit-heading' });
  const meta = h('div', { class: 'route-meta' });
  const progressSlot = h('div', { class: 'progress-slot' });
  const addButton = h('button', { type: 'button', class: 'btn', onClick: () => setAdding(!addMode) });
  const deleteButton = h('button', { type: 'button', class: 'btn btn-ghost-danger', onClick: deleteCircuit }, 'Delete circuit');

  const search = h('input', {
    type: 'search', class: 'search-input', placeholder: 'Search, or tap a hold on the board', 'aria-label': 'Search climbs to add',
    onInput: () => {
      q = search.value;
      clearTimeout(debounce);
      debounce = setTimeout(() => loadCandidates({ reset: true }), 200);
    },
  });
  const holdChip = h('div', { class: 'chip-row' });
  const picker = h('div', { class: 'circuit-picker', hidden: true }, h('div', { class: 'search-field' }, search), holdChip);

  const list = h('div', { class: 'circuit-list' });
  const scroller = h('div', { class: 'list-scroll' }, list);
  const scrolling = trackListScroll(root, scroller, state.listScroll, `circuit-${circuit.id}`);

  const controls = h('div', { class: 'list-controls' },
    h('button', { type: 'button', class: 'back-link', onClick: () => ctx.go('#/circuits') }, icon('arrow-left', { size: 15 }), 'All circuits'),
    h('div', { class: 'route-kicker' }, 'Circuit'),
    heading,
    meta,
    progressSlot,
    h('div', { class: 'actions' }, addButton, deleteButton),
    picker);

  function previewOn(route) {
    return {
      onMouseenter: () => board.preview(route.holds),
      onMouseleave: () => board.preview(null),
      onFocusin: () => board.preview(route.holds),
      onFocusout: () => board.preview(null),
    };
  }

  function renderHeader() {
    heading.replaceChildren(h('span', {}, circuit.name),
      h('button', { type: 'button', class: 'icon-btn', title: 'Rename circuit', 'aria-label': 'Rename circuit', onClick: rename }, icon('pencil', { size: 17 })));
    meta.textContent = metaLine(circuit);
    progressSlot.replaceChildren();
    append(progressSlot, [progress(circuit, state.me)]);
    addButton.className = `btn${addMode ? '' : ' btn-primary'}`;
    addButton.replaceChildren(icon(addMode ? 'check' : 'plus', { size: 15 }), addMode ? 'Done adding' : 'Add climbs');
    deleteButton.hidden = addMode;
    picker.hidden = !addMode;
  }

  // ---- the circuit, in order ----
  function row(route, i) {
    const last = circuit.routes.length - 1;
    const label = route.display_name;
    return h('div', { class: `circuit-row${route.possible ? '' : ' impossible'}`, dataset: { routeId: route.id } },
      h('span', { class: 'circuit-num', 'aria-hidden': 'true' }, String(i + 1)),
      h('button', {
        type: 'button', class: 'circuit-open', title: removedTitle(route),
        onClick: () => ctx.go(`#/route/${route.id}?circuit=${circuit.id}`), ...previewOn(route),
      },
      h('span', { class: 'route-name' }, label),
      route.sent_by_me && sentMark(14),
      !route.possible && impossibleTag(),
      gradePips(route.grade, { label: false })),
      h('div', { class: 'circuit-row-actions' },
        h('button', { type: 'button', class: 'icon-btn', title: 'Move up', 'aria-label': `Move ${label} up`, dataset: { move: '-1' }, disabled: i === 0, onClick: () => move(i, -1) }, icon('arrow-up', { size: 15 })),
        h('button', { type: 'button', class: 'icon-btn', title: 'Move down', 'aria-label': `Move ${label} down`, dataset: { move: '1' }, disabled: i === last, onClick: () => move(i, 1) }, icon('arrow-down', { size: 15 })),
        h('button', { type: 'button', class: 'icon-btn danger', title: 'Remove from circuit', 'aria-label': `Remove ${label} from the circuit`, onClick: () => removeClimb(route) }, icon('x', { size: 15 }))));
  }

  // ---- adding climbs ----
  function candidateRow(route) {
    const at = circuit.routes.findIndex((r) => r.id === route.id);
    const added = at >= 0;
    return h('div', { class: `pick-row${route.possible ? '' : ' impossible'}`, dataset: { routeId: route.id }, title: removedTitle(route), ...previewOn(route) },
      gradePips(route.grade, { label: false }),
      h('span', { class: 'route-name' }, route.display_name),
      route.sent_by_me && sentMark(14),
      !route.possible && impossibleTag(),
      h('button', {
        type: 'button', class: `btn btn-small pick-toggle${added ? ' added' : ''}`, 'aria-pressed': String(added),
        'aria-label': added ? `Remove ${route.display_name} from the circuit` : `Add ${route.display_name} to the circuit`,
        disabled: !added && !route.possible, onClick: () => toggle(route, added),
      }, icon(added ? 'check' : 'plus', { size: 14 }), added ? `Added · ${at + 1}` : 'Add'));
  }

  function renderHoldChip() {
    const hold = holdId && state.holdById.get(holdId);
    holdChip.replaceChildren();
    holdChip.hidden = !hold;
    if (hold) {
      holdChip.append(h('span', { class: 'chip on hold-chip' }, `Uses ${hold.name}`,
        h('button', { type: 'button', class: 'chip-x', 'aria-label': `Stop filtering by ${hold.name}`, onClick: () => setHold(null) }, icon('x', { size: 12 }))));
    }
  }

  function renderBody() {
    board.preview(null);   // the hovered row may be gone
    list.replaceChildren();
    if (addMode) {
      if (!candidates) return;
      append(list, candidates.length
        ? candidates.map(candidateRow)
        : [h('div', { class: 'empty' }, q.trim() || holdId ? 'No climbs match.' : 'No climbs to add yet.')]);
      return;
    }
    append(list, circuit.routes.length
      ? circuit.routes.map(row)
      : [h('div', { class: 'empty' }, 'No climbs in this circuit yet.',
        h('button', { type: 'button', class: 'btn btn-primary', onClick: () => setAdding(true) }, 'Add climbs'))]);
  }

  async function loadCandidates({ reset = false } = {}) {
    const token = ++loadToken;
    list.setAttribute('aria-busy', 'true');
    try {
      const families = await ctx.api.routes({ q: q.trim(), hold_id: holdId, me: state.me });
      if (token !== loadToken || ctx.stale() || !addMode) return;
      // Each problem (when it matches) followed by its matching variations.
      candidates = families.flatMap((f) => [...(f.matched ? [f] : []), ...f.variations]);
      renderBody();
      if (reset) scrolling.reset();
    } catch (err) {
      ctx.toast(err.message, 'error');
    } finally {
      if (token === loadToken) list.removeAttribute('aria-busy');
    }
  }

  function setAdding(on) {
    addMode = on;
    board.setMode(on ? 'pick' : 'view');
    if (on) {
      candidates = null;
      loadCandidates({ reset: true });
      if (window.matchMedia('(pointer: fine)').matches) search.focus();
    } else {
      // The URL may still say ?add=1 from a new circuit; drop it quietly.
      history.replaceState(null, '', `#/circuit/${circuit.id}`);
      q = '';
      search.value = '';
      setHold(null, { reload: false });
      renderBody();
      scrolling.reset();
    }
    renderHeader();
  }

  function setHold(id, { reload = true } = {}) {
    holdId = id;
    board.setPicked(id);
    renderHoldChip();
    if (reload) loadCandidates({ reset: true });
  }

  // Every change returns the updated circuit, so the page redraws from it.
  async function apply(request) {
    try {
      const updated = await request();
      if (ctx.stale()) return false;
      circuit = updated;
      renderHeader();
      renderBody();
      return true;
    } catch (err) {
      ctx.toast(err.message, 'error');
      return false;
    }
  }

  async function move(i, step) {
    const ids = circuit.routes.map((r) => r.id);
    [ids[i], ids[i + step]] = [ids[i + step], ids[i]];
    const id = ids[i + step];
    if (!(await apply(() => ctx.api.updateCircuit(circuit.id, { route_ids: ids }, state.me)))) return;
    // Keep the keyboard on the row that moved.
    const buttons = list.querySelectorAll(`[data-route-id="${id}"] [data-move]`);
    const same = [...buttons].find((b) => b.dataset.move === String(step));
    (same && !same.disabled ? same : [...buttons].find((b) => !b.disabled))?.focus();
  }

  async function removeClimb(route) {
    if (await apply(() => ctx.api.removeFromCircuit(circuit.id, route.id, state.me))) {
      ctx.toast(`Removed ${route.display_name} from the circuit.`);
    }
  }

  async function toggle(route, added) {
    const ok = await apply(() => (added
      ? ctx.api.removeFromCircuit(circuit.id, route.id, state.me)
      : ctx.api.addToCircuit(circuit.id, route.id, state.me)));
    if (ok) list.querySelector(`[data-route-id="${route.id}"] .pick-toggle`)?.focus();
  }

  async function rename() {
    const name = await promptDialog('Rename circuit', 'Name', '', { value: circuit.name, confirmLabel: 'Save', maxLength: NAME_MAX });
    if (!name || name === circuit.name) return;
    if (await apply(() => ctx.api.updateCircuit(circuit.id, { name }, state.me))) ctx.toast('Circuit renamed.', 'success');
  }

  async function deleteCircuit() {
    const ok = await confirmDialog(`Delete “${circuit.name}”?`,
      'This deletes the circuit only. The climbs in it are not affected.', 'Delete circuit');
    if (!ok) return;
    try {
      await ctx.api.deleteCircuit(circuit.id);
      state.lastCircuitId = null;
      ctx.toast('Circuit deleted.');
      ctx.go('#/circuits');
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  root.classList.add('view-list');
  root.replaceChildren(controls, scroller);
  renderHoldChip();
  if (adding) {
    setAdding(true);
  } else {
    renderHeader();
    renderBody();
    scrolling.restore();
    // Coming back from a climb: outline it briefly.
    const recent = state.lastRouteId && list.querySelector(`.circuit-row[data-route-id="${state.lastRouteId}"]`);
    if (recent) {
      state.lastRouteId = null;
      recent.classList.add('recent');
      recent.scrollIntoView({ block: 'nearest' });
    }
  }

  return {
    onHoldClick(hold) {
      if (addMode) setHold(holdId === hold.id ? null : hold.id);
    },
    destroy() {
      clearTimeout(debounce);
      scrolling.stop();
    },
  };
}
