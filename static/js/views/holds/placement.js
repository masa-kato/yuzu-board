// The Wall tab's hold editor: placing a new hold from a PNG, or moving,
// resizing, turning, coloring and renaming one already on the wall. Its draft
// is drawn on the board (board.setDraft) until it's saved or cancelled.

import { tintFilter, updateTint } from '../../board.js';
import { colorField } from '../../palette.js';
import { field, h, icon, svg } from '../../ui.js';
import { inches, round2 } from './common.js';

const DEFAULT_SIZE = 6;     // inches, longest side of a newly uploaded hold
const MAX_PIXELS = 1024;    // uploaded images are scaled down to this
const NUDGE = 0.25;         // inches per arrow-key press (Shift: 1")

const startsWithLetter = (name, letter) => !!name && name[0].toUpperCase() === letter;

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

// `wall` is wallGeometry(spec); `tab` is the Wall tab's { show, select }.
export function holdPlacement(ctx, wall, tab) {
  const { state, board } = ctx;
  const spec = state.spec;
  const { nearest, clampToPanels } = wall;
  let draft = null;      // hold being placed or edited
  let els = null;        // live controls of the draft form
  const objectUrls = [];

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

  // A new hold from `file`, in the middle of the main panel.
  async function start(file) {
    const img = await loadFile(file);
    if (!img || ctx.stale()) return;
    const x = round2(spec.width / 2);
    const y = round2(spec.height / 2);
    draft = {
      holdId: null, src: img.src, blob: img.blob, transparent: img.transparent, isImage: true,
      x, y, size: DEFAULT_SIZE, rotation: 0, color: '', name: '', nameTouched: false,
    };
    draft.name = suggestName(nearest(x, y).letter);
    tab.select(null);
    tab.show();
  }

  // A hold on the wall, with a new image from `file` if given.
  async function edit(hold, file) {
    const img = file ? await loadFile(file) : null;
    if ((file && !img) || ctx.stale()) return;
    draft = {
      holdId: hold.id, original: hold,
      src: img ? img.src : hold.image_url, blob: img ? img.blob : null,
      transparent: img ? img.transparent : true, isImage: !!(img || hold.image_url),
      x: hold.x, y: hold.y, size: hold.size, rotation: hold.rotation,
      color: hold.color || '', name: hold.name, nameTouched: false,
    };
    tab.show();
  }

  function moveDraft(x, y) {
    const [cx, cy] = clampToPanels(x, y);
    draft.x = round2(cx);
    draft.y = round2(cy);
    sync();
  }

  function panel() {
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
        onInput: () => { draft.size = Number(size.value); sync(); } });
      els.sizeLabel = h('span', { class: 'range-value' });
      els.rotation = h('input', { type: 'range', min: -180, max: 180, step: 1, value: draft.rotation, 'aria-label': 'Rotation',
        onInput: () => { draft.rotation = Number(els.rotation.value); sync(); } });
      els.rotationLabel = h('span', { class: 'range-value' });
      const rotateBy = (deg) => {
        draft.rotation = ((draft.rotation + deg + 540) % 360) - 180;
        sync();
      };

      const color = colorField(ctx, { value: draft.color, onChange: (v) => { draft.color = v; sync(); } });

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
      onInput: () => { draft.name = els.name.value; draft.nameTouched = true; sync(); },
    });
    const dice = h('button', {
      type: 'button', class: 'btn btn-icon', title: 'Suggest another name', 'aria-label': 'Suggest another name',
      onClick: () => {
        draft.name = suggestName(nearest(draft.x, draft.y).letter, draft.name);
        draft.nameTouched = false;
        sync();
      },
    }, icon('dice', { size: 18 }));
    els.nameHint = h('span', { class: 'field-hint' });
    els.save = h('button', { type: 'submit', class: 'btn btn-primary' }, isNew ? 'Add to wall' : 'Save changes');

    return h('form', { class: 'editor', onSubmit: save },
      h('button', { type: 'button', class: 'back-link', onClick: cancel }, icon('arrow-left', { size: 15 }), 'Cancel'),
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
        h('button', { type: 'button', class: 'btn', onClick: cancel }, 'Cancel'),
        els.save));
  }

  // Pushes the draft's state to the board, the preview and the form readouts.
  function sync() {
    const n = nearest(draft.x, draft.y);
    if (!draft.nameTouched && !startsWithLetter(draft.name, n.letter)) draft.name = suggestName(n.letter);
    board.setDraft({
      src: draft.isImage ? draft.src : null,
      x: draft.x, y: draft.y, size: draft.size, rotation: draft.rotation,
      color: draft.color, nearest: n.side ? null : n,
    });

    // Where the name's letter comes from: the side panel, the column on the
    // ceiling, or the t-nut's column.
    const panelName = n.side && n.label.toLowerCase();
    let why = `the nearest column is ${n.column}`;
    let source = `column ${n.column}`;
    let where = [h('strong', {}, `Nearest t-nut ${n.label}`), h('span', { class: 'muted' }, n.dist < 0.05 ? ' · on the t-nut' : ` · ${inches(n.dist)} off-grid`)];
    if (n.side) {
      why = `it’s on the ${panelName}`;
      source = `the ${panelName}`;
      where = [h('strong', {}, `On the ${panelName}`), h('span', { class: 'muted' }, ' · no t-nuts')];
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

  function cancel() {
    draft = null;
    tab.show();
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
    }
    if (draft.blob) form.set('image', draft.blob, 'hold.png');
    try {
      const saved = draft.holdId ? await ctx.api.updateHold(draft.holdId, form) : await ctx.api.createHold(form);
      await ctx.refreshHolds();
      ctx.toast(draft.holdId ? `Saved ${saved.name}.` : `${saved.name} added ${saved.offset == null ? `on the ${saved.grid.charAt(0).toLowerCase()}${saved.grid.slice(1)}` : `near ${saved.grid}`}.`, 'success');
      draft = null;
      tab.select(state.holdById.get(saved.id));
      tab.show();
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  // Arrow keys nudge the hold (Shift for 1").
  function onKey(e) {
    const step = e.shiftKey ? 1 : NUDGE;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!delta) return;
    e.preventDefault();
    moveDraft(draft.x + delta[0], draft.y + delta[1]);
  }

  return {
    get active() {
      return draft != null;
    },
    // The hold being edited, which the board hides while its draft shows.
    get holdId() {
      return draft?.holdId ?? null;
    },
    start,
    edit,
    panel,
    sync,
    onKey,
    // A press or drag on the wall puts the hold there.
    onWallPointer(type, point) {
      moveDraft(point.x, point.y);
    },
    destroy() {
      objectUrls.forEach((u) => URL.revokeObjectURL(u));
    },
  };
}
