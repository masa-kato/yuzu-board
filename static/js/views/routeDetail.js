import {
  ROLES, ROLE_LABELS, append, celebrate, climberOptions, confirmDialog, dialog, faBadge, field, fmtDate, gradePips, h, icon, roleDot, sentMark, today,
} from '../ui.js';
import { NAME_MAX, plural as pluralize } from './circuits.js';
import { listQuery } from './climbs.js';
import { consumeSwipe, enableSwipe, settleSwipe } from '../swipe.js';

// The problems the Climbs (or Legacy) list shows, in its order: as last
// listed, or fetched with the saved filters after a reload or a direct link.
async function climbSequence(ctx, route) {
  const { state } = ctx;
  const cached = state.climbSequence;
  if (cached && cached.legacy === route.legacy && cached.ids.includes(route.parent_id || route.id)) return cached;
  try {
    const routes = await ctx.api.routes(listQuery(state, route.legacy));
    state.climbSequence = { legacy: route.legacy, ids: routes.map((r) => r.id) };
    return state.climbSequence;
  } catch {
    return null;
  }
}

// Stepping to the previous / next climb (a swipe or the arrows) shouldn't wait
// on the network: the climbs either side are fetched ahead, and the circuit
// being stepped through is reused. Only a step uses them, for the climber they
// were fetched for and for a minute at most; anything else fetches afresh.
const AHEAD_MS = 60_000;
let ahead = new Map();     // route id -> { at, me, data: a promise of the route, or of null if the fetch failed }
let circuitAhead = null;   // { at, me, circuit } the circuit last fetched
let steppedTo = null;      // the route id a step is on its way to

const fresh = (entry, me) => !!entry && entry.me === me && Date.now() - entry.at < AHEAD_MS;

// Likewise a climb pressed in a list is fetched while the finger is still
// down, for the page that opens when it lifts (and for nothing else).
const PRESS_MS = 5_000;
let pressed = null;   // { id, at, me, data } the climb last pressed

export function prefetchRoute(ctx, id) {
  const { me } = ctx.state;
  if (pressed && pressed.id === id && pressed.me === me && Date.now() - pressed.at < PRESS_MS) return;
  pressed = { id, at: Date.now(), me, data: ctx.api.route(id, me).catch(() => null) };
}

