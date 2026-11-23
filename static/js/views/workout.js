// The admin's Workout tab (workouts.py): a day's workout (#/workout, or
// ?date=), the exercise list to add to it from (#/workout/exercises, the same
// ?date=) and an exercise's progress (#/exercise/<id>). A small calendar of the
// workout days, on the right, picks the day.

import { monthCalendar, monthOf } from '../calendar.js';
import { progressChart, sparkline } from '../chart.js';
import { confirmDialog, dialog, field, fmtDate, h, icon, plural, promptDialog, shortDate, today } from '../ui.js';

export const KINDS = {
  weight: { label: 'Weight × reps' },
  bodyweight: { label: 'Bodyweight reps' },
  timed: { label: 'Timed hold' },
  hang: { label: 'Hang (time, weight, edge)' },
};
const TIREDNESS = ['Fresh', 'Good', 'Okay', 'Tired', 'Wrecked'];
const NAME_MAX = 80;

// The set columns each kind fills (workouts.py KIND_FIELDS), in the order
// they're typed: [key, heading, placeholder, inputmode]. Weight on anything
// but a lift is added weight, + or − (no inputmode, so phones offer a minus).
const COLUMNS = {
  weight: [['weight', 'Weight (lb)', 'lb', 'decimal'], ['reps', 'Reps', 'reps', 'numeric']],
  bodyweight: [['reps', 'Reps', 'reps', 'numeric'], ['weight', 'Added (lb)', '+ lb', null]],
  timed: [['seconds', 'Time (s)', 's', 'decimal'], ['weight', 'Added (lb)', '+ lb', null]],
  hang: [['seconds', 'Time (s)', 's', 'decimal'], ['weight', 'Added (lb)', '+ lb', null], ['edge_mm', 'Edge (mm)', 'mm', 'decimal']],
};

const num = (v) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2))));
const signed = (v) => (v > 0 ? `+${num(v)}` : v < 0 ? `−${num(-v)}` : '+0');

// "155 lb", "+25 lb", "10 reps", "45 s": a value in a progress metric.
export function formatMetric(metric, kind, value) {
  if (metric === 'weight') return `${kind === 'weight' ? num(value) : signed(value)} lb`;
  return metric === 'reps' ? `${num(value)} ${value === 1 ? 'rep' : 'reps'}` : `${num(value)} s`;
}

// A set, compactly: "135 × 8", "+25 lb × 5", "45 s", "+20 lb × 10 s · 20 mm".
export function formatSet(kind, s) {
  const added = s.weight != null && s.weight !== 0 ? `${signed(s.weight)} lb` : '';
  if (kind === 'weight') {
    if (s.weight == null) return s.reps != null ? `${s.reps} reps` : '—';
    return s.reps != null ? `${num(s.weight)} × ${s.reps}` : `${num(s.weight)} lb`;
  }
  const main = kind === 'bodyweight' ? (s.reps != null ? `${s.reps} reps` : '') : (s.seconds != null ? `${num(s.seconds)} s` : '');
  const text = [added, main].filter(Boolean).join(' × ') || '—';
  return kind === 'hang' && s.edge_mm != null ? `${text} · ${num(s.edge_mm)} mm` : text;
}

// Sets with something in them (a new set starts empty).
const filledSets = (sets) => sets.filter((s) => ['reps', 'weight', 'seconds', 'edge_mm'].some((k) => s[k] != null));

const blockName = (b) => (b.variant_name ? `${b.exercise_name} · ${b.variant_name}` : b.exercise_name);

