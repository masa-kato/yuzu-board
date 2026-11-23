// What the Wall tab (views/holds.js) and its tools (placement.js, recolor.js,
// volumes.js) share: number formats, small pieces of the panel, and where a
// point is on the wall.

import { boardImage, tintFilter } from '../../board.js';
import { colorName } from '../../palette.js';
import { h, svg } from '../../ui.js';

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const round2 = (v) => Math.round(v * 100) / 100;
export const inches = (n) => `${(Math.round(n * 10) / 10).toFixed(1)}"`;

let thumbSeq = 0;
export function thumb(hold, size = 40) {
  if (!hold.image_url) return h('span', { class: 'thumb thumb-proxy', style: `width:${size}px;height:${size}px` });
  const id = `tint-thumb-${++thumbSeq}`;
  return svg('svg', { class: 'thumb', viewBox: '-1 -1 2 2', width: size, height: size, 'aria-hidden': 'true' },
    svg('defs', {}, tintFilter(id, hold.color)),
    svg('g', { transform: `rotate(${hold.rotation})` },
      svg('image', { href: boardImage(hold), x: -0.92, y: -0.92, width: 1.84, height: 1.84, preserveAspectRatio: 'xMidYMid meet', filter: `url(#${id})` })));
}

export function colorLabel(hold, colors) {
  if (!hold.color) return h('span', { class: 'muted' }, 'Original colors');
  const name = colorName(colors, hold.color);
  return h('span', { class: 'color-label' },
    h('span', { class: 'color-swatch', style: `background:${hold.color}` }),
    `${name ? `${name} ` : ''}${hold.color.toUpperCase()}`);
}

export function uploadButton(label, onFile, cls = 'btn btn-primary') {
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

// The wall's panels and t-nuts (/api/board) as the tools need them.
export function wallGeometry(spec) {
  // The wall's panels as [left, top, right, bottom] in wall inches.
  const { sides, ceiling } = spec;
  const panelBoxes = {
    main: [0, 0, spec.width, spec.height],
    foot: [0, spec.foot.top, spec.width, spec.total_height],
    left: [sides.left_x, sides.top, sides.left_x + sides.width, sides.top + sides.height],
    right: [sides.right_x, sides.top, sides.right_x + sides.width, sides.top + sides.height],
    ceiling: [0, ceiling.top, spec.width, ceiling.top + ceiling.height],
  };

  // What a point is nearest: a t-nut (its place, label, and the letter a
  // hold's name there starts with), or the side panel or ceiling column it's on.
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
    const letter = column.replace('′', '').slice(-1);
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

  return { nearest, clampToPanels };
}