export async function render(root, ctx, { routeId, circuitId = null }) {
  const { state, board } = ctx;
  const stepped = steppedTo === routeId;
  const justPressed = pressed && pressed.id === routeId && pressed.me === state.me && Date.now() - pressed.at < PRESS_MS;
  const early = stepped && fresh(ahead.get(routeId), state.me) ? ahead.get(routeId).data : justPressed ? pressed.data : null;
  pressed = null;
  const sameCircuit = stepped && !!circuitId && fresh(circuitAhead, state.me) && circuitAhead.circuit.id === circuitId;
  steppedTo = null;
  ahead = new Map();
  const fetchRoute = () => ctx.api.route(routeId, state.me);
  const [route, circuit] = await Promise.all([
    early ? early.then((r) => r || fetchRoute()) : fetchRoute(),
    // A circuit that has gone just drops the circuit context.
    sameCircuit ? circuitAhead.circuit : circuitId ? ctx.api.circuit(circuitId, state.me).catch(() => null) : null,
  ]);
  if (circuit && !sameCircuit) circuitAhead = { at: Date.now(), me: state.me, circuit };
  if (ctx.stale()) return;
  board.setRoute(route.holds, { instant: true });
  consumeSwipe(board.swipeLayer);   // slide in, when a swipe brought us here
  state.lastRouteId = route.id;   // the climbs list marks it when you come back

  const base = route.family[0];
  const variationCount = route.family.length - 1;
  const variationsSent = route.family.filter((r) => r.parent_id && r.sent_by_me).length;   // by you
  // Opened as a step of a circuit (and still in it): prev / next through it.
  const step = circuit ? circuit.routes.findIndex((r) => r.id === route.id) : -1;
  const inCircuit = step >= 0;
  if (inCircuit) state.lastCircuitId = circuit.id;   // and the circuits list marks this
  const here = inCircuit ? `#/route/${route.id}?circuit=${circuit.id}` : `#/route/${route.id}`;

  // Stepping to the previous / next climb (arrows, or swiping the wall): through
  // the circuit when opened from one, otherwise through the list's problems
  // (variations are skipped; a variation steps from its problem's place).
  let order = null;
  if (inCircuit) {
    order = { ids: circuit.routes.map((r) => r.id), at: step, link: (id) => `#/route/${id}?circuit=${circuit.id}` };
  } else {
    const seq = await climbSequence(ctx, route);
    if (ctx.stale()) return;
    const at = seq ? seq.ids.indexOf(route.parent_id || route.id) : -1;
    if (at >= 0) order = { ids: seq.ids, at, link: (id) => `#/route/${id}` };
  }
  const neighbour = (dir) => (order ? order.ids[order.at + dir] : undefined);
  const stepTo = (dir) => {
    const id = neighbour(dir);
    if (!id) return;
    steppedTo = id;
    ctx.go(order.link(id));
  };

  // The problem and its variations, in rows like the Climbs list's: the
  // grade, a yuzu slice on the ones you've sent, and this one outlined. A tap
  // opens one; the last row adds a variation.
  const familyList = h('div', { class: 'family-list', role: 'list', 'aria-label': 'The problem and its variations' },
    route.family.map((r) => {
      const current = r.id === route.id;
      return h('button', {
        type: 'button', role: 'listitem', class: `family-row${current ? ' current' : ''}${r.possible ? '' : ' impossible'}`,
        'aria-current': current ? 'page' : null,
        onPointerdown: () => {
          if (!current) prefetchRoute(ctx, r.id);
        },
        onClick: () => {
          if (!current) ctx.go(`#/route/${r.id}`);
        },
      },
      r.parent_id && h('span', { class: 'family-arrow', 'aria-hidden': 'true' }, '↳'),
      h('span', { class: 'family-name' }, r.name),
      !r.parent_id && h('span', { class: 'family-original' }, 'original'),
      r.sent_by_me && sentMark(15),
      !r.possible && h('span', { class: 'badge impossible-tag' }, 'Not possible'),
      gradePips(r.grade, { label: false }),
      icon('chevron-right', { size: 16 }));
    }),
    h('button', { type: 'button', class: 'family-row family-add', onClick: () => ctx.go(`#/new?parent=${base.id}`) },
      icon('plus', { size: 15 }), 'Add a variation'));

  const counts = Object.fromEntries(ROLES.map((role) => [role, route.holds.filter((x) => x.role === role).length]));
  // The hold counts double as the legend: a chip spotlights its role on the
  // board, and tapping it again shows every role.
  let spotlit = null;
  const roleChips = ROLES.map((role) => h('button', {
    type: 'button', class: `chip hold-count role-${role}`, 'aria-pressed': 'false', disabled: counts[role] === 0,
    title: `Highlight the ${ROLE_LABELS[role].toLowerCase()} holds`,
    onClick: () => {
      spotlit = spotlit === role ? null : role;
      board.spotlight(spotlit);
      roleChips.forEach((chip, i) => {
        chip.classList.toggle('on', ROLES[i] === spotlit);
        chip.setAttribute('aria-pressed', String(ROLES[i] === spotlit));
      });
    },
  }, roleDot(role), `${counts[role]} ${ROLE_LABELS[role]}`));

  // ---- log a send ----------------------------------------------------------
  const climberSelect = h('select', { class: 'input', required: true },
    climberOptions(state.climbers, state.me, state.me ? null : 'Choose climber…'));
  const dateInput = h('input', { type: 'date', class: 'input', required: true, value: today(), max: today() });
  const comment = h('textarea', { class: 'input', rows: 3, placeholder: 'How did it go? Beta, conditions, …' });
  const sendForm = h('form', {
    class: 'card send-form', hidden: true,
    onSubmit: async (e) => {
      e.preventDefault();
      try {
        const result = await ctx.api.logSend({
          route_id: route.id,
          climber_id: Number(climberSelect.value),
          sent_date: dateInput.value,
          comment: comment.value,
        });
        const who = ctx.climberName(Number(climberSelect.value));
        // A little yuzu burst from the button (bigger for a first ascent).
        celebrate(e.submitter || sendForm.querySelector('[type=submit]'), { big: result.is_fa });
        if (result.is_fa) ctx.toast(`First ascent! ${who} is the first ascensionist.`, 'celebrate');
        else if (result.is_repeat) ctx.toast(`Repeat logged for ${who}.`, 'success');
        else ctx.toast(`Send logged for ${who}.`, 'success');
        ctx.go(here);
      } catch (err) {
        ctx.toast(err.message, 'error');
      }
    },
  },
  h('h3', {}, route.sent_by_me ? 'Log a repeat' : 'Log a send'),
  h('div', { class: 'grid-2' }, field('Climber', climberSelect), field('Date', dateInput)),
  field('Comment (optional)', comment),
  h('div', { class: 'actions' },
    h('button', { type: 'button', class: 'btn', onClick: () => (sendForm.hidden = true) }, 'Cancel'),
    h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save send')));

  // ---- mark tried ------------------------------------------------------------
  // Tried it today, sent or not: one mark a day (attempts aren't counted),
  // with what you learned on it. A second mark that day just updates the note.
  const triedToday = route.my_history.find((x) => x.kind === 'try' && x.date === today());
  const tryDate = h('input', { type: 'date', class: 'input', required: true, value: today(), max: today() });
  const tryNote = h('textarea', { class: 'input', rows: 3, placeholder: 'What did you learn? Beta, what to try next time, …', value: triedToday?.note || '' });
  const removeTry = async () => {
    try {
      await ctx.api.deleteTry(triedToday.id);
      ctx.toast('Mark removed.');
      ctx.go(here);
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  };
  const tryForm = h('form', {
    class: 'card send-form', hidden: true,
    onSubmit: async (e) => {
      e.preventDefault();
      const me = ctx.requireMe();
      if (!me) return;
      try {
        await ctx.api.markTried({ route_id: route.id, climber_id: me, tried_date: tryDate.value, note: tryNote.value });
        ctx.toast(tryDate.value === today() ? 'Marked tried today.' : `Marked tried on ${fmtDate(tryDate.value)}.`, 'success');
        ctx.go(here);
      } catch (err) {
        ctx.toast(err.message, 'error');
      }
    },
  },
  h('h3', {}, triedToday ? 'Tried today' : 'Mark tried'),
  h('div', { class: 'grid-2' }, field('Date', tryDate)),
  field('Note (optional)', tryNote),
  h('div', { class: 'actions' },
    triedToday && h('button', { type: 'button', class: 'btn btn-ghost-danger', onClick: removeTry }, 'Remove mark'),
    h('button', { type: 'button', class: 'btn', onClick: () => (tryForm.hidden = true) }, 'Cancel'),
    h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save')));

  // Opening one of the two forms closes the other.
  const toggleForm = (form, focus) => {
    const opening = form.hidden;
    sendForm.hidden = true;
    tryForm.hidden = true;
    form.hidden = !opening;
    if (opening) focus.focus();
  };

  // Your tries and sends on it, newest first, with their notes.
  const history = state.me && route.my_history.length > 0 && h('section', { class: 'my-history' },
    h('h2', {}, `Your sessions (${route.my_history.length})`),
    h('ol', {}, route.my_history.map((x) => h('li', {},
      h('div', { class: 'my-history-head' },
        h('span', { class: `badge ${x.kind === 'send' ? 'sent-tag' : 'tried-tag'}` }, x.kind === 'send' ? 'Sent' : 'Tried'),
        h('span', { class: 'muted' }, fmtDate(x.date))),
      x.note && h('p', { class: 'my-history-note' }, x.note)))));

  const deleteRoute = async () => {
    const extra = route.parent_id ? '' : variationCount ? ` and its ${variationCount} variation(s)` : '';
    const ok = await confirmDialog(`Delete “${route.display_name}”?`,
      `This permanently removes the route${extra}, along with every logged send.`);
    if (!ok) return;
    try {
      await ctx.api.deleteRoute(route.id);
      ctx.toast('Route deleted.');
      if (inCircuit) ctx.go(`#/circuit/${circuit.id}`);
      else ctx.go(route.parent_id ? `#/route/${route.parent_id}` : '#/climbs');
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  };

  // Until somebody sends it, a climb can go back to Drafts to finish setting.
  const unsent = route.send_count === 0 && !route.fa_date;
  const hasVariations = !route.parent_id && variationCount > 0;
  const toDraft = async () => {
    const names = route.circuits.map((c) => `“${c.name}”`);
    const ok = await confirmDialog(`Move “${route.display_name}” to drafts?`,
      `It leaves the climb lists until it's published again from Drafts.${names.length ? ` It also comes out of ${names.length > 1 ? 'the circuits' : 'the circuit'} ${names.join(', ')}.` : ''}`,
      'Move to drafts', 'btn-primary');
    if (!ok) return;
    try {
      const draft = await ctx.api.routeToDraft(route.id, state.me);
      state.lastDraftId = draft.id;
      ctx.toast(`Moved “${route.display_name}” to drafts.`, 'success');
      ctx.go('#/drafts');
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  };

  // ---- circuits --------------------------------------------------------------
  // Tick the circuits this climb belongs in, or start a new one with it.
  const chooseCircuits = async () => {
    let circuits;
    try {
      circuits = await ctx.api.circuits();
    } catch (err) {
      ctx.toast(err.message, 'error');
      return;
    }
    const member = new Set(route.circuits.map((c) => c.id));
    const choices = circuits.map((c) => ({
      circuit: c,
      // A climb that is no longer possible can leave circuits but not join new ones.
      box: h('input', { type: 'checkbox', checked: member.has(c.id), disabled: !route.possible && !member.has(c.id) }),
    }));
    const newName = h('input', { type: 'text', class: 'input', placeholder: 'e.g. Tuesday warm-up', maxlength: NAME_MAX, autocomplete: 'off' });
    const result = await dialog({
      title: `Circuits for ${route.display_name}`,
      body: h('div', { class: 'circuit-choices' },
        choices.length
          ? h('div', { class: 'choice-list' }, choices.map(({ circuit: c, box }) => h('label', { class: 'toggle choice' },
            box, h('span', { class: 'choice-name' }, c.name), h('span', { class: 'muted small' }, pluralize(c.route_count, 'climb')))))
          : h('p', { class: 'muted' }, 'No circuits yet. Name one below to start it with this climb.'),
        route.possible
          ? field('New circuit (optional)', newName)
          : h('p', { class: 'hint' }, 'This climb uses a removed hold, so it can only be taken out of circuits.')),
      actions: [{ value: 'cancel', label: 'Cancel' }, { value: 'ok', label: 'Save', class: 'btn-primary' }],
    });
    if (result !== 'ok') return;
    const added = choices.filter(({ circuit: c, box }) => box.checked && !member.has(c.id)).map(({ circuit: c }) => c);
    const removed = choices.filter(({ circuit: c, box }) => !box.checked && member.has(c.id)).map(({ circuit: c }) => c);
    const name = route.possible ? newName.value.trim() : '';
    try {
      for (const c of added) await ctx.api.addToCircuit(c.id, route.id);
      for (const c of removed) await ctx.api.removeFromCircuit(c.id, route.id);
      if (name) added.push(await ctx.api.createCircuit({ name, created_by: state.me, route_ids: [route.id] }));
      const parts = [];
      if (added.length) parts.push(`Added to ${added.map((c) => c.name).join(', ')}`);
      if (removed.length) parts.push(`${parts.length ? 'removed' : 'Removed'} from ${removed.map((c) => c.name).join(', ')}`);
      if (parts.length) ctx.toast(`${parts.join('; ')}.`, 'success');
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
    ctx.go(here);   // redraw with the new memberships (also after a partial failure)
  };

  // ‹ title · 3 of 7 ›: the circuit bar (every size) or the list bar (phones).
  const stepBar = ({ kind, title, label, back, backTitle, names = {} }) => {
    const arrow = (dir) => {
      const id = neighbour(dir);
      const word = dir < 0 ? 'Previous' : 'Next';
      const name = names[id];
      return h('button', {
        type: 'button', class: 'icon-btn', disabled: !id, onClick: id && (() => stepTo(dir)),
        title: id ? `${word}${name ? `: ${name}` : ' climb'}` : null,
        'aria-label': id ? `${word} climb${name ? `: ${name}` : ''}` : `No ${word.toLowerCase()} climb`,
      }, icon(dir < 0 ? 'arrow-left' : 'arrow-right', { size: 17 }));
    };
    return h('nav', { class: `step-bar ${kind}`, 'aria-label': label },
      arrow(-1),
      h('button', { type: 'button', class: 'step-bar-name', onClick: back, title: backTitle },
        h('span', { class: 'step-bar-title' }, title),
        h('span', { class: 'step-bar-step' }, `${order.at + 1} of ${order.ids.length}`)),
      arrow(1));
  };

  const removed = route.removed_holds.join(', ');
  const plural = route.removed_holds.length > 1;
  let banner = null;
  if (route.legacy) {
    banner = h('div', { class: 'banner warn' },
      h('strong', {}, 'Legacy route. '),
      `It uses ${plural ? 'holds' : 'a hold'} that ${plural ? 'were' : 'was'} removed from the wall (${removed}), as does every variation. `,
      'Edit it and swap in other holds to bring it back.');
  } else if (!route.possible) {
    banner = h('div', { class: 'banner warn' },
      h('strong', {}, 'Not possible. '),
      `${plural ? 'Holds' : 'Hold'} ${removed} ${plural ? 'were' : 'was'} removed from the wall. Other variations of this problem can still be climbed.`);
  } else if (route.family.some((r) => !r.possible)) {
    const n = route.family.filter((r) => !r.possible).length;
    banner = h('div', { class: 'banner info' }, `Not all variations are possible — ${n} of ${route.family.length} use${n === 1 ? 's' : ''} a removed hold.`);
  }

  // ---- layout ----------------------------------------------------------------
  root.replaceChildren();   // drop the loading placeholder
  let back;
  if (inCircuit) {
    // ← All circuits › Pinches: back to the list of circuits, or to this
    // circuit's climbs (as is the bar's name).
    back = [
      h('nav', { class: 'back-trail', 'aria-label': 'Breadcrumb' },
        h('button', { type: 'button', class: 'back-link', onClick: () => ctx.go('#/circuits') }, icon('arrow-left', { size: 15 }), 'All circuits'),
        icon('chevron-right', { size: 14 }),
        h('button', { type: 'button', class: 'back-link', title: 'Back to the circuit', onClick: () => ctx.go(`#/circuit/${circuit.id}`) },
          h('span', { class: 'back-trail-name' }, circuit.name))),
      stepBar({
        kind: 'circuit-bar', title: circuit.name, label: `Circuit: ${circuit.name}`,
        back: () => ctx.go(`#/circuit/${circuit.id}`), backTitle: 'Back to the circuit',
        names: Object.fromEntries(circuit.routes.map((r) => [r.id, r.display_name])),
      }),
    ];
  } else {
    const [listHash, listName, linkText] = route.legacy ? ['#/legacy', 'Legacy', 'Legacy routes'] : ['#/climbs', 'Climbs', 'All climbs'];
    // Phones also get the list bar under the back link, when the climb is in the list.
    back = [
      h('button', { type: 'button', class: 'back-link', onClick: () => ctx.go(listHash) }, icon('arrow-left', { size: 15 }), linkText),
      order && stepBar({ kind: 'list-bar', title: listName, label: `${listName} list`, back: () => ctx.go(listHash), backTitle: `Back to ${listName}` }),
    ];
  }
  append(root, [
    back,
    h('div', { class: 'route-kicker' }, route.parent_id ? `Variation of ${base.name}` : 'Original problem'),
    h('h1', { class: 'route-heading' }, route.name,
      route.sent_by_me && sentMark(26)),
    h('div', { class: 'field' },
      h('span', { class: 'field-label' }, variationCount ? `Variations (${variationCount})${variationsSent ? ` · ${variationsSent} sent` : ''}` : 'Variations'),
      familyList),
    h('dl', { class: 'meta' },
      h('dt', {}, 'Grade'), h('dd', {}, gradePips(route.grade)),
      h('dt', {}, 'Setter'), h('dd', {}, route.setter_name || '—'),
      h('dt', {}, 'Set on'), h('dd', {}, fmtDate(route.set_date)),
      h('dt', {}, 'First ascent'), h('dd', {}, route.fa_name
        ? [route.fa_name, h('span', { class: 'muted' }, ` · ${fmtDate(route.fa_date)}`)]
        : h('span', { class: 'muted' }, 'Not sent yet')),
      h('dt', {}, 'Ascents'), h('dd', {},
        `${route.ascent_count} ${route.ascent_count === 1 ? 'climber' : 'climbers'}`,
        h('span', { class: 'muted' }, ` · ${route.send_count} including repeats`)),
      h('dt', {}, 'Holds'), h('dd', { class: 'hold-counts' }, roleChips),
      route.circuits.length > 0 && [
        h('dt', {}, 'Circuits'),
        h('dd', { class: 'circuit-links' }, route.circuits.map((c) => h('button', {
          type: 'button', class: 'link', onClick: () => ctx.go(`#/circuit/${c.id}`),
        }, c.name))),
      ]),
    banner,
    route.notes && h('p', { class: 'notes' }, route.notes),
    h('div', { class: 'actions' },
      h('button', {
        type: 'button', class: 'btn btn-primary', disabled: !route.possible,
        title: route.possible ? '' : 'This climb uses a removed hold',
        onClick: () => toggleForm(sendForm, comment),
      }, route.sent_by_me ? 'Log repeat' : 'Log send'),
      h('button', {
        type: 'button', class: `btn${triedToday ? ' tried-today' : ''}`, disabled: !route.possible,
        title: route.possible ? 'Tried it today, sent or not' : 'This climb uses a removed hold',
        onClick: () => toggleForm(tryForm, tryNote),
      }, triedToday ? [icon('check', { size: 15 }), 'Tried today'] : 'Mark tried'),
      h('button', { type: 'button', class: 'btn', onClick: () => ctx.go(`#/edit/${route.id}`) }, 'Edit'),
      h('button', { type: 'button', class: 'btn', onClick: chooseCircuits }, icon('plus', { size: 15 }), 'Add to circuit'),
      unsent && h('button', {
        type: 'button', class: 'btn', onClick: toDraft, disabled: hasVariations,
        title: hasVariations ? 'Its variations would have nothing to hang off' : 'Nobody has sent it yet, so it can go back to Drafts',
      }, 'Move to drafts'),
      h('button', { type: 'button', class: 'btn btn-ghost-danger', onClick: deleteRoute }, 'Delete')),
    sendForm,
    tryForm,
    history,
    h('section', { class: 'ascents' },
      h('h2', {}, `Ascents (${route.ascents.length})`),
      route.ascents.length
        ? h('ol', {}, route.ascents.map((a) => h('li', { class: a.climber_id === state.me ? 'me' : '', dataset: { initial: a.name.charAt(0).toUpperCase() } },
          h('span', { class: 'ascent-name' }, a.name), a.is_fa && faBadge(),
          h('span', { class: 'muted' }, fmtDate(a.first_sent)))))
        : h('p', { class: 'muted' }, 'Nobody has sent this yet — be the first ascensionist!')),
  ]);

  // Swiping the wall sideways (touch) steps to the previous / next climb.
  // The swipe moves only the climb's holds on phones; the wall stays put.
  const stopSwipe = order && enableSwipe(ctx.boardEl, {
    moving: board.swipeLayer,
    canStep: (dir) => !!neighbour(dir),
    canSwipe: () => !board.isZoomed(),   // zoomed in, a sideways drag pans the board instead
    onStep: (dir) => {
      if (ctx.stale()) settleSwipe(board.swipeLayer);   // left the page mid-swipe
      else stepTo(dir);
    },
  });
  // Once the page has slid in, fetch the climbs either side.
  const fetchAhead = order && setTimeout(() => {
    if (ctx.stale()) return;
    for (const id of [neighbour(-1), neighbour(1)]) {
      if (id && !ahead.has(id)) ahead.set(id, { at: Date.now(), me: state.me, data: ctx.api.route(id, state.me).catch(() => null) });
    }
  }, 300);
  return {
    destroy() {
      if (stopSwipe) stopSwipe();
      clearTimeout(fetchAhead);
    },
  };
}
