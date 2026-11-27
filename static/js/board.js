// SVG rendering of the wall. Units are inches, straight from /api/board.
// Zooming and panning it are viewport.js's.

import { api } from './api.js';
import { PHONE, ROLES, TOUCH, h, svg } from './ui.js';
import { createViewport, maxZoom } from './viewport.js';

const MARGIN = 4.5;     // room around the wall for the grid labels
// Touch screens draw the holds from ready-made images (hold_images.py board_variant)
// instead of SVG filters, which phones redraw slowly whenever the wall
// changes: one image per hold with its white border (so it widens as you
// zoom) and its color at the slider's opacity baked in. Their black shapes
// find the bolt holes they cover, instead of a mask.
const LIGHT = TOUCH.matches;
const VERTEX_PX = 6;    // volume corner handles: radius on screen, in CSS pixels
const HOLD_R = 0.8;     // proxy hold circle
const RING_R = 1.3;     // picked / hover highlight; t-nuts are 3" apart so rings never touch
const HIT_R = 1.45;     // invisible click target, with a mouse
// A tap on a touch screen picks the hold it lands on or, failing that, the
// nearest within this many CSS pixels of it (holdNear).
const TAP_SLOP_PX = 16;
const HOLE_R = 0.28;    // the wall's bolt holes
const OUTLINE_WIDTH = 0.45;
const BORDER_PX = 0.75;  // the thin white border around every hold, on screen in CSS pixels
const BORDER_OPACITY = 0.9;
// The ring around a hold on the problem, on screen in CSS pixels from the
// hold's edge outward: a dark gap, so the ring never merges with the hold's own
// color, then the ring in the role color (app.css). Hands get a bold ring and
// feet a thin one; start and finish add a second ring, so roles differ in
// shape as well as color.
const RING_BANDS = {
  start: [1, 2, 1, 1.5],
  hand: [1, 3],
  foot: [1, 1.5],
  finish: [1, 2, 1, 1.5],
};
// On phones, where the board is small, every role gets the same single thin
// ring instead (and the key in app.css matches).
const PHONE_RING_BANDS = [1, 1];

// Outlines for picked and hovered image holds: [color, opacity].
const OUTLINES = {
  picked: ['#ffffff', 1],
  hover: ['#ffffff', 0.55],
};

function toRoleMap(holds) {
  if (holds instanceof Map) return new Map(holds);
  return new Map((holds || []).map((h) => [h.hold_id, h.role]));
}

export function holdTitle(hold) {
  return hold.removed ? `${hold.name} (removed)` : hold.name;
}

// A hold's image sized for the board on this screen (hold_images.py makes it from the
// upload), a fraction of the original's pixels but still sharp at the closest zoom.
export const boardImage = (hold) => hold.board_url || hold.image_url;

// Image pixels per inch of hold this screen needs for that: phones, which stop
// at 4×, need fewer than a laptop at 6×. The board is never wider than the
// screen's short side.
export function imagePpi(spec) {
  const shortSide = Math.min(screen.width, screen.height);
  return Math.ceil((shortSide * (window.devicePixelRatio || 1) * maxZoom()) / (spec.max_x - spec.min_x + 2 * MARGIN));
}

// Every hold's color shows at one shared opacity, set by the slider
// under the board (75% unless changed) and remembered in this browser. The
// key is new with the 75% default, so a setting saved under the old 100%
// default (homewall.holdOpacity) starts over once.
const OPACITY_KEY = 'homewall.colorOpacity';
const DEFAULT_OPACITY = 0.75;
let tintOpacity = readOpacity();

// The Stats tab draws each hold in gray under its usage color (heatFilter).
// The same slider then sets how much of the gray hold shows through, 30%
// unless changed, also remembered in this browser.
const HEAT_VISIBILITY_KEY = 'homewall.heatVisibility';
const DEFAULT_HEAT_VISIBILITY = 0.3;
let heatVisibility = readFraction(HEAT_VISIBILITY_KEY, DEFAULT_HEAT_VISIBILITY);

function readFraction(key, fallback) {
  try {
    const saved = localStorage.getItem(key);
    const v = saved == null ? NaN : Number(saved);
    return v >= 0 && v <= 1 ? v : fallback;
  } catch {
    return fallback;
  }
}

function storeFraction(key, v) {
  try {
    localStorage.setItem(key, String(v));
  } catch {
    // Storage unavailable (private mode); the setting just won't persist.
  }
}

function readOpacity() {
  try {
    localStorage.removeItem('homewall.holdOpacity');
  } catch {
    // Storage unavailable: nothing old to clear.
  }
  return readFraction(OPACITY_KEY, DEFAULT_OPACITY);
}

export const holdOpacity = () => tintOpacity;

// Changes every hold color on the page at once: the board, the hold being
// placed, and the Wall tab's thumbnails and preview.
export function setHoldOpacity(v) {
  tintOpacity = Math.min(1, Math.max(0, v));
  storeFraction(OPACITY_KEY, tintOpacity);
  document.querySelectorAll('filter.hold-tint').forEach((f) => updateTint(f, f.dataset.color || null));
}

function setHeatVisibility(v) {
  heatVisibility = Math.min(1, Math.max(0, v));
  storeFraction(HEAT_VISIBILITY_KEY, heatVisibility);
  document.querySelectorAll('filter.heat-tint feFlood').forEach((f) => f.setAttribute('flood-opacity', 1 - heatVisibility));
}

// The hold in gray, so its own color never mixes with `color`, and `color`
// laid over it at 1 − heatVisibility: flat color at 0, the gray hold at 1.
function heatFilter(id, color) {
  return svg('filter', { id, class: 'heat-tint', x: 0, y: 0, width: 1, height: 1, 'color-interpolation-filters': 'sRGB' },
    svg('feColorMatrix', { type: 'saturate', values: 0, result: 'gray' }),
    svg('feFlood', { 'flood-color': color, 'flood-opacity': 1 - heatVisibility }),
    svg('feComposite', { in2: 'gray', operator: 'atop' }));
}

// A filter that lays `color` over the opaque pixels of whatever it is applied
// to, at the shared opacity. Transparent areas of the PNG stay transparent.
export function tintFilter(id, color) {
  const filter = svg('filter', { id, class: 'hold-tint', x: 0, y: 0, width: 1, height: 1, 'color-interpolation-filters': 'sRGB' },
    svg('feFlood', { result: 'tint' }),
    svg('feComposite', { in: 'tint', in2: 'SourceGraphic', operator: 'atop' }));
  updateTint(filter, color);
  return filter;
}

export function updateTint(filter, color) {
  filter.dataset.color = color || '';
  const flood = filter.querySelector('feFlood');
  flood.setAttribute('flood-color', color || '#000000');
  flood.setAttribute('flood-opacity', color ? tintOpacity : 0);
}

// Grows the alpha channel and paints it in a color behind the source, giving
// an outline that hugs the shape of the hold image.
function outlineFilter(name, [color, opacity]) {
  return svg('filter', { id: `outline-${name}`, x: '-30%', y: '-30%', width: '160%', height: '160%', 'color-interpolation-filters': 'sRGB' },
    svg('feMorphology', { in: 'SourceAlpha', operator: 'dilate', radius: OUTLINE_WIDTH, result: 'grown' }),
    svg('feFlood', { 'flood-color': color, 'flood-opacity': opacity }),
    svg('feComposite', { in2: 'grown', operator: 'in', result: 'ring' }),
    svg('feMerge', {}, svg('feMergeNode', { in: 'ring' }), svg('feMergeNode', { in: 'SourceGraphic' })));
}

// Wraps a hold's image in the thin white border (#hold-border, made in createBoard).
const bordered = (el) => svg('g', { class: 'hold-look', filter: 'url(#hold-border)' }, el);

// A LIGHT hold's ready-made image: `suffix` is s, or o<border px> and/or
// t<rrggbb><opacity %>.
const variantUrl = (hold, suffix) => hold.board_url.replace(/\.png$/, `-${suffix}.png`);

