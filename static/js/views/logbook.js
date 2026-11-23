import { monthCalendar, monthOf } from '../calendar.js';
import { HEALTHY, drawHands, worstFinger } from '../hands.js';
import { confirmDialog, dialog, faBadge, field, fmtDate, gradePips, h, icon, stat, today, trackListScroll } from '../ui.js';

function monthLabel(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

// "Sat, Nov 14" (the year is in the month heading above).
function dayLabel(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export async function render(root, ctx, { day: openDay = null } = {}) {
  const { state } = ctx;
  if (!state.me) {
    ctx.sidePane.replaceChildren(h('div', { class: 'empty' }, 'Your calendar shows here once you choose who you are.'));
    root.replaceChildren(h('h1', {}, 'Logbook'),
      h('div', { class: 'empty' }, 'Choose who you are in the top-right corner to see your send log.'));
    return;
  }

  // Outdoor sessions and workouts are the admin's alone (auth.py).
  const mine = state.admin && state.me === state.adminId;
  const [log, { days }, sessions] = await Promise.all([
    ctx.api.logbook(state.me), ctx.api.days(state.me), mine ? ctx.api.outdoorSessions() : [],
  ]);
  if (ctx.stale()) return;

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

  async function editTry(t) {
    const date = h('input', { type: 'date', class: 'input', required: true, value: t.tried_date, max: today() });
    const note = h('textarea', { class: 'input', rows: 3, value: t.note, placeholder: 'What did you learn?' });
    const result = await dialog({
      title: `Edit try · ${t.display_name}`,
      body: h('div', {}, field('Date', date), field('Note', note)),
      actions: [{ value: 'cancel', label: 'Cancel' }, { value: 'ok', label: 'Save', class: 'btn-primary' }],
    });
    if (result !== 'ok') return;
    try {
      await ctx.api.updateTry(t.id, { tried_date: date.value, note: note.value });
      ctx.toast('Try updated.', 'success');
      ctx.go('#/logbook');
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  async function deleteTry(t) {
    const ok = await confirmDialog('Remove this try?', `${t.display_name} on ${fmtDate(t.tried_date)}.`, 'Remove');
    if (!ok) return;
    try {
      await ctx.api.deleteTry(t.id);
      ctx.toast('Try removed.');
      ctx.go('#/logbook');
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  const routeLink = (entry) => h('button', { type: 'button', class: 'link', onClick: () => ctx.go(`#/route/${entry.route_id}`) }, entry.display_name);
  const legacyTag = (entry) => !entry.possible && h('span', { class: 'badge legacy-tag', title: 'Uses a hold that was removed from the wall' }, 'Legacy');
  const actions = (what, onEdit, onDelete) => h('div', { class: 'send-actions' },
    h('button', { type: 'button', class: 'icon-btn', title: `Edit ${what}`, 'aria-label': `Edit ${what}`, onClick: onEdit }, icon('pencil', { size: 15 })),
    onDelete && h('button', { type: 'button', class: 'icon-btn danger', title: `Delete ${what}`, 'aria-label': `Delete ${what}`, onClick: onDelete }, icon('trash', { size: 15 })));

  function sendEntry(send) {
    return h('article', { class: `send-entry ${send.is_repeat ? 'repeat' : 'first'}` },
      h('div', { class: 'send-body' },
        h('div', { class: 'send-title' },
          routeLink(send),
          gradePips(send.grade, { label: false }),
          send.is_fa && faBadge(),
          send.is_repeat && h('span', { class: 'badge repeat-tag' }, 'Repeat'),
          legacyTag(send)),
        send.comment && h('p', { class: 'send-comment' }, send.comment)),
      actions('send', () => editSend(send), () => deleteSend(send)));
  }

  function tryEntry(t) {
    return h('article', { class: 'send-entry tried' },
      h('div', { class: 'send-body' },
        h('div', { class: 'send-title' },
          routeLink(t),
          gradePips(t.grade, { label: false }),
          h('span', { class: 'badge tried-tag' }, 'Tried'),
          legacyTag(t)),
        t.note && h('p', { class: 'send-comment' }, t.note)),
      actions('try', () => editTry(t), () => deleteTry(t)));
  }

  // A day out: a line per climb, like the home board's (its grade, which
  // session on it this was, and "Tried" if it wasn't sent, then its note).
  // The pencil opens the session, which has its area and notes. A session
  // with no climbs yet is one line.
  function outdoorEntries(session) {
    const edit = () => ctx.go(`#/outdoor/${session.id}`);
    if (!session.entries.length) {
      return h('article', { class: 'send-entry outdoor' },
        h('div', { class: 'send-body' },
          h('div', { class: 'send-title' }, h('button', { type: 'button', class: 'link', onClick: edit }, 'Outdoor session'))),
        actions('session', edit));
    }
    return session.entries.map((e) => h('article', { class: 'send-entry outdoor' },
      h('div', { class: 'send-body' },
        h('div', { class: 'send-title' },
          h('button', { type: 'button', class: 'link', onClick: () => ctx.go(`#/outdoor-climb/${e.climb_id}`) }, e.name),
          h('span', { class: 'outdoor-grade' }, [e.grade, `Session ${e.session_number}`].filter(Boolean).join(' · ')),
          !e.sent && h('span', { class: 'badge tried-tag' }, 'Tried')),
        e.note && h('p', { class: 'send-comment' }, e.note)),
      actions('session', edit)));
  }

  // The day's finger checks: start and end side by side, each with its sorest
  // finger and comment.
  function fingersEntry(date, checks) {
    const phase = (key, label) => checks[key] && h('div', { class: 'fingers-check' },
      drawHands(checks[key].scores, { width: 72 }),
      h('div', { class: 'fingers-check-text' },
        h('div', { class: 'fingers-phase' }, h('strong', {}, label), h('span', { class: 'muted' }, ` · ${worstFinger(checks[key].scores)}`)),
        checks[key].comment && h('p', { class: 'send-comment' }, checks[key].comment)));
    return h('article', { class: 'send-entry fingers-entry' },
      h('div', { class: 'send-body' },
        h('div', { class: 'send-title' }, h('span', { class: 'badge fingers-tag' }, 'Fingers')),
        h('div', { class: 'fingers-checks' }, phase('start', 'Start of session'), phase('end', 'End of session'))),
      actions('finger check', () => ctx.go(`#/fingers?date=${date}`)));
  }

  // A day as a dropdown, saying what happened but not how much (more sends
  // doesn't make a better session). The latest day starts open and the rest
  // closed; one you open or close stays that way while the app is open.
  const dayEls = new Map();
  function day(date, items, latest) {
    const kinds = [
      items.sends.some((s) => !s.is_repeat) && 'sent', items.sends.some((s) => s.is_repeat) && 'repeated',
      items.tries.length && 'tried', items.outdoor.length && 'outdoors', items.fingers && 'fingers',
    ].filter(Boolean).join(' · ');
    const el = h('details', { class: 'log-day', open: (state.logOpenDays[date] ?? latest) || null },
      h('summary', { onClick: () => (state.logOpenDays[date] = !el.open) },
        h('span', { class: 'log-day-date' }, dayLabel(date)),
        h('span', { class: 'log-day-kinds' }, kinds)),
      h('div', { class: 'log-day-sends' },
        items.outdoor.map(outdoorEntries), items.sends.map(sendEntry), items.tries.map(tryEntry),
        items.fingers && fingersEntry(date, items.fingers),
        mine && days[date]?.workout && h('button', { type: 'button', class: 'link workout-link', onClick: () => ctx.go(`#/workout?date=${date}`) },
          icon('arrow-right', { size: 14 }), 'Workout that day')));
    dayEls.set(date, el);
    return el;
  }

  // Each day's sends, tries, outdoor sessions and finger checks together,
  // newest day first, under its month. The checks come with the calendar's days.
  function renderList() {
    const byDay = new Map();
    const bucket = (date) => {
      if (!byDay.has(date)) byDay.set(date, { sends: [], tries: [], outdoor: [], fingers: null });
      return byDay.get(date);
    };
    for (const s of log.sends) if (state.logShowRepeats || !s.is_repeat) bucket(s.sent_date).sends.push(s);
    for (const t of log.tries) bucket(t.tried_date).tries.push(t);
    for (const s of sessions) bucket(s.session_date).outdoor.push(s);
    if (mine) for (const [date, info] of Object.entries(days)) if (info.fingers) bucket(date).fingers = info.fingers;
    dayEls.clear();
    if (!byDay.size) {
      list.replaceChildren(h('div', { class: 'empty' }, 'Nothing logged yet. Open a climb and hit “Log send” or “Mark tried”.'));
      return;
    }
    const nodes = [];
    let month = null;
    [...byDay.keys()].sort().reverse().forEach((date, i) => {
      const label = monthLabel(date);
      if (label !== month) {
        month = label;
        nodes.push(h('h3', { class: 'month' }, label));
      }
      nodes.push(day(date, byDay.get(date), i === 0));
    });
    list.replaceChildren(...nodes);
  }

  // A day picked on the calendar opens in the list, alone (the others
  // close); a day with only a workout opens the workout.
  let picked = null;
  function pick(date) {
    picked = date;
    calendar.select(date);
    const el = dayEls.get(date);
    if (el) {
      for (const [d, other] of dayEls) {
        other.open = d === date;
        state.logOpenDays[d] = d === date;
      }
      // On big screens only the list scrolls (scrollIntoView would nudge the
      // panel around it too); on phones the page does.
      if (scroller.scrollHeight > scroller.clientHeight + 1) {
        const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 12;
        scroller.scrollTo({ top, behavior: 'smooth' });
      } else {
        el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
      el.classList.remove('flash');
      requestAnimationFrame(() => el.classList.add('flash'));
    } else if (mine && days[date]?.workout) {
      ctx.go(`#/workout?date=${date}`);
    } else {
      ctx.toast(`Nothing logged on ${fmtDate(date)}.`);
    }
  }
  const calendar = monthCalendar({
    month: state.calendarMonth || monthOf(today()), days, workouts: mine,
    onPick: pick, onMonth: (m) => (state.calendarMonth = m),
  });
  ctx.sidePane.replaceChildren(calendar.el);

  // Title, stats and the toggles stay put; only the log scrolls.
  const { summary } = log;
  const controls = h('div', { class: 'list-controls' },
    h('div', { class: 'panel-head' }, h('h1', {}, `${log.climber.name}’s logbook`)),
    h('div', { class: 'stats' },
      stat(summary.unique_climbs, 'climbs sent'),
      stat(summary.total_sends, 'total sends'),
      stat(summary.first_ascents, 'first ascents')),
    // Outdoor sessions are logged on the Outdoors tab; they still show here, on their days.
    mine && h('div', { class: 'actions log-actions' },
      h('button', { type: 'button', class: 'btn btn-small', onClick: () => ctx.go(`#/fingers?date=${picked || today()}`) },
        drawHands(HEALTHY(), { width: 30, hover: false, label: '' }), 'Fingers')),
    h('div', { class: 'log-controls' },
      h('label', { class: 'toggle' }, repeatsToggle, h('span', {}, 'Show repeats')),
      h('div', { class: 'log-legend' },
        [['first', 'First send'], ['repeat', 'Repeat'], ['tried', 'Tried'], ...(mine ? [['outdoor', 'Outdoor'], ['fingers', 'Fingers']] : [])]
          .map(([kind, label]) => h('span', { class: 'legend-item' }, h('span', { class: `legend-swatch ${kind}` }), label)))));
  root.classList.add('view-list');
  root.replaceChildren(controls, scroller);
  renderList();
  scrolling.restore();
  if (openDay) pick(openDay);

  return {
    destroy() {
      scrolling.stop();
    },
  };
}
