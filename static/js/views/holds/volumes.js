// The Wall tab's volumes: the list of them on the wall, and the editor that
// draws one (its corners, color and faces) or reshapes a saved one. Its draft
// is drawn on the board (board.setVolumeDraft) until it's saved or cancelled.

import { confirmDialog, field, h, icon, plural } from '../../ui.js';
import { clamp, round2 } from './common.js';

const VOLUME_COLORS = [['black', 'Black'], ['green', 'Dark green']];
const volumeColorName = (key) => VOLUME_COLORS.find(([k]) => k === key)[1];
const PANEL_NAMES = { main: 'main board', foot: 'footboard' };

const samePoint = (a, b) => Math.abs(a[0] - b[0]) < 0.005 && Math.abs(a[1] - b[1]) < 0.005;
// How far a press reaches: about 12px on screen (22px for a finger), never under 0.6".
const reachOf = (point) => Math.max(0.6, (point.touch ? 22 : 12) * point.px);

function closestOnSegment([ax, ay], [bx, by], { x, y }) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = dx || dy ? clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy), 0, 1) : 0;
  return [ax + t * dx, ay + t * dy];
}

// `wall` is wallGeometry(spec); `tab` is the Wall tab's { show, select }.
export function volumeEditor(ctx, wall, tab) {
  const { state, board } = ctx;
  const spec = state.spec;
  const { nearest, clampToPanels } = wall;
  let volumeDraft = null; // volume outline being drawn: { points, color, snap, panel, … } (newVolumeDraft)
  let vEls = null;        // live controls of the volume form
  let listOpen = false;   // the list of volumes stays open across redraws

  const panelOfY = (y) => (y <= spec.height ? 'main' : 'foot');

  // The Volumes part of the Wall tab's overview: Add a volume, and the list.
  function section() {
    const volumes = state.volumes;
    return h('section', { class: 'volume-section' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Volumes'), h('span', { class: 'muted' }, plural(volumes.length, 'volume'))),
      h('p', { class: 'hint' }, 'Volumes are part of the wall’s background: they sit behind the holds and can’t be picked as holds.'),
      h('button', { type: 'button', class: 'btn', onClick: start }, icon('layers'), 'Add a volume'),
      volumes.length > 0 && h('details', { class: 'volume-list', open: listOpen, onToggle: (e) => { listOpen = e.currentTarget.open; } },
        h('summary', {}, `Volumes on the wall (${volumes.length})`),
        volumes.map((v) => h('div', {
          class: 'volume-row',
          onMouseenter: () => board.highlightVolume(v.id),
          onMouseleave: () => board.highlightVolume(null),
        },
        h('span', { class: `volume-chip ${v.color}` }),
        h('span', { class: 'volume-desc' }, [`${volumeColorName(v.color)} volume`, `${v.points.length} corners`,
          v.faces && v.faces.length ? plural(v.faces.length, 'face') : null, PANEL_NAMES[panelOfY(v.points[0][1])]].filter(Boolean).join(' · ')),
        h('button', { type: 'button', class: 'btn btn-small', title: 'Move its corners or change its color', onClick: () => edit(v) }, 'Edit'),
        h('button', { type: 'button', class: 'btn btn-small btn-ghost-danger', onClick: () => deleteVolume(v) }, 'Delete')))));
  }

  // The volume being drawn or reshaped. `id` is set for a saved volume.
  // `faces` are its sub-polygons (thin lines showing its sides); `face` is the
  // index of the one being drawn, `hoverFace` the one hovered in the list.
  // `drag` lists the corners being moved, as { face, i } (face null = outline),
  // and `grab` their offset from the pointer.
  function newVolumeDraft(fields) {
    return { id: null, points: [], color: 'black', snap: false, panel: null, faces: [], face: null, hoverFace: null, drag: null, grab: [0, 0], ...fields };
  }

  function start() {
    volumeDraft = newVolumeDraft();
    tab.select(null);
    tab.show();
  }

  function edit(v) {
    volumeDraft = newVolumeDraft({
      id: v.id, points: v.points.map(([x, y]) => [x, y]), color: v.color, panel: panelOfY(v.points[0][1]),
      faces: (v.faces || []).map((f) => f.map(([x, y]) => [x, y])),
    });
    tab.select(null);
    tab.show();
  }

  // ---- corners, edges and snapping ----
  const pointAt = ({ face, i }) => (face == null ? volumeDraft.points : volumeDraft.faces[face])[i];
  const setPointAt = ({ face, i }, p) => {
    (face == null ? volumeDraft.points : volumeDraft.faces[face])[i] = p;
  };

  // Every corner: the outline's, then each face's, as { face, i, p }.
  function allCorners() {
    const corners = volumeDraft.points.map((p, i) => ({ face: null, i, p }));
    volumeDraft.faces.forEach((f, face) => f.forEach((p, i) => corners.push({ face, i, p })));
    return corners;
  }

  // Every edge as [a, b, face, ia, ib]: the outline and finished faces, closed
  // (the face being drawn is left out, so it can't snap to itself).
  function allEdges() {
    const edges = [];
    const ring = (pts, face) => {
      if (pts.length < 2) return;
      pts.forEach((p, i) => {
        const j = (i + 1) % pts.length;
        if (j || pts.length > 2) edges.push([p, pts[j], face, i, j]);
      });
    };
    ring(volumeDraft.points, null);
    volumeDraft.faces.forEach((f, face) => face !== volumeDraft.face && ring(f, face));
    return edges;
  }

  // The corner within reach of a press, if any.
  function cornerNear(point) {
    let best = null;
    let bestDist = reachOf(point);
    for (const c of allCorners()) {
      const d = Math.hypot(c.p[0] - point.x, c.p[1] - point.y);
      if (d <= bestDist) {
        best = c;
        bestDist = d;
      }
    }
    return best;
  }

  // Where a face corner (or a dragged one) lands: on the nearest corner within
  // reach, else on the nearest edge within reach, else where pressed (see
  // cornerAt). `skip` lists the corners being moved: they don't snap to
  // themselves or to edges they are part of.
  function snapPoint(point, skip = []) {
    const skipped = (face, i) => skip.some((r) => r.face === face && r.i === i);
    let best = null;
    let bestDist = reachOf(point);
    for (const c of allCorners()) {
      if (skipped(c.face, c.i)) continue;
      const d = Math.hypot(c.p[0] - point.x, c.p[1] - point.y);
      if (d <= bestDist) {
        best = c.p;
        bestDist = d;
      }
    }
    if (best) return [best[0], best[1]];
    bestDist = reachOf(point);
    for (const [a, b, face, ia, ib] of allEdges()) {
      if (skipped(face, ia) || skipped(face, ib)) continue;
      const q = closestOnSegment(a, b, point);
      const d = Math.hypot(q[0] - point.x, q[1] - point.y);
      if (d <= bestDist) {
        best = q;
        bestDist = d;
      }
    }
    return best ? [round2(best[0]), round2(best[1])] : cornerAt(point);
  }

  // ---- faces ----
  function startFace() {
    volumeDraft.faces.push([]);
    volumeDraft.face = volumeDraft.faces.length - 1;
    sync();
  }

  // Done: keeps the face if it has 3+ corners.
  function finishFace() {
    const { faces, face } = volumeDraft;
    if (faces[face].length < 3) faces.splice(face, 1);
    volumeDraft.face = null;
    volumeDraft.drag = null;
    sync();
  }

  function cancelFace() {
    volumeDraft.faces.splice(volumeDraft.face, 1);
    volumeDraft.face = null;
    volumeDraft.drag = null;
    sync();
  }

  function deleteFace(i) {
    volumeDraft.faces.splice(i, 1);
    if (volumeDraft.face != null && volumeDraft.face > i) volumeDraft.face -= 1;
    volumeDraft.hoverFace = null;
    sync();
  }

  function cancel() {
    volumeDraft = null;
    tab.show();
  }

  // Where a press on the board puts a corner: on the main panel or the
  // footboard (volumes never go on a side panel or the ceiling), on the same panel as the
  // first corner, and on a t-nut if snapping is on.
  function cornerAt(point) {
    let [x, y] = clampToPanels(point.x, point.y, volumeDraft.panel ? [volumeDraft.panel] : ['main', 'foot']);
    if (volumeDraft.snap) {
      const n = nearest(x, y);
      [x, y] = [n.x, n.y];
    }
    return [round2(x), round2(y)];
  }

  function undoCorner() {
    if (volumeDraft.face != null) volumeDraft.faces[volumeDraft.face].pop();
    else volumeDraft.points.pop();
    if (!volumeDraft.points.length) volumeDraft.panel = null;
    sync();
  }

  function panel() {
    vEls = {};
    vEls.count = h('div', { class: 'corner-count' });
    vEls.colors = h('div', { class: 'volume-colors', role: 'group', 'aria-label': 'Volume color' });
    vEls.undo = h('button', { type: 'button', class: 'btn btn-small', onClick: undoCorner }, icon('undo', { size: 14 }), 'Undo last corner');
    vEls.clear = h('button', {
      type: 'button', class: 'btn btn-small',
      onClick: () => {
        Object.assign(volumeDraft, { points: [], panel: null, faces: [], face: null });
        sync();
      },
    }, 'Clear');
    vEls.faceNote = h('div', { class: 'corner-count' });
    vEls.faceList = h('div', { class: 'face-list' });
    vEls.addFace = h('button', { type: 'button', class: 'btn btn-small', onClick: startFace }, icon('plus', { size: 14 }), 'Add a face');
    vEls.doneFace = h('button', { type: 'button', class: 'btn btn-small btn-primary', onClick: finishFace }, icon('check', { size: 14 }), 'Done');
    vEls.cancelFace = h('button', { type: 'button', class: 'btn btn-small', onClick: cancelFace }, 'Cancel face');
    const snap = h('input', { type: 'checkbox', checked: volumeDraft.snap, onChange: () => { volumeDraft.snap = snap.checked; } });
    vEls.save = h('button', { type: 'submit', class: 'btn btn-primary' }, volumeDraft.id ? 'Save changes' : 'Save volume');
    renderColors();
    return h('form', { class: 'editor', onSubmit: save },
      h('button', { type: 'button', class: 'back-link', onClick: cancel }, icon('arrow-left', { size: 15 }), 'Cancel'),
      h('h1', {}, volumeDraft.id ? 'Edit volume' : 'Add a volume'),
      h('p', { class: 'hint' }, 'Click the corners in order around the volume. They can go anywhere on the main board or the footboard (one panel per volume). Drag any corner to move it. Backspace undoes the last corner, Enter saves, Esc cancels. Zoom with + / − on the board or a pinch.'),
      h('section', { class: 'card' },
        vEls.count,
        h('div', { class: 'actions' }, vEls.undo, vEls.clear),
        h('label', { class: 'toggle' }, snap, h('span', {}, 'Snap corners to the nearest t-nut'))),
      h('section', { class: 'card faces-card' },
        h('h2', { class: 'card-title' }, 'Faces'),
        h('p', { class: 'hint' }, 'Faces show the volume’s sides as fine lines. Add a face, then click its corners: they snap to corners already there, then to edges. Click its first corner, press Enter or Done to finish.'),
        vEls.faceNote,
        h('div', { class: 'actions' }, vEls.addFace, vEls.doneFace, vEls.cancelFace),
        vEls.faceList),
      field('Color', vEls.colors),
      h('div', { class: 'actions sticky-actions' },
        h('button', { type: 'button', class: 'btn', onClick: cancel }, 'Cancel'),
        vEls.save));
  }

  function renderColors() {
    vEls.colors.replaceChildren(...VOLUME_COLORS.map(([key, label]) => h('button', {
      type: 'button', class: `volume-color${volumeDraft.color === key ? ' on' : ''}`, 'aria-pressed': String(volumeDraft.color === key),
      onClick: () => {
        volumeDraft.color = key;
        renderColors();
        sync();
      },
    }, h('span', { class: `volume-chip ${key}` }), label)));
  }

  // Pushes the draft to the board and the form's counts and buttons.
  function sync() {
    const vd = volumeDraft;
    const n = vd.points.length;
    board.setVolumeDraft({
      points: vd.points, color: vd.color, faces: vd.faces, face: vd.face, highlightFace: vd.hoverFace,
      active: vd.drag ? pointAt(vd.drag[0]) : null,
    });
    syncFaces();
    let note = ` · on the ${PANEL_NAMES[volumeDraft.panel]}`;
    if (n === 0) note = ' · click the board to place the first one';
    else if (n < 3) note = ` · ${3 - n} more to make a shape`;
    vEls.count.replaceChildren(h('strong', {}, plural(n, 'corner')), h('span', { class: 'muted' }, note));
    vEls.undo.disabled = n === 0;
    vEls.clear.disabled = n === 0;
    vEls.save.disabled = n < 3;
  }

  function syncFaces() {
    const { faces, face, points } = volumeDraft;
    const drawing = face != null;
    const corners = drawing ? faces[face].length : 0;
    vEls.addFace.hidden = drawing;
    vEls.addFace.disabled = points.length < 3;
    vEls.doneFace.hidden = !drawing;
    vEls.doneFace.disabled = corners < 3;
    vEls.cancelFace.hidden = !drawing;
    let note = faces.length ? plural(faces.length - (drawing ? 1 : 0), 'face') : 'No faces yet';
    if (drawing) note = `Face ${face + 1}: ${plural(corners, 'corner')}${corners < 3 ? ` · ${3 - corners} more to make a face` : ' · click its first corner or Done to finish'}`;
    else if (points.length < 3) note = 'Place the volume’s corners first';
    vEls.faceNote.textContent = note;
    vEls.faceList.replaceChildren(...faces.map((f, i) => (i === face ? null : h('div', {
      class: 'face-row', onMouseenter: () => hoverFace(i), onMouseleave: () => hoverFace(null),
    },
    h('span', {}, `Face ${i + 1}`), h('span', { class: 'muted' }, plural(f.length, 'corner')),
    h('button', { type: 'button', class: 'icon-btn danger', title: 'Delete face', 'aria-label': `Delete face ${i + 1}`, onClick: () => deleteFace(i) }, icon('x', { size: 14 }))))).filter(Boolean));
  }

  function hoverFace(i) {
    if (volumeDraft.hoverFace === i) return;
    volumeDraft.hoverFace = i;
    board.setVolumeDraft({
      points: volumeDraft.points, color: volumeDraft.color, faces: volumeDraft.faces, face: volumeDraft.face, highlightFace: i,
    });
  }

  async function save(e) {
    e?.preventDefault();
    if (volumeDraft.points.length < 3) return;
    const { id, points, color } = volumeDraft;
    const faces = volumeDraft.faces.filter((f) => f.length >= 3);   // an unfinished face with 3+ corners counts
    try {
      if (id) await ctx.api.updateVolume(id, { points, color, faces });
      else await ctx.api.createVolume({ points, color, faces });
      await ctx.refreshVolumes();
      ctx.toast(id ? 'Volume saved.' : `${volumeColorName(color)} volume added.`, 'success');
      volumeDraft = null;
      tab.show();
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  async function deleteVolume(v) {
    const ok = await confirmDialog('Delete this volume?',
      `${volumeColorName(v.color)} volume with ${v.points.length} corners. Holds placed on it stay where they are.`);
    if (!ok) return;
    try {
      await ctx.api.deleteVolume(v.id);
      await ctx.refreshVolumes();
      ctx.toast('Volume deleted.');
      tab.show();
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  // Backspace undoes the last corner, Enter saves (or finishes a face), Esc cancels.
  function onKey(e) {
    const drawingFace = volumeDraft.face != null;
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      if (drawingFace || volumeDraft.points.length) undoCorner();
    } else if (e.key === 'Enter' && !e.target.closest('button')) {
      e.preventDefault();
      if (drawingFace) finishFace();
      else save();
    } else if (e.key === 'Escape') {
      if (drawingFace) cancelFace();
      else cancel();
    }
  }

  function onWallPointer(type, point) {
    const vd = volumeDraft;
    if (type === 'down') {
      vd.grab = [0, 0];
      vd.drag = null;
      if (vd.face != null) {
        // Drawing a face: each press adds a snapped corner (drag to adjust
        // it); pressing its first corner again closes it.
        const f = vd.faces[vd.face];
        const p = snapPoint(point);
        if (f.length >= 3 && samePoint(p, f[0])) {
          finishFace();
          return;
        }
        f.push(p);
        vd.drag = [{ face: vd.face, i: f.length - 1 }];
      } else {
        // A press on a corner picks it up, with every corner at the same
        // spot (so faces stay attached), keeping its offset from the
        // pointer; anywhere else adds the next outline corner.
        const hit = cornerNear(point);
        if (hit) {
          vd.drag = allCorners().filter((c) => samePoint(c.p, hit.p)).map(({ face, i }) => ({ face, i }));
          vd.grab = [hit.p[0] - point.x, hit.p[1] - point.y];
        } else {
          const corner = cornerAt(point);
          if (!vd.points.length) vd.panel = panelOfY(corner[1]);
          vd.points.push(corner);
          vd.drag = [{ face: null, i: vd.points.length - 1 }];
        }
      }
    } else if (vd.drag) {
      const target = { ...point, x: point.x + vd.grab[0], y: point.y + vd.grab[1] };
      // Outline corners on their own move freely (as when drawing the
      // outline); anything involving a face snaps to corners and edges.
      const freely = vd.drag.every((r) => r.face == null) && vd.face == null;
      const p = freely ? cornerAt(target) : snapPoint(target, vd.drag);
      vd.drag.forEach((r) => setPointAt(r, p));
      if (type === 'up') vd.drag = null;
    }
    sync();
  }

  return {
    get active() {
      return volumeDraft != null;
    },
    // A saved volume being reshaped, which the board hides while its draft shows.
    get id() {
      return volumeDraft?.id ?? null;
    },
    section,
    panel,
    sync,
    onKey,
    onWallPointer,
  };
}
