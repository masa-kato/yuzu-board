import { boardImage, tintFilter, updateTint } from '../board.js';
import { colorField, colorName } from '../palette.js';
import { append, confirmDialog, dialog, field, h, icon, svg } from '../ui.js';

const DEFAULT_SIZE = 6;     // inches, longest side of a newly uploaded hold
const MAX_PIXELS = 1024;    // uploaded images are scaled down to this
const NUDGE = 0.25;         // inches per arrow-key press (Shift: 1")

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = (v) => Math.round(v * 100) / 100;
const inches = (n) => `${(Math.round(n * 10) / 10).toFixed(1)}"`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const startsWithLetter = (name, letter) => !!name && name[0].toUpperCase() === letter;
const VOLUME_COLORS = [['black', 'Black'], ['green', 'Dark green']];
const volumeColorName = (key) => VOLUME_COLORS.find(([k]) => k === key)[1];
const PANEL_NAMES = { main: 'main board', foot: 'footboard' };

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = src;
  });
}

// Trims fully transparent margins and caps the longest side, so `size` on the
// wall measures the hold itself rather than empty canvas around it.
async function prepareImage(file) {
  if (file.type !== 'image/png' && !/\.png$/i.test(file.name)) throw new Error('Please choose a PNG file');
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const c = canvas.getContext('2d', { willReadFrequently: true });
    c.drawImage(img, 0, 0);
    const { data, width, height } = c.getImageData(0, 0, canvas.width, canvas.height);
    let minX = width, minY = height, maxX = -1, maxY = -1, transparent = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const alpha = data[(y * width + x) * 4 + 3];
        if (alpha < 250) transparent = true;
        if (alpha > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) throw new Error('That image is completely transparent');
    const cw = maxX - minX + 1;
    const ch = maxY - minY + 1;
    const scale = Math.min(1, MAX_PIXELS / Math.max(cw, ch));
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(cw * scale));
    out.height = Math.max(1, Math.round(ch * scale));
    out.getContext('2d').drawImage(canvas, minX, minY, cw, ch, 0, 0, out.width, out.height);
    const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
    return { blob, src: URL.createObjectURL(blob), transparent };
  } finally {
    URL.revokeObjectURL(url);
  }
}

let thumbSeq = 0;
function thumb(hold, size = 40) {
  if (!hold.image_url) return h('span', { class: 'thumb thumb-proxy', style: `width:${size}px;height:${size}px` });
  const id = `tint-thumb-${++thumbSeq}`;
  return svg('svg', { class: 'thumb', viewBox: '-1 -1 2 2', width: size, height: size, 'aria-hidden': 'true' },
    svg('defs', {}, tintFilter(id, hold.color)),
    svg('g', { transform: `rotate(${hold.rotation})` },
      svg('image', { href: boardImage(hold), x: -0.92, y: -0.92, width: 1.84, height: 1.84, preserveAspectRatio: 'xMidYMid meet', filter: `url(#${id})` })));
}

function colorLabel(hold, colors) {
  if (!hold.color) return h('span', { class: 'muted' }, 'Original colors');
  const name = colorName(colors, hold.color);
  return h('span', { class: 'color-label' },
    h('span', { class: 'color-swatch', style: `background:${hold.color}` }),
    `${name ? `${name} ` : ''}${hold.color.toUpperCase()}`);
}

function uploadButton(label, onFile, cls = 'btn btn-primary') {
  const input = h('input', {
    type: 'file', accept: 'image/png', class: 'visually-hidden',
    onChange: () => {
      const file = input.files[0];
      input.value = '';
      if (file) onFile(file);
    },
  });
  return h('label', { class: `${cls} file-button` }, input, label);
}