// Grid lines over a volume show at this fraction of their normal strength.
const GRID_ON_VOLUME = 0.5;

// Gradients and the drop shadow that make volumes read as raised wood.
function volumeDefs() {
  // Stop colors go through `style` so CSS custom properties (the palette) apply.
  const gradient = (id, top, bottom) => svg('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 },
    svg('stop', { offset: 0, style: `stop-color: ${top}` }), svg('stop', { offset: 1, style: `stop-color: ${bottom}` }));
  return [
    gradient('volume-black', 'var(--volume-black-top)', 'var(--volume-black-bottom)'),
    gradient('volume-green', 'var(--volume-green-top)', 'var(--volume-green-bottom)'),
    svg('filter', { id: 'volume-shadow', x: '-20%', y: '-20%', width: '140%', height: '140%' },
      svg('feDropShadow', { dx: 0.3, dy: 0.45, stdDeviation: 0.4, 'flood-color': '#000', 'flood-opacity': 0.75 })),
  ];
}

const pointsAttr = (points) => points.map(([x, y]) => `${x},${y}`).join(' ');

// Where a horizontal (`along` 0) or vertical (`along` 1) line at `at` runs
// inside any of `polygons`: sorted, merged [from, to] stretches along it.
function insideRuns(along, at, polygons) {
  const across = 1 - along;
  const runs = [];
  for (const poly of polygons) {
    const hits = [];
    poly.forEach((p, i) => {
      const q = poly[(i + 1) % poly.length];
      // Half-open, so a line through a corner crosses there once.
      if ((p[across] > at) !== (q[across] > at)) {
        hits.push(p[along] + ((at - p[across]) * (q[along] - p[along])) / (q[across] - p[across]));
      }
    });
    hits.sort((a, b) => a - b);
    for (let i = 0; i + 1 < hits.length; i += 2) runs.push([hits[i], hits[i + 1]]);
  }
  runs.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [from, to] of runs) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

// Plywood grain: noise stretched along x, rendered once as an image tile
// (cheap to repaint) and repeated across both panels at low opacity.
const GRAIN_TILE = `data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='600' height='150'>"
  + "<filter id='g' x='0' y='0' width='100%' height='100%'>"
  + "<feTurbulence type='fractalNoise' baseFrequency='0.0025 0.05' numOctaves='2' seed='7' stitchTiles='stitch'/>"
  + "<feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  1.5 0 0 0 -0.55'/></filter>"
  + "<rect width='600' height='150' filter='url(#g)'/></svg>",
)}`;

// The wall's panels: the main panel, the footboard below it, the two side
// panels beside it and the ceiling above it (these three have no t-nuts), each
// with class `cls` if given.
function panelRects(spec, cls) {
  const { width: W, height: H, foot, sides, ceiling } = spec;
  const rect = (kind, x, y, width, height) => svg('rect', { class: cls && [cls, kind].filter(Boolean).join(' '), x, y, width, height, rx: 0.75 });
  return [
    rect(null, 0, 0, W, H),
    rect('footboard', 0, foot.top, W, foot.height),
    rect('side-panel', sides.left_x, sides.top, sides.width, sides.height),
    rect('side-panel', sides.right_x, sides.top, sides.width, sides.height),
    rect('ceiling', 0, ceiling.top, W, ceiling.height),
  ];
}

// Materials: the wood grain, and resin-like placeholder holds with a soft
// shadow.
function materialDefs(spec) {
  const radial = (id, stops) => svg('radialGradient', { id, cx: '38%', cy: '32%', r: '75%' },
    stops.map(([offset, color]) => svg('stop', { offset, style: `stop-color: ${color}` })));
  return [
    svg('pattern', { id: 'wood', patternUnits: 'userSpaceOnUse', width: 60, height: 15 },
      svg('image', { href: GRAIN_TILE, width: 60, height: 15, preserveAspectRatio: 'none' })),
    svg('clipPath', { id: 'wall-clip' }, panelRects(spec)),
    radial('hold-resin', [[0, 'var(--hold-hi)'], [0.55, 'var(--hold)'], [1, 'var(--hold-lo)']]),
    radial('hold-resin-on', [[0, '#ffffff'], [0.6, 'var(--hold-on)'], [1, 'var(--hold-on-lo)']]),
    svg('filter', { id: 'hold-shadow', x: '-60%', y: '-60%', width: '220%', height: '220%' },
      svg('feDropShadow', { dx: 0, dy: 0.14, stdDeviation: 0.13, 'flood-color': '#000', 'flood-opacity': 0.7 })),
  ];
}

