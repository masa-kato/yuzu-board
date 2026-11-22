// The admin's Workout tab (workouts.py): a day's workout (#/workout, or
// ?date=), the exercise list (#/workout/exercises) and an exercise's progress
// (#/exercise/<id>). The calendar in the side pane picks the day.

import { sideCalendar } from '../calendar.js';
import { progressChart } from '../chart.js';
import { confirmDialog, dialog, field, fmtDate, h, icon, promptDialog, today } from '../ui.js';

export const KINDS = {
  weight: { label: 'Weight × reps', group: 'Weights' },
  bodyweight: { label: 'Bodyweight reps', group: 'Bodyweight' },
  timed: { label: 'Timed hold', group: 'Timed holds' },
  hang: { label: 'Hang (time, weight, edge)', group: 'Hangs' },
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

function subTabs(current) {
  const tab = (key, label, hash) => h('a', { href: hash, 'aria-current': key === current ? 'page' : null }, label);
  return h('nav', { class: 'segmented-nav', 'aria-label': 'Workout' },
    tab('workout', 'Workout', '#/workout'), tab('exercises', 'Exercises', '#/workout/exercises'));
}

const workoutDay = (date) => `#/workout?date=${date}`;

function calendar(ctx, selected) {
  sideCalendar(ctx, { climberId: ctx.state.adminId, selected, link: workoutDay });
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

const RECENT_DAYS = 14;
const RECENT_MAX = 6;

// "Nov 12", with the year when it isn't this one.
function shortDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Doing an exercise without a variant, when it also has some (done that way
// before they were added) is "Standard".
const variantLabel = (exercise, name) => name || (exercise.variants.length ? 'Standard' : null);

// Picks an exercise and variant to add. On top, one tap for what you've done
// in the last two weeks; below, every exercise by kind, its variants as a bar
// of buttons, each saying when you last did it. Ones already in the workout
// (`done`, of "exerciseId:variantId") read "Added". "+ Variant" adds a variant
// to an exercise and picks it. Resolves with {exercise_id, variant_id}, 'new',
// or null.
async function pickExercise(ctx, exercises, done) {
  const key = (e, v) => `${e.id}:${v ? v.id : ''}`;
  // Its variants, and doing it without one when it has none or was done that way.
  const choices = (e) => (e.variants.length ? [...(e.plain_last_date ? [null] : []), ...e.variants] : [null]);
  const lastDate = (e, v) => (v ? v.last_date : e.plain_last_date);
  const label = (e, v) => variantLabel(e, v?.name);
  const fullName = (e, v) => (label(e, v) ? `${e.name} · ${label(e, v)}` : e.name);

  const since = daysAgo(RECENT_DAYS);
  const recent = exercises.flatMap((e) => choices(e).map((v) => ({ e, v, date: lastDate(e, v) })))
    .filter((c) => c.date && c.date >= since && !done.has(key(c.e, c.v)))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, RECENT_MAX);
  const recentRow = recent.length > 0 && h('div', { class: 'xp-recent' },
    h('span', { class: 'xp-label' }, 'Recent'),
    h('div', { class: 'xp-recent-row' }, recent.map(({ e, v }) => h('button', {
      type: 'submit', class: 'xp-recent-btn', value: key(e, v), 'aria-label': `Add ${fullName(e, v)}`,
    }, icon('plus', { size: 15 }), e.name, label(e, v) && h('span', {}, label(e, v))))));

  // A variant's segment of the bar (or the one "Add" of an exercise without variants).
  const segment = (e, v) => {
    const added = done.has(key(e, v));
    const date = lastDate(e, v);
    return h('button', {
      type: 'submit', value: key(e, v), disabled: added, class: added ? 'xp-added' : null,
      'aria-label': added ? `${fullName(e, v)}, already added` : `Add ${fullName(e, v)}`,
    },
    h('span', { class: 'xp-seg-label' }, icon(added ? 'check' : 'plus', { size: 15 }), added ? 'Added' : label(e, v) || 'Add'),
    added ? label(e, v) && h('span', { class: 'xp-date' }, label(e, v)) : date && h('span', { class: 'xp-date' }, shortDate(date)));
  };
  // A variant the list doesn't have yet: named, added to the exercise, and
  // picked straight away, which closes the popup with it.
  const newVariant = async (e, button) => {
    const name = await promptDialog(`New variant of ${e.name}`, 'Name', 'e.g. Incline', { maxLength: NAME_MAX });
    if (!name) return;
    try {
      const updated = await ctx.api.addVariant(e.id, name);
      Object.assign(e, updated);
      const variant = updated.variants.reduce((a, b) => (b.id > a.id ? b : a));
      ctx.toast(`Added ${variant.name} to ${e.name}.`, 'success');
      button.closest('dialog').close(key(e, variant));
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  };
  const rows = exercises.map((e) => ({
    e,
    el: h('div', { class: 'xp-ex' },
      h('div', { class: 'xp-ex-head' },
        h('span', { class: 'xp-name' }, e.name),
        h('span', { class: 'xp-date' }, e.last_date ? `Last ${shortDate(e.last_date)}` : 'Not done yet'),
        h('button', {
          type: 'button', class: 'xp-add-variant', title: `Add a variant to ${e.name}`, 'aria-label': `Add a variant to ${e.name}`,
          onClick: (ev) => newVariant(e, ev.currentTarget),
        }, icon('plus', { size: 13 }), 'Variant')),
      h('div', { class: 'xp-seg', role: 'group', 'aria-label': e.name }, choices(e).map((v) => segment(e, v)))),
  }));
  const groups = Object.entries(KINDS)
    .map(([kind, { group }]) => ({ head: h('div', { class: 'xp-group' }, group), members: rows.filter((r) => r.e.kind === kind) }))
    .filter((g) => g.members.length);
  const none = h('p', { class: 'muted', hidden: true }, 'No exercises match. Add it as a new one below.');
  const list = h('div', { class: 'xp-list' }, groups.map((g) => [g.head, g.members.map((r) => r.el)]), none);

  const search = h('input', {
    type: 'search', class: 'input', placeholder: 'Search exercises', autocomplete: 'off', 'aria-label': 'Search exercises',
    // Enter would submit the dialog with the first exercise in it.
    onKeydown: (e) => {
      if (e.key === 'Enter') e.preventDefault();
    },
    onInput: () => {
      const q = search.value.trim().toLowerCase();
      for (const r of rows) r.el.hidden = !!q && !r.e.name.toLowerCase().includes(q) && !r.e.variants.some((v) => v.name.toLowerCase().includes(q));
      for (const g of groups) g.head.hidden = g.members.every((r) => r.el.hidden);
      if (recentRow) recentRow.hidden = !!q;
      none.hidden = rows.some((r) => !r.el.hidden);
      list.scrollTop = 0;
    },
  });
  const result = await dialog({
    title: 'Add an exercise',
    className: 'xp-dialog',
    body: h('div', { class: 'xp' }, recentRow, search, list,
      h('button', { type: 'submit', class: 'xp-new', value: 'new' }, icon('plus', { size: 15 }), 'New exercise…')),
    actions: [{ value: 'cancel', label: 'Cancel' }],
  });
  if (!result || result === 'new') return result;
  const [exerciseId, variantId] = result.split(':');
  return { exercise_id: Number(exerciseId), variant_id: variantId ? Number(variantId) : null };
}

// ---- a day's workout --------------------------------------------------------------

export async function render(root, ctx, { date = null } = {}) {
  date = date || today();
  const [workout, exercises] = await Promise.all([ctx.api.workout(date), ctx.api.exercises()]);
  if (ctx.stale()) return;
  calendar(ctx, date);
  let current = workout;

  const blocks = h('div', { class: 'workout-blocks' });

  async function addExercise() {
    for (;;) {
      const done = new Set(current.blocks.map((b) => `${b.exercise_id}:${b.variant_id ?? ''}`));
      const choice = await pickExercise(ctx, exercises, done);
      if (!choice) return;
      if (choice === 'new') {
        const created = await newExercise(ctx);
        if (created) exercises.push(created);
        exercises.sort((a, b) => a.name.localeCompare(b.name));
        continue;   // back to the list, with it in
      }
      try {
        current = await ctx.api.addWorkoutExercise(date, choice);
        redraw();
        // Straight into its first set.
        blocks.lastElementChild?.querySelector('input')?.focus();
      } catch (err) {
        ctx.toast(err.message, 'error');
      }
      return;
    }
  }

  async function removeBlock(block) {
    if (filledSets(block.sets).length && !(await confirmDialog(`Remove ${blockName(block)}?`, 'Its sets from this workout go too.', 'Remove'))) return;
    try {
      current = await ctx.api.removeWorkoutExercise(block.id);
      redraw();
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  // What was done last time and the best of the last 30 days, to beat.
  function referenceLine(block) {
    const { last, max30, metric } = block.reference;
    if (!last && !max30) return h('p', { class: 'block-ref muted small' }, 'First time — no history yet.');
    return h('div', { class: 'block-ref' },
      last && h('p', {}, h('span', { class: 'block-ref-label' }, `Last time · ${fmtDate(last.date)}`),
        last.sets.map((s) => formatSet(block.kind, s)).join(', ')),
      h('p', {}, h('span', { class: 'block-ref-label' }, '30-day best'),
        max30 ? [formatMetric(metric, block.kind, max30.value), h('span', { class: 'muted' }, ` · ${fmtDate(max30.date)}`)]
          : h('span', { class: 'muted' }, 'nothing in the last 30 days')));
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
        h('button', { type: 'button', class: 'link block-name', title: 'Progress', onClick: () => ctx.go(`#/exercise/${block.exercise_id}`) }, blockName(block)),
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
    deleteButton.hidden = current.id == null;
    // The calendar marks the day once there's a workout (and unmarks it once there isn't).
    if ((current.id == null) !== (workout.id == null)) {
      workout.id = current.id;
      calendar(ctx, date);
    }
  }

  redraw();
  root.replaceChildren(
    subTabs('workout'),
    h('div', { class: 'panel-head' },
      h('h1', {}, dayTitle(date)),
      date !== today() && h('button', { type: 'button', class: 'btn btn-small', onClick: () => ctx.go('#/workout') }, 'Today')),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'How tired did you feel?'), tiredness),
    blocks,
    h('button', { type: 'button', class: 'btn btn-primary add-exercise', onClick: addExercise }, icon('plus', { size: 15 }), 'Add exercise'),
    field('Notes (optional)', notes),
    h('div', { class: 'actions' }, deleteButton));
}

// ---- the exercise list ------------------------------------------------------------

export async function renderExercises(root, ctx) {
  const exercises = await ctx.api.exercises();
  if (ctx.stale()) return;
  calendar(ctx, null);
  const list = h('div', { class: 'exercise-list' });
  const search = h('input', { type: 'search', class: 'input', placeholder: 'Search exercises', autocomplete: 'off', onInput: () => draw() });

  function draw() {
    const q = search.value.trim().toLowerCase();
    const shown = exercises.filter((e) => !q || e.name.toLowerCase().includes(q) || e.variants.some((v) => v.name.toLowerCase().includes(q)));
    if (!shown.length) {
      list.replaceChildren(h('div', { class: 'empty' }, exercises.length ? 'No exercises match.' : 'No exercises yet.'));
      return;
    }
    list.replaceChildren(...Object.entries(KINDS).flatMap(([kind, { group }]) => {
      const inKind = shown.filter((e) => e.kind === kind);
      return inKind.length ? [
        h('h3', { class: 'usage-head' }, group),
        ...inKind.map((e) => h('button', { type: 'button', class: 'lookup-row', onClick: () => ctx.go(`#/exercise/${e.id}`) },
          h('span', { class: 'exercise-row-text' },
            h('span', { class: 'lookup-name' }, e.name),
            e.variants.length > 0 && h('span', { class: 'muted small' }, e.variants.map((v) => v.name).join(' · '))),
          h('span', { class: 'muted small lookup-meta' }, e.last_date ? fmtDate(e.last_date) : 'Not done yet'),
          icon('chevron-right', { size: 16 }))),
      ] : [];
    }));
  }

  draw();
  root.replaceChildren(
    subTabs('exercises'),
    h('div', { class: 'panel-head' }, h('h1', {}, 'Exercises'),
      h('button', {
        type: 'button', class: 'btn btn-small',
        onClick: async () => {
          const created = await newExercise(ctx);
          if (created) ctx.go(`#/exercise/${created.id}`);
        },
      }, icon('plus', { size: 14 }), 'New exercise')),
    search,
    list);
}

// ---- an exercise and its progress -------------------------------------------------

const METRIC_TITLE = { weight: 'Heaviest set', reps: 'Most reps in a set', seconds: 'Longest hold' };

export async function renderExercise(root, ctx, { exerciseId }) {
  const { exercise, series, history } = await ctx.api.progress(exerciseId);
  if (ctx.stale()) return;
  calendar(ctx, history[0]?.workout_date || null);
  const used = exercise.times > 0;
  const here = `#/exercise/${exercise.id}`;
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
      ctx.go('#/workout/exercises');
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
    subTabs('exercises'),
    h('button', { type: 'button', class: 'back-link', onClick: () => ctx.go('#/workout/exercises') }, icon('arrow-left', { size: 15 }), 'Exercises'),
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