export async function render(root, ctx) {
  const { state, board } = ctx;
  if (!state.holdNames) state.holdNames = await ctx.api.holdNames();
  if (ctx.stale()) return;
  const spec = state.spec;

  let selected = null;   // hold being inspected
  let draft = null;      // hold being placed or edited
  let els = null;        // live controls of the draft form
  let volumeDraft = null; // volume outline being drawn: { points, color, snap, panel }
  let vEls = null;        // live controls of the volume form
  let removedOpen = false; // the "Removed holds" list stays open across redraws
  let volumesOpen = false; // and so does the list of volumes
  let recolor = null;     // recoloring several holds: { ids: Set of hold ids, color: '#rrggbb' | '' (none) | null (not chosen) }
  const objectUrls = [];

  // The wall's panels as [left, top, right, bottom] in wall inches.
  const { sides, ceiling } = spec;
  const panelBoxes = {
    main: [0, 0, spec.width, spec.height],
    foot: [0, spec.foot.top, spec.width, spec.total_height],
    left: [sides.left_x, sides.top, sides.left_x + sides.width, sides.top + sides.height],
    right: [sides.right_x, sides.top, sides.right_x + sides.width, sides.top + sides.height],
    ceiling: [0, ceiling.top, spec.width, ceiling.top + ceiling.height],
  };

  function nearest(x, y) {
    // A side panel has no t-nuts: its holds take the panel's letter. (Points
    // reach here kept on a panel, so one past the main panel is on a side,
    // and one above it on the ceiling.)
    const side = x < 0 ? 'left' : x > spec.width ? 'right' : null;
    if (side) return { side, letter: sides.letters[side], label: sides.names[side], column: null, dist: null };
    if (y < 0) {
      // Nor does the ceiling, but its holds take the column they're under.
      const col = clamp(Math.floor((spec.col_x[0] - x) / spec.spacing + 0.5), 0, spec.cols - 1);
      const column = spec.col_labels[col];
      return { ceiling: true, x: spec.col_x[col], column, letter: column.slice(-1), label: `${ceiling.name}, column ${column}`, dist: null };
    }
    // Same panel split and rounding as geometry.nearest_tnut, so the server
    // agrees on the t-nut and therefore on the name's letter.
    const onFoot = y >= spec.height + spec.foot.gap / 2;
    const p = onFoot
      ? { ...spec.foot, colSpacing: spec.foot.col_spacing, rowSpacing: spec.foot.row_spacing }
      : { ...spec, colSpacing: spec.spacing, rowSpacing: spec.spacing };
    const col = clamp(Math.floor((p.col_x[0] - x) / p.colSpacing + 0.5), 0, p.cols - 1);
    const row = clamp(Math.floor((y - p.row_y[0]) / p.rowSpacing + 0.5), 0, p.rows - 1);
    const tx = p.col_x[col];
    const ty = p.row_y[row];
    const column = p.col_labels[col];
    const letter = column.replace('\u2032', '').slice(-1);
    return { x: tx, y: ty, column, letter, label: column + p.row_labels[row], dist: Math.hypot(x - tx, y - ty) };
  }

  // Keeps a point on the wall: one off it, or in a gap, moves to the closest
  // spot on the nearest of `panels`.
  function clampToPanels(x, y, panels = Object.keys(panelBoxes)) {
    let best = null;
    for (const panel of panels) {
      const [left, top, right, bottom] = panelBoxes[panel];
      const p = [clamp(x, left, right), clamp(y, top, bottom)];
      const d = Math.hypot(p[0] - x, p[1] - y);
      if (!best || d < best.d) best = { p, d };
    }
    return best.p;
  }

  // Every other hold by its name, lowercased. Names are unique across all
  // holds, removed ones included, so a removed hold can always come back.
  function takenNames() {
    return new Map(state.holds.filter((x) => x.id !== draft?.holdId).map((x) => [x.name.toLowerCase(), x]));
  }

  function suggestName(letter, avoid) {
    const taken = new Set(takenNames().keys());
    if (avoid) taken.add(avoid.toLowerCase());
    const nouns = state.holdNames[letter] || [];
    const options = nouns.filter((n) => !taken.has(n.toLowerCase()));
    if (options.length) return options[Math.floor(Math.random() * options.length)];
    for (let i = 2; ; i++) {
      for (const noun of nouns) if (!taken.has(`${noun} ${i}`.toLowerCase())) return `${noun} ${i}`;
    }
  }

  function show() {
    const placing = draft || volumeDraft;
    board.setMode(placing ? 'place' : 'pick');
    board.setPicked(placing ? null : recolor ? recolor.ids : selected?.id ?? null);
    board.setHidden(draft?.holdId ?? null);
    board.setHiddenVolume(volumeDraft?.id ?? null);   // a volume being reshaped shows as its draft only
    board.highlightVolume(null);
    if (!draft) {
      board.setDraft(null);
      els = null;
    }
    if (!volumeDraft) {
      board.setVolumeDraft(null);
      vEls = null;
    }
    let panel;
    if (draft) panel = draftPanel();
    else if (volumeDraft) panel = volumePanel();
    else if (recolor) panel = recolorPanel();
    else if (selected) panel = selectedPanel();
    else panel = idlePanel();
    root.replaceChildren(panel);
    if (draft) syncDraft();
    if (volumeDraft) syncVolume();
  }

  // ---- idle: overview + upload ----------------------------------------------
  function idlePanel() {
    const active = state.holds.filter((x) => !x.removed);
    const removed = state.holds.filter((x) => x.removed);
    const photos = active.filter((x) => x.image_url).length;
    return h('div', { class: 'view' },
      h('div', { class: 'panel-head' }, h('h1', {}, 'Wall & holds'), h('span', { class: 'muted' }, plural(active.length, 'hold'))),
      h('p', { class: 'hint' }, `${photos} with images, ${active.length - photos} placeholder circles. Tap any hold on the board to edit or remove it.`),
      uploadButton([icon('upload'), 'Add a hold (PNG)'], startNew),
      h('p', { class: 'hint' }, 'Use a PNG with a transparent background. Holds can go anywhere on the main board, the footboard below it, the side panels or the ceiling — they don’t need to sit on a t-nut.'),
      h('button', { type: 'button', class: 'btn recolor-start', onClick: startRecolor }, icon('palette'), 'Recolor holds'),
      removed.length > 0 && h('details', { class: 'removed-holds', open: removedOpen, onToggle: (e) => { removedOpen = e.currentTarget.open; } },
        h('summary', {}, `Removed holds (${removed.length})`),
        removed.map((r) => h('div', { class: 'removed-row' },
          thumb(r, 32),
          h('span', { class: 'removed-name' }, r.name),
          h('span', { class: 'muted small' }, r.grid),
          h('div', { class: 'removed-actions' },
            h('button', { type: 'button', class: 'btn btn-small', onClick: () => restore(r) }, 'Restore'),
            h('button', { type: 'button', class: 'btn btn-small btn-ghost-danger', onClick: () => deletePermanently(r) }, 'Delete permanently'))))),
      volumeSection());
  }

  // ---- recolor several holds at once ------------------------------------------------
  function startRecolor() {
    recolor = { ids: new Set(), color: null };
    selected = null;
    show();
  }

  function endRecolor() {
    recolor = null;
    show();
  }

  function recolorPanel() {
    const rc = recolor;
    // The holds that can take a color (they have an image), grouped by color:
    // the list's colors in its order, then custom ones, then holds without one.
    const groups = new Map();
    for (const hold of state.holds) {
      if (hold.removed || !hold.image_url) continue;
      const key = hold.color || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(hold.id);
    }
    const listed = new Set(state.colors.map((c) => c.hex));
    const order = [...state.colors.map((c) => c.hex).filter((hex) => groups.has(hex)),
      ...[...groups.keys()].filter((key) => key && !listed.has(key)),
      ...(groups.has('') ? [''] : [])];
    const chip = (key) => {
      const ids = groups.get(key);
      const all = ids.every((id) => rc.ids.has(id));
      const label = key ? colorName(state.colors, key) || key.toUpperCase() : 'No color';
      return h('button', {
        type: 'button', class: `chip${all ? ' on' : ''}`, 'aria-pressed': String(all),
        title: all ? `Unselect the ${label} holds` : `Select every ${label} hold`,
        onClick: () => {
          ids.forEach((id) => (all ? rc.ids.delete(id) : rc.ids.add(id)));
          show();
        },
      },
      h('span', { class: `color-swatch chip-swatch${key ? '' : ' none'}`, style: key ? `background:${key}` : null }),
      label, h('span', { class: 'chip-count' }, ids.length));
    };

    const apply = h('button', { type: 'button', class: 'btn btn-primary', onClick: applyRecolor });
    const sync = () => {
      apply.textContent = rc.ids.size ? `Recolor ${plural(rc.ids.size, 'hold')}` : 'Recolor holds';
      apply.disabled = !rc.ids.size || rc.color == null;
    };
    const target = colorField(ctx, {
      value: rc.color, placeholder: 'Choose a color…',
      onChange: (v) => {
        rc.color = v;
        sync();
      },
    });
    sync();

    return h('div', { class: 'view' },
      h('button', { type: 'button', class: 'back-link', onClick: endRecolor }, icon('arrow-left', { size: 15 }), 'Done'),
      h('h1', {}, 'Recolor holds'),
      h('p', { class: 'hint' }, 'Tap holds on the board to select them, or select every hold of a color below. Then pick their new color.'),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Select by color'),
        h('div', { class: 'color-chips' }, order.map(chip))),
      h('div', { class: 'recolor-count' },
        h('strong', {}, rc.ids.size ? `${plural(rc.ids.size, 'hold')} selected` : 'No holds selected'),
        rc.ids.size > 0 && h('button', { type: 'button', class: 'link', onClick: () => { rc.ids.clear(); show(); } }, 'Clear')),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'New color'), target.el),
      h('div', { class: 'actions sticky-actions' }, apply));
  }

  async function applyRecolor() {
    const rc = recolor;
    const ids = [...rc.ids];
    try {
      await ctx.api.recolorHolds(ids, rc.color || null);
      await Promise.all([ctx.refreshHolds(), ctx.refreshColors()]);
      const to = rc.color ? colorName(state.colors, rc.color) || rc.color.toUpperCase() : 'their original colors';
      ctx.toast(`Recolored ${plural(ids.length, 'hold')} to ${to}.`, 'success');
      rc.ids.clear();
      show();
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  // ---- volumes ---------------------------------------------------------------------
  const panelOfY = (y) => (y <= spec.height ? 'main' : 'foot');

  function volumeSection() {
    const volumes = state.volumes;
    return h('section', { class: 'volume-section' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'Volumes'), h('span', { class: 'muted' }, plural(volumes.length, 'volume'))),
      h('p', { class: 'hint' }, 'Volumes are part of the wall’s background: they sit behind the holds and can’t be picked as holds.'),
      h('button', { type: 'button', class: 'btn', onClick: startVolume }, icon('layers'), 'Add a volume'),
      volumes.length > 0 && h('details', { class: 'volume-list', open: volumesOpen, onToggle: (e) => { volumesOpen = e.currentTarget.open; } },
        h('summary', {}, `Volumes on the wall (${volumes.length})`),
        volumes.map((v) => h('div', {
          class: 'volume-row',
          onMouseenter: () => board.highlightVolume(v.id),
          onMouseleave: () => board.highlightVolume(null),
        },
        h('span', { class: `volume-chip ${v.color}` }),
        h('span', { class: 'volume-desc' }, [`${volumeColorName(v.color)} volume`, `${v.points.length} corners`,
          v.faces && v.faces.length ? plural(v.faces.length, 'face') : null, PANEL_NAMES[panelOfY(v.points[0][1])]].filter(Boolean).join(' · ')),
        h('button', { type: 'button', class: 'btn btn-small', title: 'Move its corners or change its color', onClick: () => editVolume(v) }, 'Edit'),
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

  function startVolume() {
    volumeDraft = newVolumeDraft();
    selected = null;
    show();
  }

  function editVolume(v) {
    volumeDraft = newVolumeDraft({
      id: v.id, points: v.points.map(([x, y]) => [x, y]), color: v.color, panel: panelOfY(v.points[0][1]),
      faces: (v.faces || []).map((f) => f.map(([x, y]) => [x, y])),
    });
    selected = null;
    show();
  }

  // ---- corners, edges and snapping ----
  const samePoint = (a, b) => Math.abs(a[0] - b[0]) < 0.005 && Math.abs(a[1] - b[1]) < 0.005;
  // How far a press reaches: about 12px on screen (22px for a finger), never under 0.6".
  const reachOf = (point) => Math.max(0.6, (point.touch ? 22 : 12) * point.px);
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

  function closestOnSegment([ax, ay], [bx, by], { x, y }) {
    const dx = bx - ax;
    const dy = by - ay;
    const t = dx || dy ? clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy), 0, 1) : 0;
    return [ax + t * dx, ay + t * dy];
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
    syncVolume();
  }

  // Done: keeps the face if it has 3+ corners.
  function finishFace() {
    const { faces, face } = volumeDraft;
    if (faces[face].length < 3) faces.splice(face, 1);
    volumeDraft.face = null;
    volumeDraft.drag = null;
    syncVolume();
  }

  function cancelFace() {
    volumeDraft.faces.splice(volumeDraft.face, 1);
    volumeDraft.face = null;
    volumeDraft.drag = null;
    syncVolume();
  }

  function deleteFace(i) {
    volumeDraft.faces.splice(i, 1);
    if (volumeDraft.face != null && volumeDraft.face > i) volumeDraft.face -= 1;
    volumeDraft.hoverFace = null;
    syncVolume();
  }

  function cancelVolume() {
    volumeDraft = null;
    show();
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
    syncVolume();
  }

  function volumePanel() {
    vEls = {};
    vEls.count = h('div', { class: 'corner-count' });
    vEls.colors = h('div', { class: 'volume-colors', role: 'group', 'aria-label': 'Volume color' });
    vEls.undo = h('button', { type: 'button', class: 'btn btn-small', onClick: undoCorner }, icon('undo', { size: 14 }), 'Undo last corner');
    vEls.clear = h('button', {
      type: 'button', class: 'btn btn-small',
      onClick: () => {
        Object.assign(volumeDraft, { points: [], panel: null, faces: [], face: null });
        syncVolume();
      },
    }, 'Clear');
    vEls.faceNote = h('div', { class: 'corner-count' });
    vEls.faceList = h('div', { class: 'face-list' });
    vEls.addFace = h('button', { type: 'button', class: 'btn btn-small', onClick: startFace }, icon('plus', { size: 14 }), 'Add a face');
    vEls.doneFace = h('button', { type: 'button', class: 'btn btn-small btn-primary', onClick: finishFace }, icon('check', { size: 14 }), 'Done');
    vEls.cancelFace = h('button', { type: 'button', class: 'btn btn-small', onClick: cancelFace }, 'Cancel face');
    const snap = h('input', { type: 'checkbox', checked: volumeDraft.snap, onChange: () => { volumeDraft.snap = snap.checked; } });
    vEls.save = h('button', { type: 'submit', class: 'btn btn-primary' }, volumeDraft.id ? 'Save changes' : 'Save volume');
    renderVolumeColors();
    return h('form', { class: 'editor', onSubmit: saveVolume },
      h('button', { type: 'button', class: 'back-link', onClick: cancelVolume }, icon('arrow-left', { size: 15 }), 'Cancel'),
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
        h('button', { type: 'button', class: 'btn', onClick: cancelVolume }, 'Cancel'),
        vEls.save));
  }

  function renderVolumeColors() {
    vEls.colors.replaceChildren(...VOLUME_COLORS.map(([key, label]) => h('button', {
      type: 'button', class: `volume-color${volumeDraft.color === key ? ' on' : ''}`, 'aria-pressed': String(volumeDraft.color === key),
      onClick: () => {
        volumeDraft.color = key;
        renderVolumeColors();
        syncVolume();
      },
    }, h('span', { class: `volume-chip ${key}` }), label)));
  }

  function syncVolume() {
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

  async function saveVolume(e) {
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
      show();
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
      show();
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  // ---- a hold is selected ------------------------------------------------------
  function selectedPanel() {
    const hold = selected;
    const usage = h('section', { class: 'usage' }, h('p', { class: 'muted' }, 'Checking routes…'));
    ctx.api.holdImpact(hold.id).then((impact) => {
      if (selected !== hold || draft) return;
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
        h('button', { type: 'button', class: 'btn btn-primary', onClick: () => startEdit(hold) }, 'Edit placement'),
        uploadButton([icon('image'), hold.image_url ? 'Replace image' : 'Add image'], (file) => startEdit(hold, file), 'btn'),
        h('button', { type: 'button', class: 'btn btn-ghost-danger', onClick: () => removeHold(hold) }, 'Remove hold')),
      usage);
  }

  // ---- placing / editing -------------------------------------------------------
  async function loadFile(file) {
    try {
      const img = await prepareImage(file);
      objectUrls.push(img.src);
      return img;
    } catch (err) {
      ctx.toast(err.message, 'error');
      return null;
    }
  }

  async function startNew(file) {
    const img = await loadFile(file);
    if (!img || ctx.stale()) return;
    const x = round2(spec.width / 2);
    const y = round2(spec.height / 2);
    draft = {
      holdId: null, src: img.src, blob: img.blob, transparent: img.transparent, isImage: true,
      x, y, size: DEFAULT_SIZE, rotation: 0, color: '', opacity: 0.5, name: '', nameTouched: false,
    };
    draft.name = suggestName(nearest(x, y).letter);
    selected = null;
    show();
  }

  async function startEdit(hold, file) {
    const img = file ? await loadFile(file) : null;
    if ((file && !img) || ctx.stale()) return;
    draft = {
      holdId: hold.id, original: hold,
      src: img ? img.src : hold.image_url, blob: img ? img.blob : null,
      transparent: img ? img.transparent : true, isImage: !!(img || hold.image_url),
      x: hold.x, y: hold.y, size: hold.size, rotation: hold.rotation,
      color: hold.color || '', opacity: hold.color_opacity ?? 0.5,
      name: hold.name, nameTouched: false,
    };
    show();
  }

  function moveDraft(x, y) {
    const [cx, cy] = clampToPanels(x, y);
    draft.x = round2(cx);
    draft.y = round2(cy);
    syncDraft();
  }

  function draftPanel() {
    els = {};
    const isNew = !draft.holdId;

    let preview = null;
    if (draft.isImage) {
      els.previewFilter = tintFilter('tint-preview', null);
      els.previewArt = svg('g', {},
        svg('image', { href: draft.src, x: -0.92, y: -0.92, width: 1.84, height: 1.84, preserveAspectRatio: 'xMidYMid meet', filter: 'url(#tint-preview)' }));
      preview = svg('svg', { class: 'hold-preview', viewBox: '-1 -1 2 2', 'aria-label': 'Preview' }, svg('defs', {}, els.previewFilter), els.previewArt);
    }

    els.position = h('div', { class: 'position-readout' });
    els.snap = h('button', {
      type: 'button', class: 'btn btn-small',
      onClick: () => {
        const n = nearest(draft.x, draft.y);
        moveDraft(n.x, n.y);
      },
    });

    let appearance = null;
    if (draft.isImage) {
      // 0.1" steps, matching the one-decimal size label.
      const size = h('input', { type: 'range', min: 1, max: 24, step: 0.1, value: draft.size, 'aria-label': 'Size',
        onInput: () => { draft.size = Number(size.value); syncDraft(); } });
      els.sizeLabel = h('span', { class: 'range-value' });
      els.rotation = h('input', { type: 'range', min: -180, max: 180, step: 1, value: draft.rotation, 'aria-label': 'Rotation',
        onInput: () => { draft.rotation = Number(els.rotation.value); syncDraft(); } });
      els.rotationLabel = h('span', { class: 'range-value' });
      const rotateBy = (deg) => {
        draft.rotation = ((draft.rotation + deg + 540) % 360) - 180;
        syncDraft();
      };

      const color = colorField(ctx, { value: draft.color, onChange: (v) => { draft.color = v; syncDraft(); } });

      appearance = [
        field('Size', h('div', { class: 'range-row' }, size, els.sizeLabel)),
        field('Rotation', h('div', { class: 'range-row' },
          h('button', { type: 'button', class: 'btn btn-small', title: 'Rotate 15° counter-clockwise', onClick: () => rotateBy(-15) }, icon('rotate-left', { size: 14 }), '15°'),
          els.rotation,
          h('button', { type: 'button', class: 'btn btn-small', title: 'Rotate 15° clockwise', onClick: () => rotateBy(15) }, icon('rotate-right', { size: 14 }), '15°'),
          els.rotationLabel)),
        // One opacity for every hold, set by the Color slider under the board.
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Color'), color.el,
          h('span', { class: 'field-hint' }, 'Every hold’s color shows at the same opacity: the Color slider under the board sets it.')),
      ];
    }

    els.name = h('input', {
      type: 'text', class: 'input', maxlength: 40, value: draft.name, autocomplete: 'off',
      onInput: () => { draft.name = els.name.value; draft.nameTouched = true; syncDraft(); },
    });
    const dice = h('button', {
      type: 'button', class: 'btn btn-icon', title: 'Suggest another name', 'aria-label': 'Suggest another name',
      onClick: () => {
        draft.name = suggestName(nearest(draft.x, draft.y).letter, draft.name);
        draft.nameTouched = false;
        syncDraft();
      },
    }, icon('dice', { size: 18 }));
    els.nameHint = h('span', { class: 'field-hint' });
    els.save = h('button', { type: 'submit', class: 'btn btn-primary' }, isNew ? 'Add to wall' : 'Save changes');

    return h('form', { class: 'editor', onSubmit: save },
      h('button', { type: 'button', class: 'back-link', onClick: cancelDraft }, icon('arrow-left', { size: 15 }), 'Cancel'),
      h('h1', {}, isNew ? 'Add a hold' : `Edit ${draft.original.name}`),
      !draft.transparent && h('p', { class: 'banner warn' }, 'This PNG has no transparent pixels, so its background will show on the wall.'),
      h('div', { class: 'placement' },
        preview,
        h('div', { class: 'placement-info' },
          els.position,
          els.snap,
          h('p', { class: 'hint' }, 'Drag the hold on the board, or tap where it goes. Arrow keys nudge it (hold Shift for 1"). Zoom in with + / − on the board, the + and − keys, a pinch, or Ctrl + scroll.'))),
      appearance,
      field('Name', h('div', { class: 'input-with-button' }, els.name, dice), els.nameHint),
      h('div', { class: 'actions sticky-actions' },
        h('button', { type: 'button', class: 'btn', onClick: cancelDraft }, 'Cancel'),
        els.save));
  }

  // Pushes the draft's state to the board, the preview and the form readouts.
  function syncDraft() {
    const n = nearest(draft.x, draft.y);
    if (!draft.nameTouched && !startsWithLetter(draft.name, n.letter)) draft.name = suggestName(n.letter);
    board.setDraft({
      src: draft.isImage ? draft.src : null,
      x: draft.x, y: draft.y, size: draft.size, rotation: draft.rotation,
      color: draft.color, nearest: n.side ? null : n,
    });

    // Where the name's letter comes from: the side panel, the column on the
    // ceiling, or the t-nut's column.
    const panel = n.side && n.label.toLowerCase();
    let why = `the nearest column is ${n.column}`;
    let source = `column ${n.column}`;
    let where = [h('strong', {}, `Nearest t-nut ${n.label}`), h('span', { class: 'muted' }, n.dist < 0.05 ? ' · on the t-nut' : ` · ${inches(n.dist)} off-grid`)];
    if (n.side) {
      why = `it’s on the ${panel}`;
      source = `the ${panel}`;
      where = [h('strong', {}, `On the ${panel}`), h('span', { class: 'muted' }, ' · no t-nuts')];
    } else if (n.ceiling) {
      why = `it’s in column ${n.column} on the ceiling`;
      source = `column ${n.column} on the ceiling`;
      where = [h('strong', {}, `On the ceiling, column ${n.column}`), h('span', { class: 'muted' }, ' · no t-nuts')];
    }
    els.position.replaceChildren(...where);
    els.snap.hidden = n.dist == null;
    els.snap.textContent = `Snap to ${n.label}`;
    els.snap.disabled = n.dist < 0.05;

    if (draft.isImage) {
      els.sizeLabel.textContent = inches(draft.size);
      els.rotation.value = draft.rotation;
      els.rotationLabel.textContent = `${Math.round(draft.rotation)}°`;
      els.previewArt.setAttribute('transform', `rotate(${draft.rotation})`);
      updateTint(els.previewFilter, draft.color);
    }

    if (els.name.value !== draft.name) els.name.value = draft.name;
    const name = draft.name.trim();
    const clash = takenNames().get(name.toLowerCase());
    const problem = !name ? `Give it a noun starting with ${n.letter}`
      : !startsWithLetter(name, n.letter) ? `Must start with ${n.letter} — ${why}`
        : clash?.removed ? 'A removed hold has this name. Delete it permanently to reuse the name'
          : clash ? 'Another hold already has this name' : null;
    els.nameHint.textContent = problem || `Starts with ${n.letter}, for ${source}`;
    els.nameHint.classList.toggle('error', !!problem);
    els.save.disabled = !!problem;
  }

  function cancelDraft() {
    draft = null;
    show();
  }

  async function save(e) {
    e.preventDefault();
    const form = new FormData();
    form.set('x', draft.x);
    form.set('y', draft.y);
    form.set('name', draft.name.trim());
    if (draft.isImage) {
      form.set('size', draft.size);
      form.set('rotation', draft.rotation);
      form.set('color', draft.color);
      form.set('color_opacity', draft.opacity);
    }
    if (draft.blob) form.set('image', draft.blob, 'hold.png');
    try {
      const saved = draft.holdId ? await ctx.api.updateHold(draft.holdId, form) : await ctx.api.createHold(form);
      await ctx.refreshHolds();
      ctx.toast(draft.holdId ? `Saved ${saved.name}.` : `${saved.name} added ${saved.offset == null ? `on the ${saved.grid.charAt(0).toLowerCase()}${saved.grid.slice(1)}` : `near ${saved.grid}`}.`, 'success');
      draft = null;
      selected = state.holdById.get(saved.id);
      show();
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
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

  const onKey = (e) => {
    // Keys typed in a field or a dialog (e.g. the color list) aren't for the board.
    if (e.target.closest('input, textarea, select, dialog') || document.querySelector('dialog[open]') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (recolor && e.key === 'Escape') {
      endRecolor();
      return;
    }
    if (volumeDraft) {
      const drawingFace = volumeDraft.face != null;
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        if (drawingFace || volumeDraft.points.length) undoCorner();
      } else if (e.key === 'Enter' && !e.target.closest('button')) {
        e.preventDefault();
        if (drawingFace) finishFace();
        else saveVolume();
      } else if (e.key === 'Escape') {
        if (drawingFace) cancelFace();
        else cancelVolume();
      }
      return;
    }
    if (!draft) return;
    const step = e.shiftKey ? 1 : NUDGE;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!delta) return;
    e.preventDefault();
    moveDraft(draft.x + delta[0], draft.y + delta[1]);
  };
  document.addEventListener('keydown', onKey);

  show();

  return {
    onHoldClick(hold) {
      if (draft || volumeDraft) return;
      if (recolor) {
        if (!hold.image_url) {
          ctx.toast('Placeholder holds have no image to color', 'error');
          return;
        }
        if (recolor.ids.has(hold.id)) recolor.ids.delete(hold.id);
        else recolor.ids.add(hold.id);
        show();
        return;
      }
      selected = hold;
      show();
    },
    onWallPointer(type, point) {
      if (type === 'down') document.activeElement?.blur?.();
      if (volumeDraft) {
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
        syncVolume();
        return;
      }
      if (draft) moveDraft(point.x, point.y);
    },
    destroy() {
      document.removeEventListener('keydown', onKey);
      objectUrls.forEach((u) => URL.revokeObjectURL(u));
    },
  };
}
