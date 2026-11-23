import { randomName } from '../names.js';
import {
  GRADES, ROLES, ROLE_LABELS, climberOptions, confirmDialog, field, fmtDate, gradePips, gradeV, h, icon, roleDot, today,
} from '../ui.js';

const PALETTE = [...ROLES, 'erase'];
const FADE_KEY = 'homewall.fadeOthers';

// Whether holds not on the problem fade while setting it (remembered in this
// browser; on unless switched off).
function readFade() {
  try {
    return localStorage.getItem(FADE_KEY) !== 'off';
  } catch {
    return true;
  }
}

// `draftId` picks up a saved draft (of a new boulder or variation), which
// Save route then publishes.
export async function render(root, ctx, { routeId, parentId, draftId }) {
  const { state, board } = ctx;
  const editing = routeId > 0;
  const route = editing ? await ctx.api.route(routeId, state.me) : null;
  const draft = !editing && draftId ? await ctx.api.draft(draftId) : null;
  if (draft) parentId = draft.parent_id;
  const parent = !editing && parentId ? await ctx.api.route(parentId, state.me) : null;
  if (ctx.stale()) return;

  const base = (route || parent)?.family[0];
  const isVariation = editing ? route.parent_id != null : !!parent;
  const takenNames = (route || parent)?.family.map((r) => r.name) || [];
  const source = route || draft || parent;
  const isRemoved = (holdId) => !!state.holdById.get(holdId)?.removed;
  // A new climb can't start out on holds that are no longer on the wall.
  const inherited = (source?.holds || []).filter((x) => !(!editing && isRemoved(x.hold_id)));
  const dropped = (source?.holds.length || 0) - inherited.length;
  const holds = new Map(inherited.map((x) => [x.hold_id, x.role]));
  let activeRole = holds.size ? 'hand' : 'start';
  let fadeOthers = readFade();
  let grade = source?.grade || 'medium';

  // ---- hold palette ------------------------------------------------------
  const palette = h('div', { class: 'palette', role: 'group', 'aria-label': 'Hold type to paint' });
  const warning = h('p', { class: 'hint' });

  function renderPalette() {
    const counts = {};
    for (const role of holds.values()) counts[role] = (counts[role] || 0) + 1;
    palette.replaceChildren(...PALETTE.map((role, i) => h('button', {
      type: 'button', class: `swatch swatch-${role}${role === activeRole ? ' on' : ''}`, 'aria-pressed': String(role === activeRole),
      title: `${role === 'erase' ? 'Erase' : ROLE_LABELS[role]} (key ${i + 1})`,
      onClick: () => {
        activeRole = role;
        renderPalette();
      },
    },
    role === 'erase' ? h('span', { class: 'erase-icon' }, icon('x', { size: 15 })) : roleDot(role),
    h('span', {}, role === 'erase' ? 'Erase' : ROLE_LABELS[role]),
    role !== 'erase' && h('span', { class: 'swatch-count' }, counts[role] || 0))));
    const missing = ['start', 'finish'].filter((r) => !counts[r]);
    const ghosts = [...holds.keys()].filter(isRemoved).map((id) => state.holdById.get(id).name);
    warning.textContent = ghosts.length
      ? `${ghosts.join(', ')} ${ghosts.length > 1 ? 'were' : 'was'} removed from the wall. Tap the faded red-ringed hold${ghosts.length > 1 ? 's' : ''} to drop ${ghosts.length > 1 ? 'them' : 'it'}, then add replacements.`
      : missing.length
        ? `Tap holds on the board to paint them. Still needs: ${missing.map((r) => ROLE_LABELS[r].toLowerCase()).join(' and ')}.`
        : `${holds.size} holds selected. Tap a hold again with the same type to remove it.`;
  }

  // Once a hold is painted, the rest fade (app.css) unless switched off.
  function paint() {
    board.setRoute(holds, { dim: fadeOthers });
    renderPalette();
  }

  const fadeToggle = h('input', { type: 'checkbox', checked: fadeOthers, onChange: () => setFade(fadeToggle.checked) });

  function setFade(on) {
    fadeOthers = on;
    fadeToggle.checked = on;
    try {
      localStorage.setItem(FADE_KEY, on ? 'on' : 'off');
    } catch {
      // Storage unavailable (private mode); the switch just won't persist.
    }
    paint();
  }

  // ---- fields --------------------------------------------------------------
  const name = h('input', {
    type: 'text', class: 'input', maxlength: 80, value: (route || draft)?.name || '',
    placeholder: isVariation ? 'e.g. Sit Start — or roll the dice' : 'Leave blank for a random name',
  });
  const dice = h('button', {
    type: 'button', class: 'btn btn-icon', title: 'Random name', 'aria-label': 'Generate a random name',
    onClick: () => (name.value = randomName(takenNames)),
  }, icon('dice', { size: 18 }));
  const gradeGroup = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Grade' },
    GRADES.map((g) => h('label', { class: `seg grade-${g}` },
      h('input', { type: 'radio', name: 'grade', value: g, checked: g === grade, onChange: () => (grade = g) }),
      h('span', { class: 'seg-grade' }, gradePips(g), h('span', { class: 'grade-v' }, gradeV(g))))));
  const setter = h('select', { class: 'input' },
    climberOptions(state.climbers, route || draft ? (route || draft).setter_id : state.me, '— unknown —'));
  const setDate = h('input', { type: 'date', class: 'input', required: true, value: (route || draft)?.set_date || today() });
  const faClimber = h('select', { class: 'input' }, climberOptions(state.climbers, route?.fa_climber_id, '— none —'));
  const faDate = h('input', { type: 'date', class: 'input', value: route?.fa_date || '' });
  const notes = h('textarea', { class: 'input', rows: 3, placeholder: 'Beta, rules (e.g. no matching), anything else', value: (route || draft)?.notes || '' });

  const cancelTarget = editing ? `#/route/${route.id}` : draft ? '#/drafts' : parent ? `#/route/${parent.id}` : '#/climbs';

  // What both Save route and Save draft send.
  function formData() {
    return {
      grade,
      setter_id: setter.value || null,
      set_date: setDate.value,
      notes: notes.value,
      holds: [...holds].map(([holdId, role]) => ({ hold_id: holdId, role })),
    };
  }

  // Keeps the form as it is (name and set date may still be blank) for later.
  async function saveDraft() {
    const draftName = name.value.trim();
    const data = { ...formData(), name: draftName, parent_id: parent?.id ?? null, saved_by: state.me };
    try {
      const saved = draft ? await ctx.api.updateDraft(draft.id, data) : await ctx.api.createDraft(data);
      state.lastDraftId = saved.id;
      ctx.toast(draftName ? `Saved draft “${draftName}”.` : 'Saved draft.', 'success');
      ctx.go('#/drafts');
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  async function deleteDraft() {
    if (!await confirmDialog('Delete this draft?', 'Its holds and details will be gone for good.', 'Delete draft')) return;
    try {
      await ctx.api.deleteDraft(draft.id);
      ctx.toast('Draft deleted.', 'success');
      ctx.go('#/drafts');
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  async function save(e) {
    e.preventDefault();
    let finalName = name.value.trim();
    if (!finalName) {
      finalName = randomName(takenNames);
      name.value = finalName;
    }
    const roles = new Set(holds.values());
    const missing = ['start', 'finish'].filter((r) => !roles.has(r));
    if (missing.length) {
      const ok = await confirmDialog('Save anyway?', `This route has no ${missing.join(' or ')} hold yet.`, 'Save anyway', 'btn-primary');
      if (!ok) return;
    }
    if (editing && !!faClimber.value !== !!faDate.value) {
      ctx.toast('A first ascent needs both a climber and a date (or neither).', 'error');
      return;
    }
    const data = { ...formData(), name: finalName };
    if (editing) Object.assign(data, { fa_climber_id: faClimber.value || null, fa_date: faDate.value || null });
    if (parent) data.parent_id = parent.id;
    if (draft) data.draft_id = draft.id;   // published: the draft goes
    try {
      const saved = editing ? await ctx.api.updateRoute(route.id, data) : await ctx.api.createRoute(data);
      ctx.toast(editing ? `Saved “${finalName}”.` : `Created “${finalName}”.`, 'success');
      ctx.go(`#/route/${saved.id}`);
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  const title = editing
    ? (isVariation ? 'Edit variation' : 'Edit route')
    : (isVariation ? 'New variation' : 'Set a new boulder');

  root.replaceChildren(h('form', { class: 'editor', onSubmit: save },
    h('button', { type: 'button', class: 'back-link', onClick: () => ctx.go(cancelTarget) }, icon('arrow-left', { size: 15 }), 'Cancel'),
    isVariation && h('div', { class: 'route-kicker' }, `Variation of ${base.name}`),
    h('h1', {}, title),
    draft && h('div', { class: 'draft-note' },
      h('span', { class: 'muted' },
        `Draft, saved ${draft.saved_by_name ? `by ${draft.saved_by_name} ` : ''}${fmtDate(draft.updated_at.slice(0, 10))}. Save route publishes it.`),
      h('button', { type: 'button', class: 'btn btn-small btn-ghost-danger', onClick: deleteDraft }, 'Delete draft')),
    dropped > 0 && h('p', { class: 'banner info' },
      `${dropped} hold${dropped > 1 ? 's' : ''} ${draft ? 'in this draft' : 'from the original'} ${dropped > 1 ? 'were' : 'was'} left out because ${dropped > 1 ? 'they were' : 'it was'} removed from the wall.`),
    h('section', { class: 'card' },
      h('h3', {}, 'Holds'),
      palette,
      warning,
      h('label', { class: 'toggle' }, fadeToggle, h('span', {}, 'Fade other holds'), h('kbd', {}, 'F')),
      h('button', {
        type: 'button', class: 'btn btn-small', onClick: () => {
          holds.clear();
          paint();
        },
      }, 'Clear all holds')),
    field(isVariation ? 'Variation name' : 'Route name', h('div', { class: 'input-with-button' }, name, dice)),
    field('Grade', gradeGroup),
    h('div', { class: 'grid-2' }, field('Setter', setter), field('Set on', setDate)),
    editing && h('fieldset', { class: 'fa-fields' },
      h('legend', {}, 'First ascent'),
      h('div', { class: 'grid-2' }, field('Climber', faClimber), field('Date', faDate)),
      h('p', { class: 'hint' }, 'Filled in automatically by the first logged send. Edit only to correct it.')),
    field('Notes', notes),
    h('div', { class: 'actions sticky-actions' },
      h('button', { type: 'button', class: 'btn', onClick: () => ctx.go(cancelTarget) }, 'Cancel'),
      !editing && h('button', { type: 'button', class: 'btn', onClick: saveDraft }, 'Save draft'),
      h('button', { type: 'submit', class: 'btn btn-primary' }, editing ? 'Save changes' : 'Save route'))));

  board.setMode('edit');
  paint();

  // Number keys switch the paint type, and F the fading, while not typing in a field.
  const onKey = (e) => {
    if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'f' || e.key === 'F') {
      setFade(!fadeOthers);
      return;
    }
    const role = PALETTE[Number(e.key) - 1];
    if (role) {
      activeRole = role;
      renderPalette();
    }
  };
  document.addEventListener('keydown', onKey);

  return {
    onHoldClick(hold) {
      // Removed holds (shown as ghosts) can only be dropped from the route.
      if (hold.removed || activeRole === 'erase' || holds.get(hold.id) === activeRole) holds.delete(hold.id);
      else holds.set(hold.id, activeRole);
      paint();
    },
    destroy() {
      document.removeEventListener('keydown', onKey);
    },
  };
}
