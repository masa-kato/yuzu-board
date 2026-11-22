// A month calendar of the days you climbed and worked out (Logbook and
// Workout tabs), in the side pane that takes the wall's place. ‹ › step
// through the months, up to this one; a day is a button, for `onPick`. A day
// with a finger check (the admin's) shows two small hands in its colors.

import { FINGER_COLORS, FINGER_NAMES, drawHands, worstFinger } from './hands.js';
import { h, icon, today } from './ui.js';

const pad = (n) => String(n).padStart(2, '0');

export const monthOf = (iso) => iso.slice(0, 7);

export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// A day's color says what kind of day it was, never how much: more sends
// doesn't make a better session.
const climbedIn = (info) => !!info && (info.sends > 0 || info.tries > 0);
const climbedOut = (info) => !!info && info.outdoor > 0;

// A day's finger checks, for its tooltip: each phase's sorest finger (or the
// finger pointed at, by its index) and comment.
function fingerNotes(date, checks, finger = null) {
  const part = (phase, label) => checks[phase] && h('div', { class: 'cal-tip-part' },
    h('strong', {}, `${label} · ${finger == null ? worstFinger(checks[phase].scores) : `${FINGER_NAMES[finger]} ${checks[phase].scores[finger]}`}`),
    h('span', { class: checks[phase].comment ? '' : 'muted' }, checks[phase].comment || 'No comment'));
  return [
    h('span', { class: 'cal-tip-date' }, date),
    part('start', 'Start of session'),
    part('end', 'End of session'),
    !checks.end && h('span', { class: 'muted' }, 'No end-of-session check yet, so the hands show the start.'),
  ];
}

