import { confirmDialog, dialog, faBadge, field, fmtDate, gradePips, h, icon, today, trackListScroll } from '../ui.js';

function monthLabel(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

// "Sat, Nov 14" (the year is in the month heading above).
function dayLabel(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function stat(value, label) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-label' }, label));
}

export async function render(root, ctx) {
  const { state, board } = ctx;
  if (!state.me) {
    root.replaceChildren(h('h1', {}, 'Logbook'),
      h('div', { class: 'empty' }, 'Choose who you are in the top-right corner to see your send log.'));
    return;
  }

  const [log, routes] = await Promise.all([ctx.api.logbook(state.me), ctx.api.routes({ me: state.me })]);
  if (ctx.stale()) return;

  const holdsByRoute = new Map();
  for (const r of routes) {
    holdsByRoute.set(r.id, r.holds);
    for (const v of r.variations) holdsByRoute.set(v.id, v.holds);
  }
  const list = h('div', { class: 'sendlog' });
  const scroller = h('div', { class: 'list-scroll' }, list);
  const scrolling = trackListScroll(root, scroller, state.listScroll, 'logbook');
  const repeatsToggle = h('input', {
    type: 'checkbox', checked: state.logShowRepeats,
    onChange: () => {
      state.logShowRepeats = repeatsToggle.checked;
      ctx.savePrefs();
      renderList();
      scrolling.reset();
    },
  });

  async function editSend(send) {
    const date = h('input', { type: 'date', class: 'input', required: true, value: send.sent_date, max: today() });
    const comment = h('textarea', { class: 'input', rows: 3, value: send.comment });
    const result = await dialog({
      title: `Edit send · ${send.display_name}`,
      body: h('div', {}, field('Date', date), field('Comment', comment)),
      actions: [{ value: 'cancel', label: 'Cancel' }, { value: 'ok', label: 'Save', class: 'btn-primary' }],
    });
    if (result !== 'ok') return;
    try {
      await ctx.api.updateSend(send.id, { sent_date: date.value, comment: comment.value });
      ctx.toast('Send updated.', 'success');
      ctx.go('#/logbook');
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  async function deleteSend(send) {
    const ok = await confirmDialog('Delete this send?', `${send.display_name} on ${fmtDate(send.sent_date)}.`);
    if (!ok) return;
    try {
      await ctx.api.deleteSend(send.id);
      ctx.toast('Send deleted.');
      ctx.go('#/logbook');
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  function entry(send) {
    const holds = holdsByRoute.get(send.route_id);
    return h('article', {
      class: `send-entry ${send.is_repeat ? 'repeat' : 'first'}`,
      onMouseenter: () => board.preview(holds),
      onMouseleave: () => board.preview(null),
    },
    h('div', { class: 'send-body' },
      h('div', { class: 'send-title' },
        h('button', { type: 'button', class: 'link', onClick: () => ctx.go(`#/route/${send.route_id}`) }, send.display_name),
        gradePips(send.grade, { label: false }),
        send.is_fa && faBadge(),
        send.is_repeat && h('span', { class: 'badge repeat-tag' }, 'Repeat'),
        !send.possible && h('span', { class: 'badge legacy-tag', title: 'Uses a hold that was removed from the wall' }, 'Legacy')),
      send.comment && h('p', { class: 'send-comment' }, send.comment)),
    h('div', { class: 'send-actions' },
      h('button', { type: 'button', class: 'icon-btn', title: 'Edit send', 'aria-label': 'Edit send', onClick: () => editSend(send) }, icon('pencil', { size: 15 })),
      h('button', { type: 'button', class: 'icon-btn danger', title: 'Delete send', 'aria-label': 'Delete send', onClick: () => deleteSend(send) }, icon('trash', { size: 15 }))));
  }

  // A day of sends as a dropdown. The latest day starts open and the rest
  // closed; one you open or close stays that way while the app is open.
  function day(date, sends, latest) {
    const repeats = sends.filter((s) => s.is_repeat).length;
    const firsts = sends.length - repeats;
    const count = [firsts && plural(firsts, 'send'), repeats && plural(repeats, 'repeat')].filter(Boolean).join(' · ');
    const el = h('details', { class: 'log-day', open: (state.logOpenDays[date] ?? latest) || null },
      h('summary', { onClick: () => (state.logOpenDays[date] = !el.open) },
        h('span', { class: 'log-day-date' }, dayLabel(date)),
        h('span', { class: 'log-day-count' }, count)),
      h('div', { class: 'log-day-sends' }, sends.map(entry)));
    return el;
  }

  // The sends come newest first, so each day's are together, under its month.
  function renderList() {
    const sends = log.sends.filter((s) => state.logShowRepeats || !s.is_repeat);
    if (!sends.length) {
      list.replaceChildren(h('div', { class: 'empty' }, 'No sends logged yet. Open a climb and hit “Log send”.'));
      return;
    }
    const days = [];   // [date, its sends]
    for (const send of sends) {
      const last = days[days.length - 1];
      if (last && last[0] === send.sent_date) last[1].push(send);
      else days.push([send.sent_date, [send]]);
    }
    const nodes = [];
    let month = null;
    days.forEach(([date, daySends], i) => {
      const label = monthLabel(date);
      if (label !== month) {
        month = label;
        nodes.push(h('h3', { class: 'month' }, label));
      }
      nodes.push(day(date, daySends, i === 0));
    });
    list.replaceChildren(...nodes);
  }

  // Title, stats and the repeats toggle stay put; only the send log scrolls.
  const { summary } = log;
  const controls = h('div', { class: 'list-controls' },
    h('div', { class: 'panel-head' }, h('h1', {}, `${log.climber.name}’s logbook`)),
    h('div', { class: 'stats' },
      stat(summary.unique_climbs, 'climbs sent'),
      stat(summary.total_sends, 'total sends'),
      stat(summary.first_ascents, 'first ascents')),
    h('div', { class: 'log-controls' },
      h('label', { class: 'toggle' }, repeatsToggle, h('span', {}, 'Show repeats')),
      h('div', { class: 'log-legend' },
        h('span', { class: 'legend-swatch first' }), 'First send',
        h('span', { class: 'legend-swatch repeat' }), 'Repeat')));
  root.classList.add('view-list');
  root.replaceChildren(controls, scroller);
  renderList();
  scrolling.restore();

  return {
    destroy() {
      scrolling.stop();
    },
  };
}