// `zoomHost` is where the zoom control goes (off the board); defaults to `container`.
export function createBoard(container, spec, holds, { onHoldClick, onHoldHover, onWallPointer, zoomHost } = {}) {
  const { width: W, height: H, foot, ceiling } = spec;
  // The drawing reaches past the side panels and above the ceiling, with room for the labels.
  const minX = spec.min_x - MARGIN;
  const minY = spec.min_y - MARGIN;
  const viewW = spec.max_x - spec.min_x + 2 * MARGIN;
  const viewH = spec.total_height - spec.min_y + 2 * MARGIN;
  const root = svg('svg', {
    class: 'board',
    viewBox: `${minX} ${minY} ${viewW} ${viewH}`,
    role: 'img',
    'aria-label': `Climbing wall: main panel with ${spec.cols} by ${spec.rows} t-nuts, footboard with ${foot.cols} by ${foot.rows}, a side panel either side and a ceiling above, with none`,
  });

  // LIGHT: the board in three layers, moved alike by the zoom: the wall
  // (`wallLayer`), every hold on it as one picture the server draws
  // (refreshPicture), and `root` over them, with the holds that need to be
  // drawn one by one (on the problem, picked; all of them while the picture
  // can't be used) and everything that changes. Fading the holds off a
  // problem fades the picture, which phones do without drawing anything again.
  const wallLayer = LIGHT ? svg('svg', { class: 'board board-wall', viewBox: `${minX} ${minY} ${viewW} ${viewH}`, 'aria-hidden': 'true' }) : null;
  let pictureImg = LIGHT ? h('img', { alt: '', draggable: 'false' }) : null;
  const picture = LIGHT ? h('div', { class: 'holds-picture', hidden: true }, pictureImg) : null;
  const layers = [wallLayer, picture, root].filter(Boolean);

  // The grid and the bolt holes stop at the volumes and the holds by geometry
  // worked out when those change (drawGrid(), drawHoles()), not by masks: a
  // mask the size of the wall is drawn all over again at every zoom.
  const defs = svg('defs', {}, Object.entries(OUTLINES).map(([name, c]) => outlineFilter(name, c)), volumeDefs(), materialDefs(spec));
  const tintDefs = svg('defs');
  const heatDefs = svg('defs');   // one heatFilter per usage color (setHeat)

  // The grid's lines as [along, at, from, to] (see insideRuns), each drawn in
  // stretches: at full strength off the volumes (`grid`) and at GRID_ON_VOLUME
  // on them (`gridOnVolumes`). Each stretch keeps its line's dashes in step.
  const footBottom = foot.top + foot.height;
  const ceilingBottom = ceiling.top + ceiling.height;
  const gridSpans = [
    ...spec.col_x.map((x) => [1, x, 0, H]),
    // The columns carry on across the ceiling (which has no rows or holes).
    ...spec.col_x.map((x) => [1, x, ceiling.top, ceilingBottom]),
    ...spec.row_y.map((y) => [0, y, 0, W]),
    // Footboard: its own grid, confined to the footboard.
    ...foot.col_x.map((x) => [1, x, foot.top, footBottom]),
    ...foot.row_y.map((y) => [0, y, 0, W]),
  ];
  const grid = svg('g', { class: 'grid' });
  const gridOnVolumes = svg('g', { class: 'grid grid-on-volume', opacity: GRID_ON_VOLUME });
  function drawGrid(polygons) {
    const off = [];
    const on = [];
    const stretch = (along, at, from, a, b) => svg('line', {
      ...(along ? { x1: at, y1: a, x2: at, y2: b } : { x1: a, y1: at, x2: b, y2: at }),
      'stroke-dashoffset': a - from || null,
    });
    for (const [along, at, from, to] of gridSpans) {
      let start = from;
      for (const [a, b] of insideRuns(along, at, polygons)) {
        const lo = Math.max(a, start);
        const hi = Math.min(b, to);
        if (hi <= lo) continue;
        if (lo > start) off.push(stretch(along, at, from, start, lo));
        on.push(stretch(along, at, from, lo, hi));
        start = hi;
      }
      if (to > start) off.push(stretch(along, at, from, start, to));
    }
    grid.replaceChildren(...off);
    gridOnVolumes.replaceChildren(...on);
  }
  drawGrid([]);

  // The wall's bolt holes, as one path. The main panel's are staggered: row 1
  // has them in columns A, C, E…, row 2 in B, D, F…, and so on (wherever the
  // column and row indexes add up to an even number). The footboard has one at
  // every intersection. Volumes cover holes, and so does every hold on the
  // wall, even one drawn faded: drawHoles() leaves those out.
  const hole = (x, y) => `M${x - HOLE_R},${y}a${HOLE_R},${HOLE_R} 0 1,0 ${2 * HOLE_R},0a${HOLE_R},${HOLE_R} 0 1,0 ${-2 * HOLE_R},0`;
  const holeSpots = [];
  spec.col_x.forEach((x, c) => spec.row_y.forEach((y, r) => {
    if ((c + r) % 2 === 0) holeSpots.push([x, y]);
  }));
  foot.col_x.forEach((x) => foot.row_y.forEach((y) => holeSpots.push([x, y])));
  // The black shapes of the holds over a volume (#hole-mask), so they hide its
  // lines even when drawn faded: coverVolumeLines().
  const holeCovers = svg('g');
  // The white border around every hold: the shape grown by a ring, kept to the
  // outside of the hold. Browsers grow a shape only by whole screen pixels, so
  // a border of, say, 1.5 pixels is a solid inner pixel plus an outer one at
  // half strength. sizeOutlines() sets both for the zoom and the screen.
  const borderInner = svg('feMorphology', { in: 'SourceAlpha', operator: 'dilate', radius: 0.1, result: 'inner' });
  const borderOuter = svg('feMorphology', { in: 'SourceAlpha', operator: 'dilate', radius: 0.2, result: 'outer' });
  const innerFlood = svg('feFlood', { 'flood-color': '#ffffff', 'flood-opacity': BORDER_OPACITY });
  const outerFlood = svg('feFlood', { 'flood-color': '#ffffff', 'flood-opacity': 0 });
  // A hold on the problem shows its role's ring (RING_BANDS) in place of its
  // white border. The ring is drawn on its own layer from the hold's shape:
  // the dark fill out to the last gap, then each ring between its gap and its
  // outer edge. sizeOutlines() keeps every band a fixed width on screen. The
  // region is generous, as small holds are only a few pixels across when the
  // whole wall is in view. The color comes from app.css through `style`.
  const ringGrows = [];   // per role: [role, a dilation for each band's outer edge]
  function ringFilter(role) {
    const grows = RING_BANDS[role].map((_, i) => svg('feMorphology', { in: 'SourceAlpha', operator: 'dilate', radius: 0.1, result: `edge${i}` }));
    ringGrows.push([role, grows]);
    const ringBands = grows.map((_, i) => i).filter((i) => i % 2 === 1);   // the gaps are the others
    return svg('filter', { id: `ring-${role}`, x: '-200%', y: '-200%', width: '500%', height: '500%', 'color-interpolation-filters': 'sRGB' },
      grows,
      svg('feFlood', { 'flood-color': '#0b0b0c', 'flood-opacity': 0.7 }),
      svg('feComposite', { in2: `edge${grows.length - 2}`, operator: 'in', result: 'gap-fill' }),
      ringBands.map((i) => [
        svg('feFlood', { style: `flood-color: var(--${role})` }),
        svg('feComposite', { in2: `edge${i}`, operator: 'in' }),
        svg('feComposite', { in2: `edge${i - 1}`, operator: 'out', result: `ring${i}` }),
      ]),
      svg('feMerge', {}, svg('feMergeNode', { in: 'gap-fill' }), ringBands.map((i) => svg('feMergeNode', { in: `ring${i}` }))));
  }
  defs.append(
    svg('filter', { id: 'hold-border', x: '-20%', y: '-20%', width: '140%', height: '140%', 'color-interpolation-filters': 'sRGB' },
      borderInner,
      borderOuter,
      outerFlood,
      svg('feComposite', { in2: 'outer', operator: 'in', result: 'outer-fill' }),
      innerFlood,
      svg('feComposite', { in2: 'inner', operator: 'in', result: 'inner-fill' }),
      svg('feMerge', { result: 'grown' }, svg('feMergeNode', { in: 'outer-fill' }), svg('feMergeNode', { in: 'inner-fill' })),
      svg('feComposite', { in: 'grown', in2: 'SourceAlpha', operator: 'out', result: 'ring' }),
      svg('feMerge', {}, svg('feMergeNode', { in: 'ring' }), svg('feMergeNode', { in: 'SourceGraphic' }))),
    ...ROLES.map(ringFilter),
    svg('mask', { id: 'hole-mask', maskUnits: 'userSpaceOnUse', x: minX, y: minY, width: viewW, height: viewH },
      svg('rect', { x: minX, y: minY, width: viewW, height: viewH, fill: '#fff' }), holeCovers));
  const holesPath = svg('path');
  const holes = svg('g', { class: 'wall-holes' }, holesPath);
  let holdHoles = new Set();     // indexes into holeSpots of the holes under a hold (updateHoles)
  let volumeHoles = new Set();   // and of those under a volume (setVolumes)
  function drawHoles() {
    holesPath.setAttribute('d', holeSpots.filter((_, i) => !holdHoles.has(i) && !volumeHoles.has(i)).map(([x, y]) => hole(x, y)).join(''));
  }
  drawHoles();

  // Label elements are kept per panel and index so the nearest row and
  // column can be highlighted while a hold is being placed.
  const labels = svg('g', { class: 'labels' });
  const colLabelEls = { main: [], foot: [] };
  const rowLabelEls = { main: [], foot: [] };
  // Row numbers sit just outside the panels at their height: past the side
  // panels for the main panel's rows, beside the footboard for its own.
  const rowLabels = (panel, ys, texts, [left, right]) => ys.forEach((y, i) => {
    rowLabelEls[panel][i] = [
      svg('text', { x: left - 1.2, y, 'text-anchor': 'end', 'dominant-baseline': 'central' }, texts[i]),
      svg('text', { x: right + 1.2, y, 'text-anchor': 'start', 'dominant-baseline': 'central' }, texts[i]),
    ];
    labels.append(...rowLabelEls[panel][i]);
  });
  // The column letters go above the ceiling, which the columns cross.
  spec.col_x.forEach((x, i) => {
    colLabelEls.main[i] = [svg('text', { x, y: ceiling.top - 1.5, 'text-anchor': 'middle' }, spec.col_labels[i])];
    labels.append(...colLabelEls.main[i]);
  });
  rowLabels('main', spec.row_y, spec.row_labels, [spec.min_x, spec.max_x]);
  // The main panel sits above the footboard, so its column letters go underneath.
  foot.col_x.forEach((x, i) => {
    colLabelEls.foot[i] = [svg('text', { x, y: footBottom + 1.1, 'text-anchor': 'middle', 'dominant-baseline': 'hanging' }, foot.col_labels[i])];
    labels.append(...colLabelEls.foot[i]);
  });
  rowLabels('foot', foot.row_y, foot.row_labels, [0, W]);

  // While placing a hold: soft guide lines along the nearest column and row (under the holds).
  const nearGuides = svg('g', { class: 'near-guides' });
  let nearLabels = [];

  const volumeLayer = svg('g', { class: 'volumes' });
  // Volume borders: drawn over the grid and holes but under the holds, and
  // masked by the holds' silhouettes, so a hold on top hides the border (even
  // one drawn faded).
  const volumeEdges = svg('g', { class: 'volume-edges', mask: 'url(#hole-mask)' });
  // Volume faces: thin lines inside each volume, clipped to it. Holds on top
  // hide them as they do the border, and #edge-mask cuts them away under the
  // border itself, so a face along the outline never makes that edge thicker.
  // The group carries the opacity, so an edge shared by two faces looks like one.
  const faceLines = svg('g', { mask: 'url(#edge-mask)' });
  const volumeFaces = svg('g', { class: 'volume-faces', mask: 'url(#hole-mask)' }, faceLines);
  const edgeMaskLines = svg('g');   // every volume border, in black
  const faceClips = svg('g');       // a clipPath per volume with faces
  defs.append(
    svg('mask', { id: 'edge-mask', maskUnits: 'userSpaceOnUse', x: minX, y: minY, width: viewW, height: viewH },
      svg('rect', { x: minX, y: minY, width: viewW, height: viewH, fill: '#fff' }), edgeMaskLines),
    faceClips);
  const holdLayer = svg('g', { class: 'holds' });
  const draftLayer = svg('g', { class: 'draft-layer' });
  const volumeDraftLayer = svg('g', { class: 'volume-draft-layer' });
  const wallParts = [
    ...panelRects(spec, 'wall'),
    svg('g', { class: 'wall-grain', 'clip-path': 'url(#wall-clip)' },
      svg('rect', { x: spec.min_x, y: spec.min_y, width: spec.max_x - spec.min_x, height: spec.total_height - spec.min_y, fill: 'url(#wood)' })),
    volumeLayer,
    grid, gridOnVolumes, holes, volumeFaces, volumeEdges, nearGuides,
    labels];
  if (LIGHT) wallLayer.append(...wallParts);
  root.append(defs, tintDefs, heatDefs, ...(LIGHT ? [] : wallParts), holdLayer, draftLayer, volumeDraftLayer);
  container.replaceChildren(...layers);
  container.parentElement.style.setProperty('--board-ratio', viewW / viewH);

  const nodes = new Map();
  const covers = new Map();   // hold id -> its silhouette in the hole mask
  let shownVolumes = [];      // the volumes drawn: all but one being reshaped (setVolumes)
  const rings = new Map();   // hold id -> its role ring, made the first time it's on a problem
  // The role rings, drawn inside holdLayer between the holds off the problem
  // and the holds on it (paint()).
  const ringLayer = svg('g', { class: 'role-rings' });
  let holdById = new Map();
  let roles = new Map();
  let preview = null;
  let dimOthers = true;
  let spotlit = null;       // the one role shown at full strength, or null for all of them
  let picked = new Set();   // ids of the holds outlined as picked
  let hiddenId = null;
  let lit = null;           // ids of the holds kept bright while every other is dimmed (setLit), or null
  let heat = null;          // hold id -> usage color, while the Stats tab shows them (setHeat)
  let heatIds = new Map();  // usage color -> its filter's id
  const looks = new Map();  // LIGHT holds: id -> their images ({ image, rim }) and looks (lightLooks)

  // LIGHT: a hold's two looks, plain and bordered, both with its color baked
  // in at the slider's opacity (to the nearest 5%, so they're shared). The
  // border is BORDER_PX wide on screen at 1× (the board copy is drawn `px`
  // pixels across the hold's size).
  const inchesPerPx = viewW / (container.getBoundingClientRect().width || 360);
  function lightLooks(hold) {
    const px = Number(/-(\d+)\.png$/.exec(hold.board_url)[1]);
    const b = Math.min(24, Math.max(1, Math.round((BORDER_PX * inchesPerPx * px) / hold.size)));
    const percent = Math.round(tintOpacity * 20) * 5;
    const tint = hold.color && percent ? `t${hold.color.slice(1)}${percent}` : '';
    return {
      plain: { href: tint ? variantUrl(hold, tint) : hold.board_url, s: hold.size },
      bordered: { href: variantUrl(hold, `o${b}${tint}`), s: (hold.size * (px + 2 * b)) / px },
      // Under the Stats tab's usage colors: the untinted image (their filter
      // colors it) over its white border, as the border filter does otherwise.
      bare: { href: hold.board_url, s: hold.size },
      edge: { href: variantUrl(hold, `o${b}`), s: (hold.size * (px + 2 * b)) / px },
    };
  }

  // A new opacity (once the slider is let go) means new LIGHT images, and a
  // new picture.
  function retint() {
    for (const [id, look] of looks) {
      Object.assign(look, lightLooks(holdById.get(id)));
      setLook(id, nodes.get(id));
    }
    refreshPicture();
  }

  // Shows a LIGHT hold (node `g`) with its baked border, or plain while it's
  // on the problem, where its role ring replaces the border (as .hold-look's
  // filter does in app.css), or bare under the Stats tab's usage colors. A
  // hold drawn in the picture isn't drawn on its own, so its image isn't even
  // fetched. Only the holds whose look changes are touched.
  function setLook(id, g) {
    const look = looks.get(id);
    if (paintedPicture && !g.dataset.role && !g.classList.contains('picked') && !g.classList.contains('lit')) return;
    const show = (image, { href, s }) => {
      if (image.getAttribute('href') === href) return;
      for (const [k, v] of Object.entries({ href, x: -s / 2, y: -s / 2, width: s, height: s })) image.setAttribute(k, v);
    };
    show(look.image, heat ? look.bare : g.dataset.role ? look.plain : look.bordered);
    if (heat) show(look.rim, look.edge);
    look.rim.style.display = heat ? '' : 'none';
  }

  function holdNode(hold) {
    const classes = ['hold', hold.image_url && 'has-image', hold.removed && 'removed'].filter(Boolean).join(' ');
    const g = svg('g', { class: classes, 'data-id': hold.id, transform: `translate(${hold.x} ${hold.y})` },
      svg('title', {}, holdTitle(hold)));
    if (hold.image_url && LIGHT && hold.board_url) {
      const s = hold.size;
      const image = svg('image', { preserveAspectRatio: 'xMidYMid meet' });
      const rim = svg('image', { preserveAspectRatio: 'xMidYMid meet' });
      looks.set(hold.id, { ...lightLooks(hold), image, rim });
      setLook(hold.id, g);
      // A tap finds it by its place, not its art (holdNear).
      g.append(svg('g', { class: 'hold-art', transform: `rotate(${hold.rotation})` }, rim, image),
        svg('circle', { class: 'ghost-ring', r: s / 2 + 0.3 }));
    } else if (hold.image_url) {
      const s = hold.size;
      const image = svg('image', { href: boardImage(hold), x: -s / 2, y: -s / 2, width: s, height: s, preserveAspectRatio: 'xMidYMid meet' });
      if (hold.color) {
        const id = `tint-h${hold.id}`;
        tintDefs.append(tintFilter(id, hold.color));
        image.setAttribute('filter', `url(#${id})`);
      }
      g.append(svg('g', { class: 'hold-art', transform: `rotate(${hold.rotation})` }, bordered(image)),
        svg('circle', { class: 'ghost-ring', r: s / 2 + 0.3 }));
    } else {
      g.append(svg('circle', { class: 'hit', r: HIT_R }), svg('circle', { class: 'ring', r: RING_R }),
        svg('circle', { class: 'body', r: HOLD_R }), svg('circle', { class: 'ghost-ring', r: RING_R + 0.35 }));
    }
    return g;
  }

  // A hold's shape at its place on the wall: the PNG (or `href`, another copy
  // of it), or the placeholder circle. Only its opaque pixels matter, for the
  // hole mask and the role ring.
  function holdShape(hold, href = boardImage(hold)) {
    if (!hold.image_url) return svg('circle', { cx: hold.x, cy: hold.y, r: HOLD_R, fill: '#000' });
    const s = hold.size;
    return svg('g', { transform: `translate(${hold.x} ${hold.y}) rotate(${hold.rotation})` },
      svg('image', { href, x: -s / 2, y: -s / 2, width: s, height: s, preserveAspectRatio: 'xMidYMid meet' }));
  }

  // The hold in black (hold_images.py's "s" copy), for the hole mask.
  const holeCover = (hold) => holdShape(hold, hold.board_url ? variantUrl(hold, 's') : boardImage(hold));

  // The hole mask's black shapes: only the holds that may be over a volume
  // (by their bounding boxes), so it stays small. Touch screens leave it
  // empty, as phones redraw masks slowly.
  function coverVolumeLines() {
    covers.clear();
    if (LIGHT) return;
    const boxes = shownVolumes.map((v) => {
      const xs = v.points.map((p) => p[0]);
      const ys = v.points.map((p) => p[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    });
    const over = (hold) => {
      const r = hold.image_url ? hold.size * Math.SQRT1_2 : HOLD_R;   // reaches no further at any rotation
      return boxes.some(([left, top, right, bottom]) => hold.x + r > left && hold.x - r < right && hold.y + r > top && hold.y - r < bottom);
    };
    holeCovers.replaceChildren(...[...holdById.values()].filter((hold) => !hold.removed && over(hold)).map((hold) => {
      const cover = holeCover(hold);
      if (hold.id === hiddenId) cover.style.display = 'none';
      covers.set(hold.id, cover);
      return cover;
    }));
  }

  // The holes under a hold (on the wall, and not the one being moved), found
  // by drawing the holds' shapes small on a canvas once, rather than masking
  // the holes on every redraw. Touch screens fetch the black copies (they
  // don't load the holds' own images while the picture shows them); computers
  // use the images the board already has.
  const HOLE_CANVAS_PPI = 4;
  let coverToken = 0;
  async function coverHoles() {
    const token = ++coverToken;
    const shown = [...holdById.values()].filter((hold) => !hold.removed && hold.id !== hiddenId);
    const images = await Promise.all(shown.map((hold) => {
      if (!hold.image_url) return null;
      const img = new Image();
      img.src = LIGHT && hold.board_url ? variantUrl(hold, 's') : boardImage(hold);
      return img.decode().then(() => img, () => null);
    }));
    if (token !== coverToken) return;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewW * HOLE_CANVAS_PPI);
    canvas.height = Math.ceil(viewH * HOLE_CANVAS_PPI);
    const c = canvas.getContext('2d', { willReadFrequently: true });
    shown.forEach((hold, i) => {
      c.setTransform(HOLE_CANVAS_PPI, 0, 0, HOLE_CANVAS_PPI, -minX * HOLE_CANVAS_PPI, -minY * HOLE_CANVAS_PPI);
      c.translate(hold.x, hold.y);
      if (!hold.image_url) {
        c.beginPath();
        c.arc(0, 0, HOLD_R, 0, 2 * Math.PI);
        c.fill();
        return;
      }
      const img = images[i];
      if (!img) return;
      const k = hold.size / Math.max(img.width, img.height);   // drawn to fit its size, as on the board
      c.rotate((hold.rotation * Math.PI) / 180);
      c.drawImage(img, (-img.width * k) / 2, (-img.height * k) / 2, img.width * k, img.height * k);
    });
    const { data } = c.getImageData(0, 0, canvas.width, canvas.height);
    const covered = ([x, y]) => data[(Math.round((y - minY) * HOLE_CANVAS_PPI) * canvas.width + Math.round((x - minX) * HOLE_CANVAS_PPI)) * 4 + 3] > 127;
    holdHoles = new Set(holeSpots.flatMap((spot, i) => (covered(spot) ? [i] : [])));
    drawHoles();
  }

  // LIGHT: the picture of every hold on the wall, for the holds as they are
  // and the slider's opacity, at the pixels per inch this screen needs at its
  // closest zoom, or at most PICTURE_PPI's last: on a phone that's sharp to
  // about 2.5×, and a little soft closer up (the holds on a climb, drawn one
  // by one, stay sharp). Until the first one arrives no hold is drawn (so the phone
  // doesn't fetch every hold's image meanwhile); while a new one is on its way
  // after the holds change, they're drawn one by one; one for a new opacity
  // replaces the old when it's ready.
  const PICTURE_PPI = [12, 16, 20];
  let pictureState = 'loading';   // 'loading' (none yet), 'ready', 'stale' (holds changed) or 'failed'
  let pictureCovered = null;      // indexes into holeSpots of the holes under a hold in it
  let pictureToken = 0;
  let paintedPicture = LIGHT;     // whether paint() last drew the holds from the picture (and will at first)
  const usePicture = () => LIGHT && !heat && hiddenId == null && (pictureState === 'ready' || pictureState === 'loading');

  async function refreshPicture() {
    const token = ++pictureToken;
    const need = ((window.devicePixelRatio || 1) * maxZoom()) / inchesPerPx;
    const ppi = PICTURE_PPI.find((p) => p >= need) || PICTURE_PPI[PICTURE_PPI.length - 1];
    try {
      const pic = await api.holdsPicture({
        ppi,
        border: Math.min(16, Math.max(1, Math.round(BORDER_PX * inchesPerPx * ppi))),
        tint: Math.round(tintOpacity * 20) * 5,
      });
      const img = h('img', { alt: '', draggable: 'false', src: pic.url });
      await img.decode();
      if (token !== pictureToken) return;
      const pct = (v, of) => `${(v / of) * 100}%`;
      Object.assign(img.style, { left: pct(pic.x - minX, viewW), top: pct(pic.y - minY, viewH), width: pct(pic.width, viewW), height: pct(pic.height, viewH) });
      picture.replaceChildren(img);
      pictureImg = img;
      pictureCovered = new Set(pic.covered);
      pictureState = 'ready';
      holesFor = null;
    } catch {
      if (token !== pictureToken) return;
      pictureState = 'failed';
    }
    paint();
  }

  // The bolt holes left out of the path for the holds: on touch screens those
  // under a hold in the picture (still right under the Stats colors);
  // otherwise, or while the holds have changed since or one is being moved,
  // those under the holds as coverHoles() finds them.
  let holesFor = null;
  function updateHoles() {
    if (LIGHT && pictureState === 'loading') return;
    const fromPicture = LIGHT && pictureState === 'ready' && hiddenId == null;
    const key = fromPicture ? `picture ${pictureImg.src}` : `holds ${hiddenId}`;
    if (key === holesFor) return;
    holesFor = key;
    if (fromPicture) {
      holdHoles = pictureCovered;
      drawHoles();
    } else coverHoles();
  }

  // LIGHT: the wall and the picture follow `root`'s state (app.css fades the
  // volumes and the picture from it).
  function mirror() {
    if (!LIGHT) return;
    wallLayer.setAttribute('class', `${root.getAttribute('class')} board-wall`);
    wallLayer.dataset.mode = root.dataset.mode || '';
    picture.dataset.mode = root.dataset.mode || '';
    picture.classList.toggle('dim', root.classList.contains('dim'));
    picture.classList.toggle('instant', root.classList.contains('instant'));
    picture.hidden = !(paintedPicture && pictureState === 'ready');
  }

  function ringFor(id) {
    if (!rings.has(id)) rings.set(id, svg('g', { class: 'role-ring' }, holdShape(holdById.get(id))));
    return rings.get(id);
  }

  function paint() {
    const active = preview || roles;
    root.classList.toggle('dim', !!lit || (active.size > 0 && (preview ? true : dimOthers)));
    const pictureNow = usePicture();
    const pictureChanged = pictureNow !== paintedPicture;
    paintedPicture = pictureNow;
    root.classList.toggle('picture', pictureNow);
    const unlit = (role) => !!spotlit && !!role && role !== spotlit;
    for (const [id, g] of nodes) {
      const role = active.get(id);
      const lookChanged = pictureChanged || g.dataset.role !== role || g.classList.contains('picked') !== picked.has(id)
        || g.classList.contains('lit') !== (!!lit && lit.has(id));
      if (g.dataset.role !== role) {
        if (role) g.dataset.role = role;
        else delete g.dataset.role;
      }
      g.classList.toggle('unlit', unlit(role));
      g.classList.toggle('lit', !!lit && lit.has(id));
      g.classList.toggle('picked', picked.has(id));
      g.classList.toggle('editing', id === hiddenId);
      if (lookChanged && looks.has(id)) setLook(id, g);
    }
    const shownRings = [...active].filter(([id]) => holdById.has(id) && id !== hiddenId).map(([id, role]) => {
      const ring = ringFor(id);
      const filter = `url(#ring-${role})`;
      if (ring.getAttribute('filter') !== filter) ring.setAttribute('filter', filter);
      ring.classList.toggle('unlit', unlit(role));
      return ring;
    });
    // Nodes are only moved when their place changes: a moved node loses what
    // the browser has drawn for it, so it works out its filters all over
    // again. Going from one climb to the next moves just the holds of the two.
    const shown = new Set(shownRings);
    [...ringLayer.children].filter((ring) => !shown.has(ring)).forEach((ring) => ring.remove());
    let at = ringLayer.firstChild;
    for (const ring of shownRings) {
      if (ring === at) at = at.nextSibling;
      else ringLayer.insertBefore(ring, at);
    }
    // The holds on the problem are drawn last, and the rings just under them,
    // so a neighbour off the problem never covers a ring, and a hold on the
    // problem always shows over its neighbours' rings. Each group keeps the
    // wall's order.
    at = holdLayer.firstChild;
    for (const [id, g] of nodes) {
      if (active.get(id)) continue;
      // Step over holds just put on the problem; the next loop moves them.
      while (at !== ringLayer && active.get(Number(at.dataset.id))) at = at.nextSibling;
      if (g === at) at = at.nextSibling;
      else holdLayer.insertBefore(g, at);
    }
    at = ringLayer.nextSibling;
    for (const [id, g] of nodes) {
      if (!active.get(id)) continue;
      if (g === at) at = at.nextSibling;
      else holdLayer.insertBefore(g, at);
    }
    // The hold being moved uncovers its old hole.
    updateHoles();
    for (const [id, cover] of covers) {
      const display = id === hiddenId ? 'none' : '';
      if (cover.style.display !== display) cover.style.display = display;
    }
    mirror();
  }

  // Paints without the holds' fades (app.css), for a new page or climb: a
  // fade would repaint the wall on every frame while the page slides in.
  function paintNow() {
    root.classList.add('instant');
    paint();
    root.getBoundingClientRect();   // apply the new look while the fades are off
    root.classList.remove('instant');
    mirror();
  }

  function setHolds(list) {
    holdById = new Map(list.map((h) => [h.id, h]));
    nodes.clear();
    rings.clear();
    looks.clear();
    tintDefs.replaceChildren();
    ringLayer.replaceChildren();
    holdLayer.replaceChildren(...list.map((hold) => {
      const g = holdNode(hold);
      if (heat) applyHeat(hold, g);
      nodes.set(hold.id, g);
      return g;
    }), ringLayer);
    // Removed holds are off the wall, so their holes show again (paint()
    // updates them). The picture shows the holds as they were until a new
    // one comes.
    holesFor = null;
    if (LIGHT) {
      if (pictureState !== 'loading') pictureState = 'stale';
      refreshPicture();
    }
    coverVolumeLines();
    paint();
  }

  // A hold in its usage color, or as usual again once heat is off. The inline
  // filter wins over the image's own tint, which comes back when it's cleared.
  // The hold's name tooltip is blanked meanwhile: the Stats tab shows its own.
  function applyHeat(hold, g) {
    const color = heat && heat.get(hold.id);
    const image = looks.has(hold.id) ? looks.get(hold.id).image : g.querySelector('image');
    if (looks.has(hold.id)) setLook(hold.id, g);
    if (image) image.style.filter = color ? `url(#${heatIds.get(color)})` : '';
    else if (color) g.style.setProperty('--heat', color);
    else g.style.removeProperty('--heat');
    g.querySelector('title').textContent = heat ? '' : holdTitle(hold);
  }

  function setHeat(colors) {
    if (!heat && !colors) return;
    heat = colors;
    heatIds = new Map([...new Set(colors ? colors.values() : [])].map((color, i) => [color, `heat-${i}`]));
    heatDefs.replaceChildren(...[...heatIds].map(([color, id]) => heatFilter(id, color)));
    root.classList.toggle('heat', !!heat);
    if (LIGHT) paint();   // no picture under the usage colors
    for (const [id, g] of nodes) applyHeat(holdById.get(id), g);
    syncSlider();
  }

  setHolds(holds);

  // ---- pointer handling ----------------------------------------------------
  const holdFromEvent = (e) => {
    const g = e.target.closest && e.target.closest('.hold');
    return g ? holdById.get(Number(g.dataset.id)) : null;
  };
  // How far wall point (x, y) is outside `hold`, in inches (0 on it), and
  // `n`, how far out from its middle the point is in its own size (1 at its
  // edge). A hold is taken as the ellipse in its image, which is cut out close
  // to it: `extent` (holds.py) turned by its rotation.
  function reach(hold, x, y) {
    const [w, ht] = hold.extent || (hold.image_url ? [hold.size, hold.size] : [2 * HOLD_R, 2 * HOLD_R]);
    const t = (hold.rotation * Math.PI) / 180;
    const dx = x - hold.x;
    const dy = y - hold.y;
    const n = Math.hypot((dx * Math.cos(t) + dy * Math.sin(t)) / (w / 2), (dy * Math.cos(t) - dx * Math.sin(t)) / (ht / 2));
    return { n, gap: n <= 1 ? 0 : Math.hypot(dx, dy) * (1 - 1 / n) };
  }

  // The hold a tap at wall point `p` (viewport.pointAt) means, or null: of
  // those it lands on, the one it's nearest the middle of (holds never
  // overlap on the wall, though their pictures' corners may); otherwise the
  // nearest within TAP_SLOP_PX, as a fingertip covers more than a small hold
  // at any zoom. Only the holds showing count: not one being moved, nor a
  // removed one unless it's on the climb.
  function holdNear({ x, y, px }) {
    let on = null;
    let near = null;
    let nearGap = TAP_SLOP_PX * px;
    for (const [id, g] of nodes) {
      const hold = holdById.get(id);
      if (id === hiddenId || (hold.removed && !g.dataset.role)) continue;
      const { n, gap } = reach(hold, x, y);
      if (!gap && (!on || n < on.n)) on = { hold, n };
      else if (gap && gap < nearGap) {
        near = hold;
        nearGap = gap;
      }
    }
    return on ? on.hold : near;
  }

  // A tap on a touch screen picks a hold by holdNear(); a mouse the hold it
  // points at, as it hovers. Heard on the frame: the clicks that end a pan,
  // pinch or swipe stop on their way there (viewport.js, swipe.js).
  container.addEventListener('click', (e) => {
    if (!root.contains(e.target) || root.dataset.mode === 'place') return;
    const hold = LIGHT ? holdNear(viewport.pointAt(e)) : holdFromEvent(e);
    if (hold) onHoldClick?.(hold);
  });
  holdLayer.addEventListener('pointerover', (e) => onHoldHover?.(holdFromEvent(e)));
  holdLayer.addEventListener('pointerleave', () => onHoldHover?.(null));

  // ---- zoom (every view): viewport.js --------------------------------------
  const viewport = createViewport({
    container,
    root,
    layers,
    base: { x: minX, y: minY, w: viewW, h: viewH },
    placing: () => root.dataset.mode === 'place',
    onWallPointer,
    // Handles, borders and rings keep their size on screen at any zoom.
    onScale: () => {
      sizeVertices();
      sizeOutlines();
    },
  });

  // One slider beside the zoom: the color opacity of every hold, or, while
  // the Stats tab shows usage colors, how much of each hold shows through them.
  const SLIDERS = {
    color: { label: 'Color', title: 'Color opacity of every hold', aria: 'Hold color opacity', get: holdOpacity, set: setHoldOpacity },
    heat: { label: 'Hold', title: 'How much of each hold shows through its usage color', aria: 'Hold visibility', get: () => heatVisibility, set: setHeatVisibility },
  };
  const slider = () => (heat ? SLIDERS.heat : SLIDERS.color);
  const opacityLabel = h('span', { class: 'opacity-label' });
  const opacityValue = h('span', { class: 'opacity-value' });
  const opacityRange = h('input', {
    type: 'range', min: 0, max: 100, step: 1,
    onInput: () => {
      slider().set(Number(opacityRange.value) / 100);
      opacityValue.textContent = `${opacityRange.value}%`;
    },
    onChange: () => {
      if (LIGHT && !heat) retint();
    },
  });
  const opacityControl = h('label', { class: 'opacity-control' }, opacityLabel, opacityRange, opacityValue);
  function syncSlider() {
    const s = slider();
    opacityRange.value = Math.round(s.get() * 100);
    opacityRange.setAttribute('aria-label', s.aria);
    opacityControl.title = s.title;
    opacityLabel.textContent = s.label;
    opacityValue.textContent = `${opacityRange.value}%`;
  }
  syncSlider();
  (zoomHost || container).append(opacityControl, viewport.controls);

  // ---- volumes (background scenery, never interactive) ----------------------
  let volumeList = [];
  let hiddenVolumeId = null;  // a saved volume being reshaped: its draft shows instead
  let volumeEdgeNodes = new Map();

  function setVolumes(list) {
    volumeList = list;
    const shown = list.filter((v) => v.id !== hiddenVolumeId);
    shownVolumes = shown;
    volumeLayer.replaceChildren(...shown.map((v) => svg('polygon', { class: `volume ${v.color}`, points: pointsAttr(v.points) })));
    volumeEdgeNodes = new Map();
    volumeEdges.replaceChildren(...shown.map((v) => {
      const edge = svg('polygon', { class: 'volume-edge', points: pointsAttr(v.points) });
      volumeEdgeNodes.set(v.id, edge);
      return edge;
    }));
    // The grid fades over the volumes, and they cover the bolt holes under them.
    const outlines = shown.map((v) => v.points);
    drawGrid(outlines);
    volumeHoles = new Set(holeSpots.flatMap(([x, y], i) => (insideRuns(0, y, outlines).some(([a, b]) => x > a && x < b) ? [i] : [])));
    drawHoles();
    coverVolumeLines();
    const withFaces = shown.filter((v) => v.faces && v.faces.length);
    faceClips.replaceChildren(...withFaces.map((v) => svg('clipPath', { id: `faces-clip-${v.id}` }, svg('polygon', { points: pointsAttr(v.points) }))));
    faceLines.replaceChildren(...withFaces.map((v) => svg('g', { 'clip-path': `url(#faces-clip-${v.id})` },
      v.faces.map((f) => svg('polygon', { class: 'volume-face', points: pointsAttr(f) })))));
    edgeMaskLines.replaceChildren(...shown.map((v) => svg('polygon', { class: 'edge-mask-line', points: pointsAttr(v.points) })));
  }

  function setHiddenVolume(id) {
    if (id === hiddenVolumeId) return;
    hiddenVolumeId = id;
    setVolumes(volumeList);
  }

  function highlightVolume(id) {
    for (const [vid, edge] of volumeEdgeNodes) edge.classList.toggle('highlight', vid === id);
  }

  // The volume being drawn or reshaped: its outline (a dot, then a line, then a
  // filled polygon) and its faces (`face` is the one being drawn; `highlightFace`
  // the one hovered in the list). `active` is the [x, y] of what is being dragged.
  function setVolumeDraft(d) {
    if (!d || !d.points.length) {
      volumeDraftLayer.replaceChildren();
      return;
    }
    const points = pointsAttr(d.points);
    const shape = d.points.length >= 3
      ? svg('polygon', { class: `volume ${d.color} draft`, points })
      : svg('polyline', { class: 'volume-draft-line', points });
    const faces = d.faces || [];
    const faceShapes = faces.map((f, i) => {
      if (i === d.face) return f.length > 1 ? svg(f.length >= 3 ? 'polygon' : 'polyline', { class: 'face-draft', points: pointsAttr(f) }) : null;
      return svg('polygon', { class: `volume-face draft-face${i === d.highlightFace ? ' highlight' : ''}`, points: pointsAttr(f) });
    }).filter(Boolean);
    // Corner handles, one per spot: outline corners (the last placed white),
    // then face corners (smaller, hollow). The one being dragged is marked.
    const key = ([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`;
    const activeKey = d.active ? key(d.active) : null;
    const seen = new Set();
    const handle = (p, cls) => {
      const k = key(p);
      if (seen.has(k)) return null;
      seen.add(k);
      return svg('circle', { class: `volume-vertex${cls}${k === activeKey ? ' active' : ''}`, cx: p[0], cy: p[1] });
    };
    const lastIndex = d.points.length - 1;
    const outlineHandles = d.points.map((p, i) => handle(p, i === lastIndex && d.face == null ? ' last' : ''));
    const faceHandles = faces.flatMap((f, fi) => f.map((p, pi) => handle(p, ` face${fi === d.face && pi === f.length - 1 ? ' last' : ''}`)));
    volumeDraftLayer.replaceChildren(shape, ...faceShapes, ...[...outlineHandles, ...faceHandles].filter(Boolean));
    sizeVertices();
    const drawing = d.face != null ? faces[d.face] : null;
    const [fx, fy] = d.active || (drawing && drawing.length ? drawing[drawing.length - 1] : d.points[lastIndex]);
    viewport.reveal(fx, fy);
  }

  // Corner handles stay about the same size on screen at any zoom.
  function sizeVertices() {
    if (!viewport.frameWidth()) return;
    const r = Math.max(0.45, VERTEX_PX * viewport.drawnPerPx());
    volumeDraftLayer.querySelectorAll('.volume-vertex').forEach((c) => c.setAttribute('r', c.classList.contains('face') ? r * 0.75 : r));
  }

  // The holds' white border stays BORDER_PX wide on screen at any zoom: whole
  // device pixels at full strength, and the fraction left over as one more
  // pixel at that fraction of the strength (0.75 px is 1 solid + 1 half pixel
  // on a 2× screen; on a 1× screen, one pixel at 75%). The role rings' bands
  // (RING_BANDS, or PHONE_RING_BANDS) are whole pixels, each at least one wide.
  // Writing a radius makes every hold redraw, so sizes are only written when
  // they change.
  let outlineKey = '';   // the screen size and zoom sizeOutlines() last sized for
  function sizeOutlines() {
    if (!viewport.frameWidth()) return;
    const dpr = window.devicePixelRatio || 1;
    const key = `${viewport.frameWidth()} ${dpr} ${viewport.drawnPerPx()} ${PHONE.matches}`;
    if (key === outlineKey) return;
    outlineKey = key;
    const device = BORDER_PX * dpr;
    const whole = Math.floor(device + 1e-6);
    const outer = (device - whole) * BORDER_OPACITY;
    // A quarter pixel more than the whole pixels wanted, as browsers round
    // (Chrome) or truncate the radius to whole pixels.
    const radius = (px) => ((px + 0.25) / dpr) * viewport.drawnPerPx();
    borderInner.setAttribute('radius', radius(Math.max(whole, 1)));
    borderOuter.setAttribute('radius', radius(whole + 1));
    // Over the outer fill, the inner one tops the border up to BORDER_OPACITY.
    innerFlood.setAttribute('flood-opacity', whole ? (BORDER_OPACITY - outer) / (1 - outer) : 0);
    outerFlood.setAttribute('flood-opacity', outer);
    for (const [role, grows] of ringGrows) {
      const bands = PHONE.matches ? PHONE_RING_BANDS : RING_BANDS[role];
      let px = 0;     // CSS pixels out from the hold's edge
      let edge = 0;   // device pixels
      grows.forEach((grow, i) => {
        // bands past the phone's one ring (start and finish's second) stay empty
        if (i < bands.length) {
          px += bands[i];
          edge = Math.max(edge + 1, Math.round(px * dpr));
        }
        grow.setAttribute('radius', radius(edge));
      });
    }
  }
  sizeOutlines();
  PHONE.addEventListener('change', sizeOutlines);
  // A move to a screen with another pixel density changes the device pixels.
  (function watchDensity() {
    matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      .addEventListener('change', () => { sizeOutlines(); watchDensity(); }, { once: true });
  }());

  // ---- draft hold (being placed or edited) ---------------------------------
  let draft = null;

  function buildDraft(src) {
    const filter = src ? tintFilter('tint-draft', null) : null;
    const image = src ? svg('image', { href: src, preserveAspectRatio: 'xMidYMid meet', filter: 'url(#tint-draft)' }) : null;
    const art = svg('g', { class: 'draft-art' }, image ? bordered(image) : svg('circle', { class: 'draft-body', r: HOLD_R }));
    const placed = svg('g', {}, art);
    const guide = svg('line', { class: 'draft-guide' });
    const tnut = svg('g', { class: 'draft-tnut' },
      svg('line', { x1: -0.9, y1: 0, x2: 0.9, y2: 0 }), svg('line', { x1: 0, y1: -0.9, x2: 0, y2: 0.9 }), svg('circle', { r: 0.45 }));
    draftLayer.replaceChildren(svg('defs', {}, filter), guide, tnut, placed);
    return { src, filter, image, art, placed, guide, tnut };
  }

  // Highlights the column and row through the t-nut at `n` (or clears them).
  // On the ceiling `n` is just the column the hold is under.
  function showNearest(n) {
    nearLabels.forEach((t) => t.classList.remove('near'));
    nearLabels = [];
    if (!n) {
      nearGuides.replaceChildren();
      return;
    }
    if (n.ceiling) {
      nearGuides.replaceChildren(svg('line', { class: 'near-guide', x1: n.x, y1: ceiling.top, x2: n.x, y2: ceilingBottom }));
      nearLabels = colLabelEls.main[spec.col_x.indexOf(n.x)] || [];
      nearLabels.forEach((t) => t.classList.add('near'));
      return;
    }
    const panel = n.y > H ? 'foot' : 'main';
    const cols = panel === 'foot' ? foot.col_x : spec.col_x;
    const rows = panel === 'foot' ? foot.row_y : spec.row_y;
    const [top, bottom] = panel === 'foot' ? [foot.top, footBottom] : [0, H];
    nearGuides.replaceChildren(
      svg('line', { class: 'near-guide', x1: n.x, y1: top, x2: n.x, y2: bottom }),
      svg('line', { class: 'near-guide', x1: 0, y1: n.y, x2: W, y2: n.y }));
    nearLabels = [...(colLabelEls[panel][cols.indexOf(n.x)] || []), ...(rowLabelEls[panel][rows.indexOf(n.y)] || [])];
    nearLabels.forEach((t) => t.classList.add('near'));
  }

  function setDraft(d) {
    showNearest(d ? d.nearest : null);
    if (!d) {
      draftLayer.replaceChildren();
      draft = null;
      return;
    }
    if (!draft || draft.src !== d.src) draft = buildDraft(d.src);
    const { filter, image, art, placed, guide, tnut } = draft;
    placed.setAttribute('transform', `translate(${d.x} ${d.y})`);
    art.setAttribute('transform', `rotate(${d.rotation || 0})`);
    if (image) {
      const s = d.size;
      for (const [k, v] of Object.entries({ x: -s / 2, y: -s / 2, width: s, height: s })) image.setAttribute(k, v);
      updateTint(filter, d.color);
    }
    // A side panel (`nearest` is null) and the ceiling have no t-nuts: no marker or guide.
    const onTnut = d.nearest && !d.nearest.ceiling;
    tnut.toggleAttribute('hidden', !onTnut);
    guide.toggleAttribute('hidden', !onTnut);
    if (onTnut) {
      tnut.setAttribute('transform', `translate(${d.nearest.x} ${d.nearest.y})`);
      for (const [k, v] of Object.entries({ x1: d.x, y1: d.y, x2: d.nearest.x, y2: d.nearest.y })) guide.setAttribute(k, v);
    }
    viewport.reveal(d.x, d.y);
  }

  // The zoom carries over between modes of the same view (e.g. from picking a
  // hold to placing it); a new view starts from the whole wall (reset()).
  function setMode(mode) {
    root.dataset.mode = mode;
    mirror();
  }

  return {
    setHolds,
    // What a swipe between climbs slides (swipe.js): on touch screens just the
    // layer with the climb's own holds, over the wall and the picture.
    swipeLayer: LIGHT ? root : container,
    // Show a route's holds. `dim` fades every hold not on the route; `instant`
    // skips the fade (a new climb, rather than a hold painted in the editor).
    setRoute(routeHolds, { dim = true, instant = false } = {}) {
      roles = toRoleMap(routeHolds);
      dimOthers = dim;
      if (instant) paintNow();
      else paint();
    },
    // Temporarily show another route (e.g. while hovering a list item); null restores.
    preview(routeHolds) {
      preview = routeHolds ? toRoleMap(routeHolds) : null;
      paint();
    },
    // Fade the route's holds of every role but `role`; null shows them all.
    spotlight(role) {
      spotlit = role;
      paint();
    },
    setMode,
    isZoomed: viewport.zoomed,
    zoomIn: viewport.zoomIn,
    zoomOut: viewport.zoomOut,
    resetZoom: viewport.resetZoom,
    // One hold id, a list of them (recoloring several), or null.
    setPicked(holdIds) {
      picked = new Set(holdIds == null ? [] : typeof holdIds === 'object' ? holdIds : [holdIds]);
      paint();
    },
    // Hide one hold (while its draft copy is being edited).
    setHidden(holdId) {
      hiddenId = holdId;
      paint();
    },
    // Color every hold by `colors` (hold id -> color; the slider then sets
    // how much of the hold shows through), or null for the usual look.
    setHeat,
    // Keep these hold ids bright and dim every other hold, as showing a route
    // does but without its rings; null for none.
    setLit(holdIds) {
      if (!lit && !holdIds) return;
      lit = holdIds ? new Set(holdIds) : null;
      paint();
    },
    setDraft,
    setVolumes,
    setHiddenVolume,
    setVolumeDraft,
    highlightVolume,
    // `keepRoute` leaves the route showing until the next page sets its own,
    // so going from one climb to the next repaints the wall once, not twice.
    reset({ keepRoute = false } = {}) {
      if (!keepRoute) {
        roles = new Map();
        dimOthers = true;
      }
      preview = null;
      spotlit = null;
      picked = new Set();
      hiddenId = null;
      lit = null;
      setHeat(null);
      setMode('view');
      viewport.resetZoom();
      setDraft(null);
      setVolumeDraft(null);
      setHiddenVolume(null);
      highlightVolume(null);
      paintNow();
    },
  };
}
