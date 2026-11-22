// The admin's finger check for a day (fingers.py), at #/fingers?date=&phase=:
// tap a fingertip, then its score from 0 (healthy) to 10 (most painful), and
// say how they feel. Start and end of session are kept apart;
// a rest day has only the end. The check before shows above the fingertips,
// and a new check starts from its scores. Under the form, every check's scores.

import { sideCalendar } from '../calendar.js';
import { FINGERS_ACROSS, FINGER_NAMES, HEALTHY, drawHands, fingerColor, worstFinger } from '../hands.js';
import { confirmDialog, field, fmtDate, h, icon, shortDate, today } from '../ui.js';

const PHASES = { start: 'Start of session', end: 'End of session' };
const HISTORY_SHOWN = 20;   // rows before "Show all"

export async function render(root, ctx, { date = null, phase = null } = {}) {
  date = date || today();
  const [day, { checks }] = await Promise.all([ctx.api.fingers(date), ctx.api.fingerHistory()]);
  if (ctx.stale()) return;
  sideCalendar(ctx, { selected: date, link: (d) => `#/fingers?date=${d}` });

  // The check before each phase's: the day's start for its end, else the
  // last one on an earlier day (fingers.py), or none.
  const before = {
    start: day.previous,
    end: day.start ? { date, phase: 'start', ...day.start } : day.previous,
  };
  // Each phase's scores and comment as edited here. A check not logged yet
  // starts from the one before (every finger healthy, with none).
  const drafts = {
    start: { scores: [...((day.start || before.start)?.scores || HEALTHY())], comment: day.start?.comment || '' },
    end: { scores: [...((day.end || before.end)?.scores || HEALTHY())], comment: day.end?.comment || '' },
  };
  let current = PHASES[phase] ? phase : day.start ? 'end' : 'start';
  // The sorest finger, to start on; none when all are healthy.
  const sorest = (scores) => (Math.max(...scores) > 0 ? scores.indexOf(Math.max(...scores)) : null);
  let selected = sorest(drafts[current].scores);

  const tabs = h('div', { class: 'segmented-nav', role: 'tablist', 'aria-label': 'When' });
  const lastBox = h('section', { class: 'finger-last', 'aria-label': 'Last check' });
  const handsBox = h('div', { class: 'finger-hands' });
  const fingerName = h('div', { class: 'finger-name' });
  const scale = h('div', { class: 'finger-scale', role: 'group', 'aria-label': 'Score' });
  const comment = h('textarea', {
    class: 'input', rows: 3, placeholder: 'e.g. Left middle tweaky on crimps, fine on slopers',
    onInput: () => (drafts[current].comment = comment.value),
  });
  const saveButton = h('button', { type: 'submit', class: 'btn btn-primary' });
  const deleteButton = h('button', { type: 'button', class: 'btn btn-ghost-danger', onClick: () => remove() }, 'Delete');
  const history = historyTable(ctx, checks);

  function setScore(score) {
    if (selected == null) return;
    drafts[current].scores[selected] = score;
    draw();
  }

  function draw() {
    const draft = drafts[current];
    tabs.replaceChildren(...Object.entries(PHASES).map(([key, label]) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(key === current), 'aria-current': key === current ? 'page' : null,
      onClick: () => {
        current = key;
        selected = sorest(drafts[current].scores);
        draw();
      },
    }, label, day[key] && icon('check', { size: 14 }))));
    const last = before[current];
    lastBox.hidden = !last;
    if (last) lastBox.replaceChildren(
      drawHands(last.scores, { width: 72 }),
      h('div', { class: 'fingers-check-text' },
        h('strong', { class: 'finger-last-title' }, day[current] ? 'Last check' : 'Starting from your last check'),
        h('div', { class: 'fingers-phase muted' },
          [last.date === today() ? 'Today' : fmtDate(last.date), PHASES[last.phase].toLowerCase(), worstFinger(last.scores)].join(' · ')),
        last.comment && h('p', { class: 'send-comment' }, last.comment)));
    handsBox.replaceChildren(drawHands(draft.scores, {
      width: 340, selected, numbers: true, label: `${PHASES[current]}: tap a finger to score it`,
      onPick: (i) => {
        selected = i;
        draw();
        handsBox.querySelectorAll('.hand-finger')[i]?.focus();
      },
    }), h('div', { class: 'finger-hand-names', 'aria-hidden': 'true' }, h('span', {}, 'Left hand'), h('span', {}, 'Right hand')));
    fingerName.replaceChildren(...(selected == null
      ? [h('span', { class: 'muted' }, 'Tap a finger to score it.')]
      : [h('strong', {}, FINGER_NAMES[selected]), h('span', { class: 'muted' }, ` · ${draft.scores[selected]} of 10`)]));
    scale.replaceChildren(...Array.from({ length: 11 }, (_, i) => h('button', {
      type: 'button', class: `finger-score${selected != null && draft.scores[selected] === i ? ' on' : ''}`,
      style: `--score:${fingerColor(i)}`, disabled: selected == null,
      'aria-label': `${i}${i === 0 ? ', healthy' : i === 10 ? ', most painful' : ''}`,
      onClick: () => {
        setScore(i);
        scale.querySelector('.finger-score.on')?.focus();   // the row was drawn again
      },
    }, i)));
    comment.value = draft.comment;
    saveButton.textContent = `Save ${PHASES[current].toLowerCase()}`;
    deleteButton.hidden = !day[current];
    history.mark(date, current);
  }

  // On a computer, 0–9 score the chosen finger, and 1 then 0 quickly makes 10.
  let lastKey = null;
  const onKey = (e) => {
    if (selected == null || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (!/^[0-9]$/.test(e.key)) return;
    e.preventDefault();
    const ten = e.key === '0' && lastKey?.key === '1' && e.timeStamp - lastKey.at < 800;
    lastKey = { key: e.key, at: e.timeStamp };
    setScore(ten ? 10 : Number(e.key));
  };
  document.addEventListener('keydown', onKey);

  async function save(e) {
    e.preventDefault();
    try {
      await ctx.api.saveFingers(date, current, drafts[current]);
      ctx.toast(`Saved the ${current === 'start' ? 'start' : 'end'}-of-session check.`, 'success');
      ctx.go(`#/logbook?day=${date}`);
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  async function remove() {
    if (!(await confirmDialog(`Delete the ${PHASES[current].toLowerCase()} check?`, `Your fingers on ${fmtDate(date)}.`))) return;
    try {
      await ctx.api.deleteFingers(date, current);
      ctx.toast('Check deleted.');
      ctx.go(`#/fingers?date=${date}&phase=${current}`);
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  const dateInput = h('input', {
    type: 'date', class: 'input', required: true, value: date, max: today(),
    onChange: () => dateInput.value && ctx.go(`#/fingers?date=${dateInput.value}&phase=${current}`),
  });

  draw();
  root.replaceChildren(
    h('button', { type: 'button', class: 'back-link', onClick: () => ctx.go(`#/logbook?day=${date}`) }, icon('arrow-left', { size: 15 }), 'Logbook'),
    h('h1', {}, 'Fingers'),
    h('form', { class: 'editor finger-form', onSubmit: save },
      h('div', { class: 'grid-2' }, field('Date', dateInput)),
      tabs,
      lastBox,
      handsBox,
      h('div', { class: 'finger-pick' },
        fingerName,
        scale,
        h('div', { class: 'finger-scale-ends', 'aria-hidden': 'true' }, h('span', {}, 'healthy'), h('span', {}, 'most painful'))),
      field('How do they feel?', comment),
      h('div', { class: 'actions' },
        saveButton,
        h('button', { type: 'button', class: 'btn', onClick: () => ctx.go(`#/logbook?day=${date}`) }, 'Cancel'),
        deleteButton)),
    history.el);

  return {
    destroy() {
      document.removeEventListener('keydown', onKey);
    },
  };
}

// Every check, the newest first, as a row of its ten scores with the fingers
// in the order they're drawn (pinky to thumb, thumb to pinky). A row opens its
// check; the one in the form is marked. Returns { el, mark(date, phase) }.
function historyTable(ctx, checks) {
  const el = h('section', { class: 'finger-history', 'aria-label': 'History' }, h('h2', {}, 'History'));
  if (!checks.length) {
    el.append(h('p', { class: 'muted' }, 'Your checks will show here, each with every finger’s score.'));
    return { el, mark() {} };
  }
  const rows = checks.map((c, i) => {
    const link = `#/fingers?date=${c.date}&phase=${c.phase}`;
    const newDay = i === 0 || checks[i - 1].date !== c.date;
    const row = h('tr', { class: newDay ? 'fh-day' : '', onClick: (e) => !e.target.closest('a') && ctx.go(link) },
      h('th', { scope: 'row', class: 'fh-date' }, newDay && shortDate(c.date)),
      h('td', { class: 'fh-phase' }, h('a', { href: link, 'aria-label': `${fmtDate(c.date)}, ${PHASES[c.phase].toLowerCase()}` }, c.phase === 'start' ? 'Start' : 'End')),
      ...FINGERS_ACROSS.map((f, k) => h('td', { class: k === 5 ? 'fh-right' : null },
        h('span', {
          class: `fh-score${c.scores[f] > 0 ? '' : ' healthy'}`, style: `--score:${fingerColor(c.scores[f])}`,
          title: `${FINGER_NAMES[f]} ${c.scores[f]}`,
        }, c.scores[f]))));
    row.dataset.key = `${c.date}/${c.phase}`;
    return row;
  });
  const body = h('tbody', {}, rows.slice(0, HISTORY_SHOWN));
  const initial = (f) => ['T', 'I', 'M', 'R', 'P'][f % 5];
  el.append(h('div', { class: 'finger-table-wrap' },
    h('table', { class: 'finger-table' },
      h('thead', {},
        h('tr', {}, h('td', { colspan: 2 }),
          h('th', { scope: 'colgroup', colspan: 5 }, 'Left hand'),
          h('th', { scope: 'colgroup', colspan: 5, class: 'fh-right' }, 'Right hand')),
        h('tr', { class: 'fh-fingers' },
          h('th', { scope: 'col' }, h('span', { class: 'visually-hidden' }, 'Date')),
          h('th', { scope: 'col' }, h('span', { class: 'visually-hidden' }, 'When')),
          ...FINGERS_ACROSS.map((f, k) => h('th', { scope: 'col', class: k === 5 ? 'fh-right' : null, title: FINGER_NAMES[f] },
            h('span', { 'aria-hidden': 'true' }, initial(f)), h('span', { class: 'visually-hidden' }, FINGER_NAMES[f]))))),
      body)));
  if (rows.length > HISTORY_SHOWN) {
    const more = h('button', {
      type: 'button', class: 'btn btn-small',
      onClick: () => {
        body.append(...rows.slice(HISTORY_SHOWN));
        more.remove();
      },
    }, `Show all ${rows.length} checks`);
    el.append(more);
  }
  return {
    el,
    mark(date, phase) {
      for (const row of rows) row.classList.toggle('current', row.dataset.key === `${date}/${phase}`);
    },
  };
}