function dayTitle(date) {
  if (date === today()) return 'Today';
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

// The tab's links keep the day, unless it's today.
const dateQuery = (date) => (date && date !== today() ? `?date=${date}` : '');
const workoutDay = (date) => `#/workout${dateQuery(date)}`;
const exercisesFor = (date) => `#/workout/exercises${dateQuery(date)}`;
const exercisePage = (id, date) => `#/exercise/${id}${dateQuery(date)}`;

// Workout | Exercises, for the day; Workout counts the day's exercises.
function subTabs(current, date, count) {
  const tab = (key, label, hash) => h('a', { href: hash, 'aria-current': key === current ? 'page' : null }, label);
  const counter = h('span', { class: 'segment-count' }, count || '');
  return {
    el: h('nav', { class: 'segmented-nav', 'aria-label': 'Workout' },
      tab('workout', ['Workout', counter], workoutDay(date)), tab('exercises', 'Exercises', exercisesFor(date))),
    setCount: (n) => (counter.textContent = n || ''),
  };
}

// ---- the calendar on the right ------------------------------------------------------

const TOP_MAX = 5;   // exercises in the month's summary

// The tab's pages share one pane, kept while you go between them (app.js
// keeps the side pane): a small calendar of the workout days, and the month
// it shows summed up under it. Pointing at an exercise lights up its days; an
// exercise's own page keeps its days lit (`pinned`).
let pane = null;
let paneData = null;   // api.workoutDays(), as last loaded

function workoutPane(ctx, { selected, pinned = null }) {
  if (!pane || !ctx.sidePane.contains(pane.el)) {
    pane = makePane(ctx);
    ctx.sidePane.replaceChildren(pane.el);
  }
  pane.update(ctx, selected, pinned);
  return pane;
}

function makePane(ctx) {
  const el = h('div', { class: 'workout-pane' });
  const summary = h('section', { class: 'workout-month', 'aria-label': 'The month' });
  let calendar = null;
  let month = null;
  let selected = null;
  let pinned = null;
  let pointed = null;   // the exercise pointed at

  const name = (id) => paneData.names[id] || '';

  // Lights up the days of exercise `id` (or else the pinned one's).
  function light(id = null) {
    pointed = id;
    if (!calendar) return;   // drawn with it once the days are in
    const shown = id ?? pinned;
    const label = shown != null && name(shown);
    calendar.highlight(label ? Object.keys(paneData.days).filter((d) => paneData.days[d].exercises.includes(shown)) : null, label);
  }

  function drawSummary() {
    const days = Object.keys(paneData.days).filter((d) => monthOf(d) === month).map((d) => paneData.days[d]);
    summary.hidden = !days.length;
    if (!days.length) return;
    const rated = days.map((d) => d.tiredness).filter(Boolean);
    const average = rated.length ? rated.reduce((a, b) => a + b, 0) / rated.length : null;
    const counts = new Map();
    for (const d of days) for (const id of d.exercises) counts.set(id, (counts.get(id) || 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1] || name(a[0]).localeCompare(name(b[0]))).slice(0, TOP_MAX);
    summary.replaceChildren(
      h('p', { class: 'wm-line' }, h('span', { class: 'wm-label' }, 'Average tiredness'),
        average == null ? h('span', { class: 'muted' }, 'Not rated') : `${num(Number(average.toFixed(1)))} · ${TIREDNESS[Math.round(average) - 1]}`),
      top.length > 0 && h('div', { class: 'wm-top' },
        h('span', { class: 'wm-label' }, 'Done most'),
        top.map(([id, n]) => h('button', {
          type: 'button', class: 'wm-row',
          onPointerenter: (e) => e.pointerType === 'mouse' && light(id),
          onPointerleave: () => light(),
          onFocus: () => light(id),
          onBlur: () => light(),
          onClick: () => ctx.go(exercisePage(id, selected)),
        }, h('span', { class: 'wm-name' }, name(id)), h('span', { class: 'wm-count' }, plural(n, 'day'))))));
  }

  function draw() {
    if (!paneData) return;
    const days = Object.fromEntries(Object.keys(paneData.days).map((d) => [d, { workout: true }]));
    if (calendar) {
      calendar.setDays(days);
    } else {
      month = monthOf(selected);
      calendar = monthCalendar({
        month, days, selected, workoutOnly: true, compact: true,
        onPick: (date) => ctx.go(workoutDay(date)),
        onMonth: (m) => {
          month = m;
          drawSummary();
        },
      });
      el.replaceChildren(calendar.el, summary);
    }
    light(pointed);
    drawSummary();
  }

  // Draws again once the days are loaded (after anything that changes them).
  function refresh() {
    ctx.api.workoutDays().then((data) => {
      paneData = data;
      draw();
    }).catch(() => {});
  }

  return {
    el,
    light,
    refresh,
    update(c, date, exerciseId) {
      ctx = c;
      pinned = exerciseId;
      pointed = null;
      if (!calendar) {
        selected = date;
        draw();   // at once, with the days last loaded, if any
      } else {
        if (date !== selected) {
          selected = date;
          calendar.select(date);
        }
        light();
      }
      refresh();
    },
  };
}

// ---- a new exercise --------------------------------------------------------------

// Asks for a new exercise's name, kind and variants; resolves with it, or null.
export async function newExercise(ctx) {
  const name = h('input', { type: 'text', class: 'input', required: true, maxlength: NAME_MAX, placeholder: 'e.g. Front lever', autocomplete: 'off' });
  const kind = h('select', { class: 'input' }, Object.entries(KINDS).map(([k, v]) => h('option', { value: k }, v.label)));
  const variants = h('input', { type: 'text', class: 'input', placeholder: 'e.g. Barbell, Dumbbell', autocomplete: 'off' });
  const result = await dialog({
    title: 'New exercise',
    body: h('div', {}, field('Name', name), field('Measured as', kind),
      field('Variants (optional)', variants, 'Ways of doing it, kept under the one exercise. Separate them with commas.')),
    actions: [{ value: 'cancel', label: 'Cancel' }, { value: 'ok', label: 'Add', class: 'btn-primary' }],
  });
  if (result !== 'ok') return null;
  try {
    const exercise = await ctx.api.createExercise({
      name: name.value, kind: kind.value, variants: variants.value.split(',').map((v) => v.trim()).filter(Boolean),
    });
    ctx.toast(`Added ${exercise.name}.`, 'success');
    return exercise;
  } catch (err) {
    ctx.toast(err.message, 'error');
    return null;
  }
}

// ---- what can be added: an exercise and variant ------------------------------------

const RECENT_DAYS = 14;
const RECENT_MAX = 6;

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Doing an exercise without a variant, when it also has some (done that way
// before they were added) is "Standard".
const variantLabel = (exercise, name) => name || (exercise.variants.length ? 'Standard' : null);

// An exercise's choices: its variants, and doing it without one when it has
// none or was done that way (v null). Keyed "exerciseId:variantId".
const choices = (e) => (e.variants.length ? [...(e.plain_last_date ? [null] : []), ...e.variants] : [null]);
const choiceKey = (e, v) => `${e.id}:${v ? v.id : ''}`;
const lastDate = (e, v) => (v ? v.last_date : e.plain_last_date);
const choiceLabel = (e, v) => variantLabel(e, v?.name);
const choiceName = (e, v) => (choiceLabel(e, v) ? `${e.name} · ${choiceLabel(e, v)}` : e.name);

// ---- a day's workout --------------------------------------------------------------

export async function render(root, ctx, { date = null } = {}) {
  date = date || today();
  const pane = workoutPane(ctx, { selected: date });
  const workout = await ctx.api.workout(date);
  if (ctx.stale()) return;
  let current = workout;

  const tabs = subTabs('workout', date, workout.blocks.length);
  const blocks = h('div', { class: 'workout-blocks' });

  async function removeBlock(block) {
    if (filledSets(block.sets).length && !(await confirmDialog(`Remove ${blockName(block)}?`, 'Its sets from this workout go too.', 'Remove'))) return;
    try {
      current = await ctx.api.removeWorkoutExercise(block.id);
      redraw();
      pane.refresh();
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  // What was done last time and the best of the last 30 days, to beat, with
  // the line of each earlier day's best.
  function referenceLine(block) {
    const { last, max30, metric, points } = block.reference;
    if (!last && !max30) return h('p', { class: 'block-ref muted small' }, 'First time — no history yet.');
    return h('div', { class: 'block-ref' },
      h('div', { class: 'block-ref-text' },
        last && h('p', {}, h('span', { class: 'block-ref-label' }, `Last time · ${fmtDate(last.date)}`),
          last.sets.map((s) => formatSet(block.kind, s)).join(', ')),
        h('p', {}, h('span', { class: 'block-ref-label' }, '30-day best'),
          max30 ? [formatMetric(metric, block.kind, max30.value), h('span', { class: 'muted' }, ` · ${fmtDate(max30.date)}`)]
            : h('span', { class: 'muted' }, 'nothing in the last 30 days'))),
      points.length > 1 && sparkline({ points, format: (v) => formatMetric(metric, block.kind, v) }));
  }

  function setRow(block, s, i) {
    const inputs = COLUMNS[block.kind].map(([key, label, placeholder, mode]) => h('input', {
      type: 'number', step: 'any', class: 'input set-input', value: s[key] ?? '', inputmode: mode,
      min: key === 'weight' && block.kind !== 'weight' ? null : 0,
      'aria-label': `Set ${i + 1} ${label}`, placeholder,
      onChange: async (e) => {
        const raw = e.target.value.trim();
        try {
          const saved = await ctx.api.updateSet(s.id, { [key]: raw === '' ? null : Number(raw) });
          Object.assign(s, saved);
        } catch (err) {
          ctx.toast(err.message, 'error');
          e.target.value = s[key] ?? '';
        }
      },
    }));
    return h('div', { class: 'set-row' },
      h('span', { class: 'set-num' }, i + 1),
      inputs,
      h('button', {
        type: 'button', class: 'icon-btn danger', title: 'Delete set', 'aria-label': `Delete set ${i + 1}`,
        onClick: async () => {
          try {
            await ctx.api.deleteSet(s.id);
            block.sets.splice(i, 1);
            redraw();
          } catch (err) {
            ctx.toast(err.message, 'error');
          }
        },
      }, icon('x', { size: 15 })));
  }

  function blockCard(block) {
    const cols = COLUMNS[block.kind];
    const rows = h('div', { class: 'set-rows', style: `--cols:${cols.length}` },
      h('div', { class: 'set-row set-head', 'aria-hidden': 'true' }, h('span', {}, 'Set'), cols.map(([, label]) => h('span', {}, label)), h('span', {})),
      block.sets.map((s, i) => setRow(block, s, i)));
    // A new set starts as a copy of the one before.
    const addSet = async () => {
      const prev = block.sets[block.sets.length - 1];
      const copy = prev ? Object.fromEntries(cols.map(([key]) => [key, prev[key]])) : {};
      try {
        block.sets.push(await ctx.api.addSet(block.id, copy));
        redraw();
        blocks.querySelector(`[data-block="${block.id}"] .set-row:last-child input`)?.focus();
      } catch (err) {
        ctx.toast(err.message, 'error');
      }
    };
    return h('section', { class: 'card workout-block', dataset: { block: block.id } },
      h('div', { class: 'block-head' },
        h('button', { type: 'button', class: 'link block-name', title: 'Progress', onClick: () => ctx.go(exercisePage(block.exercise_id, date)) }, blockName(block)),
        h('button', { type: 'button', class: 'icon-btn danger', title: 'Remove from this workout', 'aria-label': `Remove ${blockName(block)}`, onClick: () => removeBlock(block) },
          icon('trash', { size: 15 }))),
      referenceLine(block),
      rows,
      h('button', { type: 'button', class: 'btn btn-small', onClick: addSet }, icon('plus', { size: 14 }), 'Set'));
  }

  // How tired the session felt, 1 to 5; the chosen one again clears it.
  const tiredness = h('div', { class: 'chip-row wrap tiredness', role: 'group', 'aria-label': 'How tired' });
  const notes = h('textarea', {
    class: 'input', rows: 2, placeholder: 'How did it go?', value: workout.notes,
    onChange: () => save({ notes: notes.value }),
  });
  async function save(data) {
    try {
      current = { ...(await ctx.api.updateWorkout(date, data)), blocks: current.blocks };
      redraw();
      pane.refresh();
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  async function deleteWorkout() {
    const ok = await confirmDialog(`Delete the workout on ${fmtDate(date)}?`, 'Its exercises, sets and notes go.');
    if (!ok) return;
    try {
      await ctx.api.deleteWorkout(date);
      ctx.toast('Workout deleted.');
      ctx.go(workoutDay(date));
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }
  const deleteButton = h('button', { type: 'button', class: 'btn btn-ghost-danger btn-small', onClick: deleteWorkout }, 'Delete workout');

  function redraw() {
    tiredness.replaceChildren(...TIREDNESS.map((label, i) => h('button', {
      type: 'button', class: `chip${current.tiredness === i + 1 ? ' on' : ''}`, 'aria-pressed': String(current.tiredness === i + 1),
      onClick: () => save({ tiredness: current.tiredness === i + 1 ? null : i + 1 }),
    }, `${i + 1} ${label}`)));
    blocks.replaceChildren(...(current.blocks.length
      ? current.blocks.map(blockCard)
      : [h('p', { class: 'muted' }, date === today() ? 'Nothing logged yet today. Add your first exercise.' : 'No workout logged this day.')]));
    tabs.setCount(current.blocks.length);
    deleteButton.hidden = current.id == null;
  }

  redraw();
  root.replaceChildren(
    tabs.el,
    h('div', { class: 'panel-head' },
      h('h1', {}, dayTitle(date)),
      date !== today() && h('button', { type: 'button', class: 'btn btn-small', onClick: () => ctx.go('#/workout') }, 'Today')),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'How tired did you feel?'), tiredness),
    blocks,
    h('button', { type: 'button', class: 'btn btn-primary add-exercise', onClick: () => ctx.go(exercisesFor(date)) },
      icon('plus', { size: 15 }), 'Add exercise'),
    field('Notes (optional)', notes),
    h('div', { class: 'actions' }, deleteButton));
}

// ---- the exercise list: what to add to the day's workout -----------------------------

// Every exercise, A to Z, its variants as a bar of buttons, each adding it to
// the day's workout and saying when you last did it; one already in it reads
// "Added". On top, one tap for what you've done in the last two weeks. The
// name opens its progress; pointing at it lights up its days on the calendar.
export async function renderExercises(root, ctx, { date = null } = {}) {
  date = date || today();
  const pane = workoutPane(ctx, { selected: date });
  let [workout, exercises] = await Promise.all([ctx.api.workout(date), ctx.api.exercises()]);
  if (ctx.stale()) return;

  const tabs = subTabs('exercises', date, workout.blocks.length);
  const target = date === today() ? 'today’s workout' : `the workout on ${dayTitle(date)}`;
  const recentRow = h('div', { class: 'xp-recent' });
  const list = h('div', { class: 'xp-list' });
  const search = h('input', {
    type: 'search', class: 'input', placeholder: 'Search exercises', autocomplete: 'off', 'aria-label': 'Search exercises',
    onInput: () => draw(),
  });

  async function add(e, v) {
    try {
      workout = await ctx.api.addWorkoutExercise(date, { exercise_id: e.id, variant_id: v ? v.id : null });
      // It was done on this day now, too.
      const later = (d) => (d && d > date ? d : date);
      e.last_date = later(e.last_date);
      if (v) v.last_date = later(v.last_date);
      else e.plain_last_date = later(e.plain_last_date);
      ctx.toast(`Added ${choiceName(e, v)} to ${target}.`, 'success');
      pane.refresh();
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
    if (ctx.stale()) return;
    tabs.setCount(workout.blocks.length);
    draw();
  }

  // A variant the list doesn't have yet: named, added to the exercise, and
  // put in the workout straight away.
  async function newVariant(e) {
    const name = await promptDialog(`New variant of ${e.name}`, 'Name', 'e.g. Incline', { maxLength: NAME_MAX });
    if (!name) return;
    try {
      Object.assign(e, await ctx.api.addVariant(e.id, name));
    } catch (err) {
      ctx.toast(err.message, 'error');
      return;
    }
    await add(e, e.variants.reduce((a, b) => (b.id > a.id ? b : a)));   // the newest
  }

  async function createExercise() {
    const created = await newExercise(ctx);
    if (!created || ctx.stale()) return;
    exercises = [...exercises, created].sort((a, b) => a.name.localeCompare(b.name));
    search.value = '';
    draw();
    pane.refresh();   // its name
  }

  // Each tap disables its button until the list is drawn again, so a second
  // tap can't add it twice.
  const adder = (e, v) => (ev) => {
    ev.currentTarget.disabled = true;
    add(e, v);
  };

  // A variant's segment of the bar (or the one "Add" of an exercise without variants).
  function segment(e, v, done) {
    const added = done.has(choiceKey(e, v));
    const last = lastDate(e, v);
    return h('button', {
      type: 'button', disabled: added, class: added ? 'xp-added' : null,
      'aria-label': added ? `${choiceName(e, v)}, in ${target}` : `Add ${choiceName(e, v)} to ${target}`,
      onClick: adder(e, v),
    },
    h('span', { class: 'xp-seg-label' }, icon(added ? 'check' : 'plus', { size: 15 }), added ? 'Added' : choiceLabel(e, v) || 'Add'),
    added ? choiceLabel(e, v) && h('span', { class: 'xp-date' }, choiceLabel(e, v)) : last && h('span', { class: 'xp-date' }, shortDate(last)));
  }

  const exerciseBlock = (e, done) => h('div', {
    class: 'xp-ex',
    onPointerenter: (ev) => ev.pointerType === 'mouse' && pane.light(e.id),
    onPointerleave: () => pane.light(),
    onFocusin: () => pane.light(e.id),
    onFocusout: () => pane.light(),
  },
  h('div', { class: 'xp-ex-head' },
    h('a', { class: 'xp-name', href: exercisePage(e.id, date), title: 'Progress' }, e.name, icon('chevron-right', { size: 15 })),
    h('span', { class: 'xp-last' }, e.last_date ? `Last ${shortDate(e.last_date)}` : 'Not done yet')),
  h('div', { class: 'xp-seg', role: 'group', 'aria-label': e.name },
    choices(e).map((v) => segment(e, v, done)),
    h('button', {
      type: 'button', class: 'xp-seg-new', title: `Add a variant to ${e.name}`, 'aria-label': `Add a variant to ${e.name}`,
      onClick: () => newVariant(e),
    }, icon('plus', { size: 14 }), h('span', { class: 'xp-seg-new-label' }, 'Variant'))));

  function draw() {
    const done = new Set(workout.blocks.map((b) => `${b.exercise_id}:${b.variant_id ?? ''}`));
    const q = search.value.trim().toLowerCase();

    const since = daysAgo(RECENT_DAYS);
    const recent = exercises.flatMap((e) => choices(e).map((v) => ({ e, v, date: lastDate(e, v) })))
      .filter((c) => c.date && c.date >= since && !done.has(choiceKey(c.e, c.v)))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, RECENT_MAX);
    recentRow.hidden = !!q || !recent.length;
    recentRow.replaceChildren(
      h('span', { class: 'xp-label' }, 'Recent'),
      h('div', { class: 'xp-recent-row' }, recent.map(({ e, v }) => h('button', {
        type: 'button', class: 'xp-recent-btn', 'aria-label': `Add ${choiceName(e, v)} to ${target}`, onClick: adder(e, v),
      }, icon('plus', { size: 15 }), e.name, choiceLabel(e, v) && h('span', {}, choiceLabel(e, v))))));

    const shown = exercises.filter((e) => !q || e.name.toLowerCase().includes(q) || e.variants.some((v) => v.name.toLowerCase().includes(q)));
    if (!shown.length) {
      list.replaceChildren(h('div', { class: 'empty' }, exercises.length ? 'No exercises match.' : 'No exercises yet.'));
      return;
    }
    list.replaceChildren(h('div', { class: 'xp-grid' }, shown.map((e) => exerciseBlock(e, done))));
  }

  draw();
  root.replaceChildren(
    tabs.el,
    h('div', { class: 'panel-head' }, h('h1', {}, 'Exercises'),
      h('button', { type: 'button', class: 'btn btn-small', onClick: createExercise }, icon('plus', { size: 14 }), 'New exercise')),
    h('p', { class: 'xp-target' }, 'Adding to ', h('a', { href: workoutDay(date) }, target)),
    recentRow,
    search,
    list);
}

// ---- an exercise and its progress -------------------------------------------------

const METRIC_TITLE = { weight: 'Heaviest set', reps: 'Most reps in a set', seconds: 'Longest hold' };

export async function renderExercise(root, ctx, { exerciseId, date = null }) {
  date = date || today();
  const pane = workoutPane(ctx, { selected: date, pinned: exerciseId });
  const [{ exercise, series, history }, workout] = await Promise.all([ctx.api.progress(exerciseId), ctx.api.workout(date)]);
  if (ctx.stale()) return;
  const used = exercise.times > 0;
  const here = exercisePage(exercise.id, date);
  const run = async (action, message) => {
    try {
      await action();
      if (message) ctx.toast(message, 'success');
      ctx.go(here);
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  };

  async function edit() {
    const name = h('input', { type: 'text', class: 'input', required: true, maxlength: NAME_MAX, value: exercise.name });
    const kind = h('select', { class: 'input', disabled: used },
      Object.entries(KINDS).map(([k, v]) => h('option', { value: k, selected: k === exercise.kind }, v.label)));
    const notes = h('textarea', { class: 'input', rows: 3, value: exercise.notes, placeholder: 'Form cues, settings, …' });
    const result = await dialog({
      title: `Edit ${exercise.name}`,
      body: h('div', {}, field('Name', name),
        field('Measured as', kind, used ? 'It’s been done in workouts, so this stays.' : null), field('Notes', notes)),
      actions: [{ value: 'cancel', label: 'Cancel' }, { value: 'ok', label: 'Save', class: 'btn-primary' }],
    });
    if (result !== 'ok') return;
    await run(() => ctx.api.updateExercise(exercise.id, { name: name.value, kind: kind.value, notes: notes.value }), 'Exercise updated.');
  }

  async function remove() {
    if (!(await confirmDialog(`Delete ${exercise.name}?`, 'It hasn’t been done in any workout, so nothing else changes.'))) return;
    try {
      await ctx.api.deleteExercise(exercise.id);
      ctx.toast('Exercise deleted.');
      ctx.go(exercisesFor(date));
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  async function addVariant() {
    const name = await promptDialog(`New variant of ${exercise.name}`, 'Name', 'e.g. Dumbbell', { maxLength: NAME_MAX });
    if (name) await run(() => ctx.api.addVariant(exercise.id, name), `Added ${name}.`);
  }

  async function renameVariant(v) {
    const name = await promptDialog(`Rename ${v.name}`, 'Name', '', { value: v.name, confirmLabel: 'Rename', maxLength: NAME_MAX });
    if (name && name !== v.name) await run(() => ctx.api.renameVariant(v.id, name));
  }

  async function deleteVariant(v) {
    if (await confirmDialog(`Delete the ${v.name} variant?`, 'It hasn’t been done in any workout.')) await run(() => ctx.api.deleteVariant(v.id));
  }

  const variantChips = h('div', { class: 'chip-row wrap' },
    exercise.variants.map((v) => h('span', { class: 'chip removable variant-chip' },
      h('button', { type: 'button', class: 'variant-name', title: 'Rename', onClick: () => renameVariant(v) }, v.name),
      v.times === 0 && h('button', { type: 'button', class: 'chip-x', title: 'Delete', 'aria-label': `Delete ${v.name}`, onClick: () => deleteVariant(v) }, icon('x', { size: 12 })))),
    h('button', { type: 'button', class: 'chip', onClick: addVariant }, icon('plus', { size: 13 }), 'Variant'));

  // One chart per variant done: small multiples, each in its own measure.
  const charts = series.map((s) => {
    const chart = progressChart({
      points: s.points,
      label: variantLabel(exercise, s.variant_name) || exercise.name,
      format: (v) => formatMetric(s.metric, exercise.kind, v),
      detail: (p) => (p.edge_mm != null ? `${num(p.edge_mm)} mm edge` : ''),
    });
    return { chart, card: h('section', { class: 'card chart-card' },
      h('div', { class: 'chart-head' }, h('h3', { class: 'card-title' }, variantLabel(exercise, s.variant_name) || exercise.name),
        h('span', { class: 'muted small' }, `${METRIC_TITLE[s.metric]}${s.metric === 'weight' ? ', lb' : ''} · each day’s best`)),
      chart.el) };
  });

  root.replaceChildren(
    subTabs('exercises', date, workout.blocks.length).el,
    h('button', { type: 'button', class: 'back-link', onClick: () => ctx.go(exercisesFor(date)) }, icon('arrow-left', { size: 15 }), 'Exercises'),
    h('div', { class: 'route-kicker' }, KINDS[exercise.kind].label),
    h('h1', { class: 'route-heading' }, exercise.name),
    exercise.notes && h('p', { class: 'notes' }, exercise.notes),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Variants'), variantChips),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn', onClick: edit }, 'Edit'),
      !used && h('button', { type: 'button', class: 'btn btn-ghost-danger', onClick: remove }, 'Delete')),
    h('h2', { class: 'section-title' }, 'Progress'),
    charts.length
      ? h('div', { class: 'chart-list' }, charts.map((c) => c.card))
      : h('p', { class: 'muted' }, 'Its progress shows here once it’s been done in a workout.'),
    history.length > 0 && h('section', { class: 'my-history' },
      h('h2', {}, `History (${history.length})`),
      h('ol', {}, history.map((b) => h('li', {},
        h('div', { class: 'my-history-head' },
          h('button', { type: 'button', class: 'link', onClick: () => ctx.go(workoutDay(b.workout_date)) }, fmtDate(b.workout_date)),
          variantLabel(exercise, b.variant_name) && h('span', { class: 'muted' }, variantLabel(exercise, b.variant_name))),
        h('p', { class: 'my-history-note' }, filledSets(b.sets).map((s) => formatSet(exercise.kind, s)).join(', ') || 'No sets filled in'))))));

  return {
    destroy() {
      charts.forEach((c) => c.chart.destroy());
    },
  };
}
