// The Wall tab (#/holds, computers only): the holds on the wall, a tapped
// hold's details and the climbs that use it, removing and restoring holds,
// and three tools that each take over the panel while they're open: placing
// or editing a hold (holds/placement.js), recoloring several (holds/recolor.js)
// and drawing volumes (holds/volumes.js).

import { append, confirmDialog, dialog, h, icon, plural } from '../ui.js';
import { colorLabel, inches, thumb, uploadButton, wallGeometry } from './holds/common.js';
import { holdPlacement } from './holds/placement.js';
import { holdRecolor } from './holds/recolor.js';
import { volumeEditor } from './holds/volumes.js';

export async function render(root, ctx) {
  const { state, board } = ctx;
  if (!state.holdNames) state.holdNames = await ctx.api.holdNames();
  if (ctx.stale()) return;

  let selected = null;     // hold being inspected
  let removedOpen = false; // the "Removed holds" list stays open across redraws

  // What the tools call back: redraw the tab, and pick a hold (or none) to inspect.
  const tab = {
    show,
    select(hold) {
      selected = hold;
    },
  };
  const wall = wallGeometry(state.spec);
  const placement = holdPlacement(ctx, wall, tab);
  const volumes = volumeEditor(ctx, wall, tab);
  const recolor = holdRecolor(ctx, tab);
  // In the order they'd take the panel, if more than one were open.
  const tools = [placement, volumes, recolor];

  function show() {
    const placing = placement.active || volumes.active;
    board.setMode(placing ? 'place' : 'pick');
    board.setPicked(placing ? null : recolor.active ? recolor.ids : selected?.id ?? null);
    board.setHidden(placement.holdId);
    board.setHiddenVolume(volumes.id);   // a volume being reshaped shows as its draft only
    board.highlightVolume(null);
    if (!placement.active) board.setDraft(null);
    if (!volumes.active) board.setVolumeDraft(null);
    const tool = tools.find((t) => t.active);
    root.replaceChildren(tool ? tool.panel() : selected ? selectedPanel() : idlePanel());
    tool?.sync?.();
  }

  // ---- idle: overview + upload ----------------------------------------------
  function idlePanel() {
    const active = state.holds.filter((x) => !x.removed);
    const removed = state.holds.filter((x) => x.removed);
    const photos = active.filter((x) => x.image_url).length;
    return h('div', { class: 'view' },
      h('div', { class: 'panel-head' }, h('h1', {}, 'Wall & holds'), h('span', { class: 'muted' }, plural(active.length, 'hold'))),
      h('p', { class: 'hint' }, `${photos} with images, ${active.length - photos} placeholder circles. Tap any hold on the board to edit or remove it.`),
      uploadButton([icon('upload'), 'Add a hold (PNG)'], placement.start),
      h('p', { class: 'hint' }, 'Use a PNG with a transparent background. Holds can go anywhere on the main board, the footboard below it, the side panels or the ceiling — they don’t need to sit on a t-nut.'),
      h('button', { type: 'button', class: 'btn recolor-start', onClick: recolor.start }, icon('palette'), 'Recolor holds'),
      removed.length > 0 && h('details', { class: 'removed-holds', open: removedOpen, onToggle: (e) => { removedOpen = e.currentTarget.open; } },
        h('summary', {}, `Removed holds (${removed.length})`),
        removed.map((r) => h('div', { class: 'removed-row' },
          thumb(r, 32),
          h('span', { class: 'removed-name' }, r.name),
          h('span', { class: 'muted small' }, r.grid),
          h('div', { class: 'removed-actions' },
            h('button', { type: 'button', class: 'btn btn-small', onClick: () => restore(r) }, 'Restore'),
            h('button', { type: 'button', class: 'btn btn-small btn-ghost-danger', onClick: () => deletePermanently(r) }, 'Delete permanently'))))),
      volumes.section());
  }

  // ---- a hold is selected ------------------------------------------------------
  function selectedPanel() {
    const hold = selected;
    const usage = h('section', { class: 'usage' }, h('p', { class: 'muted' }, 'Checking routes…'));
    ctx.api.holdImpact(hold.id).then((impact) => {
      if (selected !== hold || placement.active) return;
      // `append` skips the list when there are no climbs (replaceChildren would print "false").
      usage.replaceChildren();
      append(usage, [
        h('h2', {}, impact.climbs.length ? `Used by ${plural(impact.climbs.length, 'climb')}` : 'Not used by any climbs'),
        impact.climbs.length > 0 && h('ul', { class: 'usage-list' }, impact.climbs.map((c) => h('li', {},
          h('button', { type: 'button', class: 'link', onClick: () => ctx.go(`#/route/${c.id}`) }, c.display_name),
          !c.possible && h('span', { class: 'badge impossible-tag' }, 'Not possible')))),
      ]);
    }).catch((err) => usage.replaceChildren(h('p', { class: 'muted' }, err.message)));

    return h('div', { class: 'view' },
      h('button', { type: 'button', class: 'back-link', onClick: () => { selected = null; show(); } }, icon('arrow-left', { size: 15 }), 'All holds'),
      h('div', { class: 'route-kicker' }, hold.image_url ? 'Hold' : 'Placeholder hold'),
      h('div', { class: 'hold-heading' }, thumb(hold, 56), h('h1', {}, hold.name)),
      h('dl', { class: 'meta' },
        // A hold on a side panel or the ceiling has no t-nut (and no offset from one).
        hold.offset == null
          ? [h('dt', {}, 'Panel'), h('dd', {}, hold.grid, h('span', { class: 'muted' }, ' · no t-nuts'))]
          : [h('dt', {}, 'Nearest t-nut'),
            h('dd', {}, hold.grid, h('span', { class: 'muted' }, hold.offset < 0.05 ? ' · on the t-nut' : ` · ${inches(hold.offset)} off-grid`))],
        hold.image_url && [
          h('dt', {}, 'Size'), h('dd', {}, inches(hold.size)),
          h('dt', {}, 'Rotation'), h('dd', {}, `${Math.round(hold.rotation)}°`),
          h('dt', {}, 'Color'), h('dd', {}, colorLabel(hold, state.colors)),
        ]),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onClick: () => placement.edit(hold) }, 'Edit placement'),
        uploadButton([icon('image'), hold.image_url ? 'Replace image' : 'Add image'], (file) => placement.edit(hold, file), 'btn'),
        h('button', { type: 'button', class: 'btn btn-ghost-danger', onClick: () => removeHold(hold) }, 'Remove hold')),
      usage);
  }

  // ---- remove / restore ----------------------------------------------------------
  async function removeHold(hold) {
    let impact;
    try {
      impact = await ctx.api.holdImpact(hold.id);
    } catch (err) {
      ctx.toast(err.message, 'error');
      return;
    }
    const body = h('div', {},
      h('p', {}, `${hold.name} (${hold.grid}) will be taken off the wall.`),
      impact.retired.length > 0 && [
        h('p', { class: 'impact-head' }, 'These routes move to Legacy:'),
        h('ul', { class: 'impact-list' }, impact.retired.map((r) => h('li', {}, r.name)))],
      impact.partial.length > 0 && [
        h('p', { class: 'impact-head' }, 'These stay, but some variations will no longer be possible:'),
        h('ul', { class: 'impact-list' }, impact.partial.map((r) => h('li', {},
          h('strong', {}, r.name), h('div', { class: 'muted small' }, `Greyed out: ${r.newly_impossible.join(', ')}`))))],
      !impact.retired.length && !impact.partial.length && h('p', { class: 'muted' }, 'No current routes use this hold.'),
      h('p', { class: 'muted small' }, 'Removed holds can be restored later from this tab.'));
    const choice = await dialog({
      title: `Remove ${hold.name}?`,
      body,
      actions: [{ value: 'cancel', label: 'Cancel' }, { value: 'ok', label: 'Remove hold', class: 'btn-danger' }],
    });
    if (choice !== 'ok') return;
    try {
      await ctx.api.removeHold(hold.id);
      await ctx.refreshHolds();
      const moved = impact.retired.length ? ` ${plural(impact.retired.length, 'route')} moved to Legacy.` : '';
      ctx.toast(`${hold.name} removed.${moved}`);
      selected = null;
      show();
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  async function restore(hold) {
    try {
      const restored = await ctx.api.restoreHold(hold.id);
      await ctx.refreshHolds();
      ctx.toast(`${restored.name} is back on the wall.`, 'success');
      show();
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  // Only for a removed hold that no climb uses (legacy ones included): the
  // server refuses otherwise, so say which climbs are in the way.
  async function deletePermanently(hold) {
    let impact;
    try {
      impact = await ctx.api.holdImpact(hold.id);
    } catch (err) {
      ctx.toast(err.message, 'error');
      return;
    }
    if (impact.climbs.length) {
      await dialog({
        title: `${hold.name} is still in use`,
        body: h('div', {},
          h('p', {}, `${hold.name} can’t be deleted while these climbs use it:`),
          h('ul', { class: 'impact-list' }, impact.climbs.map((c) => h('li', {}, c.display_name))),
          h('p', { class: 'muted small' }, 'Delete those climbs, or edit them to swap the hold out, first. Restoring the hold brings them back to Climbs instead.')),
        actions: [{ value: 'cancel', label: 'OK', class: 'btn-primary' }],
      });
      return;
    }
    const ok = await confirmDialog(`Delete ${hold.name} permanently?`,
      `${hold.name} (${hold.grid})${hold.image_url ? ' and its photo' : ''} will be deleted for good. This can’t be undone.`,
      'Delete permanently');
    if (!ok) return;
    try {
      await ctx.api.deleteHoldPermanently(hold.id);
      await ctx.refreshHolds();
      ctx.toast(`${hold.name} deleted permanently.`);
      show();
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  // Keys go to the tool that's open.
  const onKey = (e) => {
    // Keys typed in a field or a dialog (e.g. the color list) aren't for the board.
    if (e.target.closest('input, textarea, select, dialog') || document.querySelector('dialog[open]') || e.metaKey || e.ctrlKey || e.altKey) return;
    tools.find((t) => t.active)?.onKey(e);
  };
  document.addEventListener('keydown', onKey);

  show();

  return {
    onHoldClick(hold) {
      if (placement.active || volumes.active) return;
      if (recolor.active) recolor.onHoldClick(hold);
      else {
        selected = hold;
        show();
      }
    },
    onWallPointer(type, point) {
      if (type === 'down') document.activeElement?.blur?.();
      if (volumes.active) volumes.onWallPointer(type, point);
      else if (placement.active) placement.onWallPointer(type, point);
    },
    destroy() {
      document.removeEventListener('keydown', onKey);
      placement.destroy();
    },
  };
}