// `days` is {date: {sends, tries, outdoor, workout, fingers?}} (api.days).
// `workouts` shows the outdoor, workout and finger keys, for the admin. Returns
// { el, show(month), select(date) }.
export function monthCalendar({ month, days, selected = null, workouts = false, onPick, onMonth }) {
  const el = h('section', { class: 'calendar', 'aria-label': 'Calendar' });
  // The comments behind a day's hands, shown on hovering them (or on focusing the day).
  const tip = h('div', { class: 'cal-tip', role: 'tooltip', hidden: true });
  let shown = month;
  let picked = selected;

  function showTip(target, date, checks, finger = null) {
    tip.replaceChildren(...fingerNotes(date, checks, finger).filter(Boolean));
    tip.hidden = false;
    const box = target.getBoundingClientRect();
    const base = el.getBoundingClientRect();
    const left = box.left - base.left + box.width / 2 - tip.offsetWidth / 2;
    tip.style.left = `${Math.max(0, Math.min(base.width - tip.offsetWidth, left))}px`;
    const below = box.bottom - base.top + 6;
    tip.style.top = `${below + tip.offsetHeight > base.height ? box.top - base.top - tip.offsetHeight - 6 : below}px`;
  }
  const hideTip = () => (tip.hidden = true);

  // Sunday first; the weekday names come from the browser's locale.
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(2026, 10, 1 + i)   // Nov 1 2026 is a Sunday
    .toLocaleDateString(undefined, { weekday: 'short' }));

  function draw() {
    const [y, m] = shown.split('-').map(Number);
    const lead = new Date(y, m - 1, 1).getDay();
    const count = new Date(y, m, 0).getDate();
    const now = today();
    const thisMonth = monthOf(now);
    const title = new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    let climbDays = 0;
    let workoutDays = 0;
    let anyHands = false;
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(h('span', { class: 'cal-day blank', 'aria-hidden': 'true' }));
    for (let d = 1; d <= count; d++) {
      const iso = `${shown}-${pad(d)}`;
      const info = days[iso];
      const indoor = climbedIn(info);
      const outdoor = climbedOut(info);
      const workout = workouts && !!info?.workout;
      if (indoor || outdoor) climbDays++;
      if (workout) workoutDays++;
      // Each kind of day has its color: a rectangle of it behind the day
      // (side by side when it was two or three kinds) and a dot.
      const kinds = [indoor && 'climb', outdoor && 'outdoor', workout && 'workout'].filter(Boolean);
      const date = new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
      // The end-of-session colors, or the start's until the end is logged.
      const checks = info?.fingers;
      const check = checks && (checks.end || checks.start);
      if (check) anyHands = true;
      const hands = check && h('span', {
        class: 'cal-hands', 'aria-hidden': 'true',
        onPointerenter: (e) => e.pointerType === 'mouse' && showTip(e.currentTarget, date, checks),
        onPointerleave: hideTip,
      }, drawHands(check.scores, {
        width: 80,
        // Pointing at a fingertip shows its score at each phase in the day's tip.
        hover: (finger) => showTip(hands, date, checks, finger),
      }));
      const said = [indoor && 'climbed', outdoor && 'climbed outdoors', workout && 'worked out', check && `fingers ${worstFinger(check.scores)}`].filter(Boolean);
      cells.push(h('button', {
        type: 'button',
        class: `cal-day${iso === now ? ' today' : ''}${iso === picked ? ' picked' : ''}${kinds.length ? ' logged' : ''}${check ? ' has-hands' : ''}`,
        disabled: iso > now,
        'aria-pressed': String(iso === picked),
        'aria-label': said.length ? `${date}: ${said.join(', ')}` : date,
        onClick: () => onPick?.(iso),
        onFocus: (e) => checks && e.currentTarget.matches(':focus-visible') && showTip(hands, date, checks),
        onBlur: hideTip,
      },
      kinds.length > 0 && h('span', { class: 'cal-fill', 'aria-hidden': 'true' }, kinds.map((k) => h('i', { class: k }))),
      h('span', { class: 'cal-num' }, d),
      // Always there (if empty), so every day's number sits at the same height.
      h('span', { class: 'cal-dots', 'aria-hidden': 'true' }, kinds.map((k) => h('i', { class: `cal-dot ${k}` }))),
      hands));
    }

    const step = (n) => {
      shown = addMonths(shown, n);
      draw();
      onMonth?.(shown);
    };
    const summary = [plural(climbDays, 'day') + ' climbing', workouts && plural(workoutDays, 'workout')].filter(Boolean).join(' · ');
    el.replaceChildren(
      h('div', { class: 'cal-head' },
        h('button', { type: 'button', class: 'icon-btn', title: 'Previous month', 'aria-label': 'Previous month', onClick: () => step(-1) },
          icon('arrow-left', { size: 17 })),
        h('div', { class: 'cal-title' }, h('h2', {}, title), h('span', { class: 'cal-summary' }, summary)),
        shown !== thisMonth && h('button', {
          type: 'button', class: 'btn btn-small cal-today', onClick: () => step((Number(thisMonth.slice(0, 4)) - y) * 12 + Number(thisMonth.slice(5)) - m),
        }, 'Today'),
        h('button', {
          type: 'button', class: 'icon-btn', title: 'Next month', 'aria-label': 'Next month', disabled: shown >= thisMonth, onClick: () => step(1),
        }, icon('arrow-right', { size: 17 }))),
      // Small screens make the days a little taller for hands, in a month that has some.
      h('div', { class: `cal-grid${anyHands ? ' with-hands' : ''}` },
        weekdays.map((w) => h('span', { class: 'cal-weekday', 'aria-hidden': 'true' }, w)),
        cells),
      h('div', { class: 'cal-key' },
        h('span', {}, h('i', { class: 'cal-dot climb' }), 'Climbed'),
        workouts && h('span', {}, h('i', { class: 'cal-dot outdoor' }), 'Outdoors'),
        workouts && h('span', {}, h('i', { class: 'cal-dot workout' }), 'Worked out'),
        workouts && h('span', {}, 'Fingers', h('i', { class: 'cal-finger-scale', style: `background: linear-gradient(to right, ${FINGER_COLORS.join(', ')})` }),
          'healthy → painful')),
      tip);
  }

  draw();
  return {
    el,
    show(m) {
      shown = m;
      draw();
    },
    select(date) {
      picked = date;
      if (date && monthOf(date) !== shown) shown = monthOf(date);
      draw();
    },
  };
}

// The calendar beside pages other than the Logbook (an outdoor session, the
// Workout tab): the climber's days (mine, by default), fetched here. A day
// picked goes to `link(date)`. Doesn't hold the page up: it's drawn when the
// days arrive.
export function sideCalendar(ctx, { climberId = ctx.state.me, selected = null, link }) {
  const { state } = ctx;
  if (!climberId) return;
  ctx.api.days(climberId).then(({ days }) => {
    if (ctx.stale()) return;
    const calendar = monthCalendar({
      month: selected ? monthOf(selected) : state.calendarMonth || monthOf(today()),
      days, selected, workouts: state.admin && climberId === state.adminId,
      onPick: (date) => ctx.go(link(date)), onMonth: (m) => (state.calendarMonth = m),
    });
    ctx.sidePane.replaceChildren(calendar.el);
  }).catch(() => {});
}
