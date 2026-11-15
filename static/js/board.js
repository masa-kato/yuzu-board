// SVG rendering of the wall. Units are inches, straight from /api/board.

import { api } from './api.js';
import { ROLES, h, icon, svg } from './ui.js';

const MARGIN = 4.5;     // room around the wall for the grid labels
// The closest view: 6× (about 7 columns) with a mouse, 2.5× on touch screens.
const TOUCH_SCREEN = window.matchMedia('(pointer: coarse)');
const maxZoom = () => (TOUCH_SCREEN.matches ? 2.5 : 6);
// Touch screens draw the holds from ready-made images (app.py board_variant)
// instead of SVG filters, which phones redraw slowly whenever the wall
// changes: one image per hold with its white border (so it widens as you
// zoom) and its color at the slider's opacity baked in. Their black shapes
// find the bolt holes they cover, instead of a mask.
const LIGHT = TOUCH_SCREEN.matches;
const ZOOM_STEP = 1.6;  // per zoom button / key press
const SETTLE_DELAY = 150;  // ms after the last wheel zoom before the wall is drawn again
// A quick pan glides on: its speed over the last GLIDE_WINDOW ms (if the finger
// didn't pause for GLIDE_PAUSE before lifting) falls by 1/e every GLIDE_TAU ms,
// as iOS scrolling does, until it's below GLIDE_STOP. Speeds in px per ms.
const GLIDE_WINDOW = 100;
const GLIDE_PAUSE = 50;
const GLIDE_TAU = 325;
const GLIDE_MIN = 0.3;
const GLIDE_STOP = 0.02;
const VERTEX_PX = 6;    // volume corner handles: radius on screen, in CSS pixels
const HOLD_R = 0.8;     // proxy hold circle
const RING_R = 1.3;     // picked / hover highlight; t-nuts are 3" apart so rings never touch
const HIT_R = 1.45;     // invisible tap target
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
const PHONE = window.matchMedia('(max-width: 900px)');
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

// A hold's image sized for the board on this screen (app.py makes it from the
// upload), a fraction of the original's pixels but still sharp at the closest zoom.
export const boardImage = (hold) => hold.board_url || hold.image_url;

// Image pixels per inch of hold this screen needs for that: phones, which stop
// at 2.5×, need far fewer than a laptop at 6×. The board is never wider than
// the screen's short side.
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

  // The grid is drawn twice: at full strength everywhere except volumes (an
  // all-or-nothing mask), and dimmed inside volumes (a clip at GRID_ON_VOLUME
  // opacity). This keeps the dimming an exact, predictable opacity; a single
  // partially-gray mask renders inconsistently because mask luminance isn't
  // a simple opacity.
  const maskVolumes = svg('g');
  const clipVolumes = svg('clipPath', { id: 'volume-clip' });
  const defs = svg('defs', {}, Object.entries(OUTLINES).map(([name, c]) => outlineFilter(name, c)), volumeDefs(), materialDefs(spec),
    svg('mask', { id: 'grid-mask', maskUnits: 'userSpaceOnUse', x: minX, y: minY, width: viewW, height: viewH },
      svg('rect', { x: minX, y: minY, width: viewW, height: viewH, fill: '#fff' }), maskVolumes),
    clipVolumes);
  const tintDefs = svg('defs');
  const heatDefs = svg('defs');   // one heatFilter per usage color (setHeat)

  const footBottom = foot.top + foot.height;
  const ceilingBottom = ceiling.top + ceiling.height;
  function gridLines(attrs) {
    const g = svg('g', attrs);
    spec.col_x.forEach((x) => g.append(svg('line', { x1: x, y1: 0, x2: x, y2: H })));
    // The columns carry on across the ceiling (which has no rows or holes).
    spec.col_x.forEach((x) => g.append(svg('line', { x1: x, y1: ceiling.top, x2: x, y2: ceilingBottom })));
    spec.row_y.forEach((y) => g.append(svg('line', { x1: 0, y1: y, x2: W, y2: y })));
    // Footboard: its own grid, confined to the footboard.
    foot.col_x.forEach((x) => g.append(svg('line', { x1: x, y1: foot.top, x2: x, y2: footBottom })));
    foot.row_y.forEach((y) => g.append(svg('line', { x1: 0, y1: y, x2: W, y2: y })));
    return g;
  }
  const grid = gridLines({ class: 'grid', mask: 'url(#grid-mask)' });
  const gridOnVolumes = gridLines({ class: 'grid grid-on-volume', 'clip-path': 'url(#volume-clip)', opacity: GRID_ON_VOLUME });

  // The wall's bolt holes, as one path. The main panel's are staggered: row 1
  // has them in columns A, C, E…, row 2 in B, D, F…, and so on (wherever the
  // column and row indexes add up to an even number). The footboard has one at
  // every intersection. Volumes cover holes (the grid's mask), and so does every
  // hold on the wall, even one drawn faded: `holeCovers` holds their black
  // silhouettes, kept in step with the holds by setHolds() and paint().
  const hole = (x, y) => `M${x - HOLE_R},${y}a${HOLE_R},${HOLE_R} 0 1,0 ${2 * HOLE_R},0a${HOLE_R},${HOLE_R} 0 1,0 ${-2 * HOLE_R},0`;
  const holeSpots = [];
  spec.col_x.forEach((x, c) => spec.row_y.forEach((y, r) => {
    if ((c + r) % 2 === 0) holeSpots.push([x, y]);
  }));
  foot.col_x.forEach((x) => foot.row_y.forEach((y) => holeSpots.push([x, y])));
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
    svg('filter', { id: 'silhouette', 'color-interpolation-filters': 'sRGB' },
      svg('feColorMatrix', { values: '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0' })),
    svg('mask', { id: 'hole-mask', maskUnits: 'userSpaceOnUse', x: minX, y: minY, width: viewW, height: viewH },
      svg('rect', { x: minX, y: minY, width: viewW, height: viewH, fill: '#fff' }), holeCovers));
  // LIGHT: no hole mask, which phones redraw slowly (coverHoles() leaves the
  // covered holes out instead).
  const holesPath = svg('path', { d: holeSpots.map(([x, y]) => hole(x, y)).join(''), mask: LIGHT ? null : 'url(#hole-mask)' });
  const holes = svg('g', { class: 'wall-holes', mask: 'url(#grid-mask)' }, holesPath);

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
  const rings = new Map();    // hold id -> its role ring, made the first time it's on a problem
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
      // What a tap lands on while the hold is in the picture (its art hidden).
      g.append(svg('rect', { class: 'hit', x: -s / 2, y: -s / 2, width: s, height: s, transform: `rotate(${hold.rotation})` }),
        svg('g', { class: 'hold-art', transform: `rotate(${hold.rotation})` }, rim, image),
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

  // A hold's shape at its place on the wall: the PNG, or the placeholder
  // circle. Only its opaque pixels matter, for the hole mask and the role ring.
  function holdShape(hold, imageFilter = null) {
    if (!hold.image_url) return svg('circle', { cx: hold.x, cy: hold.y, r: HOLD_R, fill: '#000' });
    const s = hold.size;
    return svg('g', { transform: `translate(${hold.x} ${hold.y}) rotate(${hold.rotation})` },
      svg('image', { href: boardImage(hold), x: -s / 2, y: -s / 2, width: s, height: s, preserveAspectRatio: 'xMidYMid meet', filter: imageFilter }));
  }

  // The hold in black, for the hole mask.
  const holeCover = (hold) => holdShape(hold, 'url(#silhouette)');

  // LIGHT: the bolt-hole path without the holes under a hold (on the wall,
  // and not the one being moved), found by drawing the holds' black shapes
  // small on a canvas once, rather than masking the holes on every redraw.
  const HOLE_CANVAS_PPI = 4;
  let coverToken = 0;
  async function coverHoles() {
    const token = ++coverToken;
    const shown = [...holdById.values()].filter((hold) => looks.has(hold.id) && !hold.removed && hold.id !== hiddenId);
    const images = await Promise.all(shown.map((hold) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = variantUrl(hold, 's');
    })));
    if (token !== coverToken) return;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewW * HOLE_CANVAS_PPI);
    canvas.height = Math.ceil(viewH * HOLE_CANVAS_PPI);
    const c = canvas.getContext('2d', { willReadFrequently: true });
    shown.forEach((hold, i) => {
      const img = images[i];
      if (!img) return;
      const k = hold.size / Math.max(img.width, img.height);   // drawn to fit its size, as on the board
      c.setTransform(HOLE_CANVAS_PPI, 0, 0, HOLE_CANVAS_PPI, -minX * HOLE_CANVAS_PPI, -minY * HOLE_CANVAS_PPI);
      c.translate(hold.x, hold.y);
      c.rotate((hold.rotation * Math.PI) / 180);
      c.drawImage(img, (-img.width * k) / 2, (-img.height * k) / 2, img.width * k, img.height * k);
    });
    const { data } = c.getImageData(0, 0, canvas.width, canvas.height);
    const covered = ([x, y]) => data[(Math.round((y - minY) * HOLE_CANVAS_PPI) * canvas.width + Math.round((x - minX) * HOLE_CANVAS_PPI)) * 4 + 3] > 127;
    holesPath.setAttribute('d', holeSpots.filter((spot) => !covered(spot)).map(([x, y]) => hole(x, y)).join(''));
  }

  // LIGHT: the picture of every hold on the wall, for the holds as they are
  // and the slider's opacity, at the pixels per inch this screen needs at its
  // closest zoom. Until the first one arrives no hold is drawn (so the phone
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

  // The bolt holes left out of the path: those under a hold in the picture
  // (still right under the Stats colors), or, while the holds have changed
  // since or one is being moved, under the holds as coverHoles() finds them.
  let holesFor = null;
  function updateHoles() {
    if (!LIGHT || pictureState === 'loading') return;
    const fromPicture = pictureState === 'ready' && hiddenId == null;
    const key = fromPicture ? `picture ${pictureImg.src}` : `holds ${hiddenId}`;
    if (key === holesFor) return;
    holesFor = key;
    if (fromPicture) holesPath.setAttribute('d', holeSpots.filter((_, i) => !pictureCovered.has(i)).map(([x, y]) => hole(x, y)).join(''));
    else coverHoles();
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
    // Removed holds are off the wall, so their holes show again. The picture
    // shows the holds as they were until a new one comes.
    covers.clear();
    if (LIGHT) {
      holesFor = null;
      if (pictureState !== 'loading') pictureState = 'stale';
      refreshPicture();
    }
    holeCovers.replaceChildren(...list.filter((hold) => !hold.removed && !LIGHT).map((hold) => {
      const cover = holeCover(hold);
      covers.set(hold.id, cover);
      return cover;
    }));
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
  holdLayer.addEventListener('click', (e) => {
    const hold = holdFromEvent(e);
    if (hold && root.dataset.mode !== 'place') onHoldClick?.(hold);
  });
  holdLayer.addEventListener('pointerover', (e) => onHoldHover?.(holdFromEvent(e)));
  holdLayer.addEventListener('pointerleave', () => onHoldHover?.(null));

  // ---- zoom (every view) ------------------------------------------------------
  // The SVG always holds the whole wall, drawn at `drawnK` times the size of
  // its frame (the container, which clips it), and a CSS transform moves it to
  // show `view`. Moving the drawn wall is the GPU's job, so panning never
  // redraws it. While a zoom is under way the drawn wall is stretched (a little
  // soft when enlarged), and settle() draws it again once the zoom stops.
  // toWall() measures from the frame, so placement stays exact.
  const base = { x: minX, y: minY, w: viewW, h: viewH };
  let view = { ...base };
  let goal = view;    // where the view is heading (differs from `view` mid-animation)
  let viewAnim = 0;   // a zoom animation or glide under way
  let gliding = false;
  let drawnK = 1;     // the zoom the wall is drawn at
  let placed = '';    // the transform last written
  let settleTimer = 0;
  let outlineKey = '';   // the screen size and zoom sizeOutlines() last sized for
  const frame = { w: container.getBoundingClientRect().width };   // CSS pixels
  const zoomLevel = () => base.w / view.w;
  const zoomed = () => zoomLevel() > 1.001;
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const zoomOut = h('button', { type: 'button', class: 'icon-btn', title: 'Zoom out (−)', 'aria-label': 'Zoom out', onClick: () => zoomBy(1 / ZOOM_STEP) }, icon('minus', { size: 16 }));
  const zoomIn = h('button', { type: 'button', class: 'icon-btn', title: 'Zoom in (+)', 'aria-label': 'Zoom in', onClick: () => zoomBy(ZOOM_STEP) }, icon('plus', { size: 16 }));
  const zoomReset = h('button', { type: 'button', class: 'zoom-level', title: 'Show the whole wall (0)', 'aria-label': 'Show the whole wall', onClick: () => resetZoom(true) });
  const zoomControls = h('div', { class: 'zoom-controls', role: 'group', 'aria-label': 'Zoom' }, zoomOut, zoomReset, zoomIn);

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
  (zoomHost || container).append(opacityControl, zoomControls);

  function clampView(v) {
    const w = Math.min(base.w, Math.max(base.w / maxZoom(), v.w));
    const ht = (w * base.h) / base.w;
    return {
      x: Math.min(base.x + base.w - w, Math.max(base.x, v.x)),
      y: Math.min(base.y + base.h - ht, Math.max(base.y, v.y)),
      w,
      h: ht,
    };
  }

  // Moves the drawn wall to show `view`: a transform, so nothing is redrawn.
  function place() {
    const k = zoomLevel();
    const px = (k * frame.w) / base.w;   // screen pixels per wall inch
    const transform = `translate(${-(view.x - base.x) * px}px, ${-(view.y - base.y) * px}px) scale(${k / drawnK})`;
    if (transform === placed) return;
    placed = transform;
    for (const layer of layers) layer.style.transform = transform;
  }

  // Draws the wall again at the zoom it has come to. A pinch settles when its
  // fingers lift. The frame's `zoomed` class changes only here too: it changes
  // the wall's touch-action (and, with a mouse, its cursor), and Safari
  // redraws the whole wall for that, so it goes with this redraw rather than
  // adding one mid-gesture.
  function settle() {
    clearTimeout(settleTimer);
    const k = zoomLevel();
    if (pinch || k === drawnK) return;
    drawnK = k;
    for (const layer of layers) {
      layer.style.width = layer.style.height = `${k * 100}%`;
      layer.style.setProperty('--zoom', k);   // keeps grid lines hairline (app.css)
    }
    container.classList.toggle('zoomed', zoomed());
    sizeVertices();
    sizeOutlines();
    place();
  }

  // For zooms that come in many small steps (a wheel or trackpad pinch).
  function settleSoon() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, SETTLE_DELAY);
  }

  // Stops a zoom animation or glide where it is.
  function stopMoving() {
    cancelAnimationFrame(viewAnim);
    gliding = false;
    goal = view;
  }

  // `final` is false only for the in-between frames of an animation.
  function applyView(v, final = true) {
    view = clampView(v);
    if (final) goal = view;
    place();
    const k = zoomLevel();
    const level = `${Math.round(k * 10) / 10}×`;
    if (zoomReset.textContent !== level) zoomReset.textContent = level;
    zoomOut.disabled = !zoomed();
    zoomIn.disabled = k >= maxZoom() - 0.001;
    zoomControls.classList.toggle('zoomed', zoomed());
  }

  applyView(base);

  function animateTo(v, animate) {
    stopMoving();
    const target = clampView(v);
    if (!animate || reducedMotion()) {
      applyView(target);
      settle();
      return;
    }
    goal = target;
    const from = { ...view };
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 180);
      const e = 1 - (1 - t) ** 3;
      applyView({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, w: from.w + (target.w - from.w) * e, h: 0 }, t >= 1);
      if (t < 1) viewAnim = requestAnimationFrame(step);
      else settle();
    };
    viewAnim = requestAnimationFrame(step);
  }

  // The view at zoom `k` that keeps wall point (fx, fy) where it is on screen.
  function zoomAt(k, fx, fy) {
    const w = base.w / Math.min(maxZoom(), Math.max(1, k));
    const ht = (w * base.h) / base.w;
    return { x: fx - ((fx - view.x) / view.w) * w, y: fy - ((fy - view.y) / view.h) * ht, w, h: ht };
  }

  // Buttons and keys: zoom around the centre of what is shown (or about to be,
  // when a zoom is still animating), so quick repeated presses add up.
  function zoomBy(factor) {
    const w = base.w / Math.min(maxZoom(), Math.max(1, (base.w / goal.w) * factor));
    const ht = (w * base.h) / base.w;
    const cx = goal.x + goal.w / 2;
    const cy = goal.y + goal.h / 2;
    animateTo({ x: cx - w / 2, y: cy - ht / 2, w, h: ht }, true);
  }

  function resetZoom(animate = false) {
    animateTo(base, animate);
  }

  // After a move, bring the hold back into view if it has drifted out.
  function reveal(x, y) {
    if (!zoomed() || dragging || pinch) return;
    const mx = view.w * 0.12;
    const my = view.h * 0.12;
    if (x > view.x + mx && x < view.x + view.w - mx && y > view.y + my && y < view.y + view.h - my) return;
    animateTo({ ...view, x: x - view.w / 2, y: y - view.h / 2 }, true);
  }

  // Wall inches under a screen point, measured from the frame (the drawn wall
  // is larger, and moved by a transform).
  const toWall = (e) => {
    const r = container.getBoundingClientRect();
    const perPx = view.w / r.width;
    return { x: view.x + (e.clientX - r.left) * perPx, y: view.y + (e.clientY - r.top) * perPx };
  };

  // Ctrl/⌘ + wheel (also a trackpad pinch) zooms at the pointer, in every view;
  // a plain wheel pans once zoomed in (and scrolls the page as usual when not).
  root.addEventListener('wheel', (e) => {
    const lines = e.deltaMode === 1 ? 16 : 1;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      stopMoving();
      const p = toWall(e);
      applyView(zoomAt(zoomLevel() * Math.exp(-e.deltaY * lines * 0.01), p.x, p.y));
      settleSoon();
    } else if (zoomed()) {
      e.preventDefault();
      stopMoving();
      const perPx = view.w / frame.w;
      applyView({ ...view, x: view.x + e.deltaX * lines * perPx, y: view.y + e.deltaY * lines * perPx });
      settleSoon();   // in case it cut a zoom short
    }
  }, { passive: false });

  // + / − zoom around the middle of the view and 0 shows the whole wall, unless
  // typing in a field or a dialog is open.
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    const act = { '+': () => zoomBy(ZOOM_STEP), '=': () => zoomBy(ZOOM_STEP), '-': () => zoomBy(1 / ZOOM_STEP), _: () => zoomBy(1 / ZOOM_STEP), 0: () => resetZoom(true) }[e.key];
    if (!act) return;
    e.preventDefault();
    act();
  });

  // Pointers. In every view, two fingers pinch to zoom and pan, and once zoomed
  // in, dragging the wall pans it (a tap still picks a hold; the click ending a
  // pan does not). In "place" mode a drag moves what is being placed instead:
  // pressing or dragging anywhere on the wall reports the pointer position in
  // wall inches, and a touch waits a moment before it counts as a press, so
  // that starting a pinch never moves the hold.
  const TOUCH_DELAY = 90;   // ms
  const PAN_SLOP = 6;       // px a press may wander before it becomes a pan
  const touches = new Map();   // pointerId -> { clientX, clientY }
  let dragging = false;
  let pending = null;          // { id, at, timer } a touch not yet reported as a press
  let pinch = null;            // { dist, k, anchor } at the start of a pinch
  let settling = false;        // a finger left over from a pinch: ignore it until lifted
  let last = null;             // latest pointer position while dragging
  let edgeFrame = 0;
  let pan = null;              // { id, at, view, moved, trail } a press that may turn into a pan
  let swallowClick = false;    // the click after a pan or pinch is not a tap on a hold

  const capture = (id) => {
    try {
      root.setPointerCapture(id);
    } catch {
      // the pointer is already gone
    }
  };

  const spread = () => {
    const [a, b] = [...touches.values()];
    return { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, mid: { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 } };
  };

  // Tells the view where the pointer is on the wall, and how many wall inches
  // one screen pixel spans there (so hit areas feel the same at any zoom).
  function report(type, at) {
    const p = toWall(at);
    p.px = view.w / frame.w;
    p.touch = !!at.touch;
    onWallPointer?.(type, p);
  }

  function press(at) {
    pending = null;
    dragging = true;
    last = at;
    report('down', at);
  }

  function endDrag(at) {
    if (!dragging) return;
    dragging = false;
    cancelAnimationFrame(edgeFrame);
    edgeFrame = 0;
    report('up', at);
  }

  function endPan() {
    pan = null;
    container.classList.remove('panning');
  }

  // A quick pan keeps going once released, slowing down as a scroll does.
  // `trail` is the pan's last few moves, `upAt` when the finger lifted.
  function glide(trail, upAt) {
    const a = trail[0];
    const b = trail[trail.length - 1];
    if (reducedMotion() || b.t <= a.t || upAt - b.t > GLIDE_PAUSE) return;
    let vx = (b.x - a.x) / (b.t - a.t);   // screen pixels per ms
    let vy = (b.y - a.y) / (b.t - a.t);
    if (Math.hypot(vx, vy) < GLIDE_MIN) return;
    gliding = true;
    let prev = upAt;
    const step = (now) => {
      const decay = Math.exp(-Math.max(0, now - prev) / GLIDE_TAU);
      const travel = GLIDE_TAU * (1 - decay);   // how far one px/ms carries over this frame
      prev = now;
      const perPx = view.w / frame.w;
      const before = view;
      applyView({ ...view, x: view.x - vx * travel * perPx, y: view.y - vy * travel * perPx }, false);
      // Against an edge, that way stops at once.
      if (view.x === before.x) vx = 0;
      if (view.y === before.y) vy = 0;
      vx *= decay;
      vy *= decay;
      if (Math.hypot(vx, vy) > GLIDE_STOP) viewAnim = requestAnimationFrame(step);
      else stopMoving();
    };
    viewAnim = requestAnimationFrame(step);
  }

  // While dragging near the board's edge, zoomed in: pan that way, and keep
  // the hold under the pointer.
  function edgePan() {
    edgeFrame = 0;
    if (!dragging || !zoomed() || !last) return;
    const r = container.getBoundingClientRect();
    const band = 0.08;
    const push = (f) => Math.max(-1, Math.min(1, f < band ? (f - band) / band : f > 1 - band ? (f - 1 + band) / band : 0));
    const dx = push((last.clientX - r.left) / r.width);
    const dy = push((last.clientY - r.top) / r.height);
    if (!dx && !dy) return;
    const before = { x: view.x, y: view.y };
    applyView({ ...view, x: view.x + dx * view.w * 0.012, y: view.y + dy * view.w * 0.012 });
    if (view.x !== before.x || view.y !== before.y) report('move', last);
    edgeFrame = requestAnimationFrame(edgePan);
  }

  // Swallows the click that ends a pan or pinch, before it reaches a hold.
  root.addEventListener('click', (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
  }, true);

  root.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    const at = { clientX: e.clientX, clientY: e.clientY, touch: e.pointerType === 'touch' };
    if (e.pointerType === 'touch') touches.set(e.pointerId, at);
    if (touches.size === 2) {
      // A second finger: a pinch (ending any press, drag or pan under way).
      if (pending) clearTimeout(pending.timer);
      pending = null;
      if (dragging) endDrag(last);
      endPan();
      stopMoving();
      touches.forEach((_, id) => capture(id));
      const { dist, mid } = spread();
      pinch = { dist, k: zoomLevel(), anchor: toWall(mid) };
      swallowClick = true;
      return;
    }
    if (touches.size > 2 || settling) return;
    if (root.dataset.mode === 'place') {
      e.preventDefault();
      capture(e.pointerId);
      if (e.pointerType !== 'touch') press(at);
      else pending = { id: e.pointerId, at, timer: setTimeout(() => pending && press(pending.at), TOUCH_DELAY) };
      return;
    }
    // Any other view: once zoomed in, this press may become a pan. The pointer
    // is only captured when it does, so a plain tap still lands on its hold.
    swallowClick = false;
    if (zoomed()) {
      if (e.pointerType === 'mouse') e.preventDefault();   // no text selection while dragging
      // A touch stops a glide, as on a scrolling page, and isn't a tap on a hold.
      if (gliding) swallowClick = true;
      stopMoving();
      pan = { id: e.pointerId, at, view: { ...view }, moved: false, trail: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }] };
    }
  });

  root.addEventListener('pointermove', (e) => {
    const at = { clientX: e.clientX, clientY: e.clientY };
    if (touches.has(e.pointerId)) touches.set(e.pointerId, at);
    if (pinch) {
      if (touches.size < 2) return;
      // Zoom with the fingers' spread; keep the wall point that started under
      // their midpoint under it, so moving both fingers pans.
      const { dist, mid } = spread();
      const r = container.getBoundingClientRect();
      const w = base.w / Math.min(maxZoom(), Math.max(1, (pinch.k * dist) / pinch.dist));
      const ht = (w * base.h) / base.w;
      applyView({ x: pinch.anchor.x - ((mid.clientX - r.left) / r.width) * w, y: pinch.anchor.y - ((mid.clientY - r.top) / r.height) * ht, w, h: ht });
      return;
    }
    if (pan && pan.id === e.pointerId) {
      if (e.pointerType === 'mouse' && !e.buttons) {
        endPan();   // released somewhere we didn't hear about
        settle();
        return;
      }
      const dx = at.clientX - pan.at.clientX;
      const dy = at.clientY - pan.at.clientY;
      if (!pan.moved) {
        if (Math.hypot(dx, dy) < PAN_SLOP) return;
        pan.moved = true;
        swallowClick = true;
        capture(e.pointerId);
        container.classList.add('panning');
      }
      const perPx = pan.view.w / frame.w;
      applyView({ ...pan.view, x: pan.view.x - dx * perPx, y: pan.view.y - dy * perPx });
      pan.trail.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
      while (pan.trail.length > 2 && e.timeStamp - pan.trail[0].t > GLIDE_WINDOW) pan.trail.shift();
      return;
    }
    if (pending && pending.id === e.pointerId && Math.hypot(at.clientX - pending.at.clientX, at.clientY - pending.at.clientY) > 6) {
      clearTimeout(pending.timer);
      press(pending.at);
    }
    if (!dragging) return;
    last = at;
    report('move', at);
    if (!edgeFrame) edgeFrame = requestAnimationFrame(edgePan);
  });

  const lift = (e) => {
    const at = { clientX: e.clientX, clientY: e.clientY };
    touches.delete(e.pointerId);
    if (pending && pending.id === e.pointerId) {
      clearTimeout(pending.timer);
      if (e.type === 'pointercancel') pending = null;
      else press(pending.at);   // a quick tap: press and release right here
    }
    if (pinch) {
      if (touches.size < 2) {
        pinch = null;
        settling = touches.size > 0;
        settle();   // draw the wall at its new zoom
      }
      return;
    }
    if (!touches.size) settling = false;
    if (pan && pan.id === e.pointerId) {
      const { moved, trail } = pan;
      endPan();
      settle();   // if the pan cut a zoom short
      if (moved && e.type === 'pointerup') glide(trail, e.timeStamp);
    }
    endDrag(at);
  };
  root.addEventListener('pointerup', lift);
  root.addEventListener('pointercancel', lift);

  // ---- volumes (background scenery, never interactive) ----------------------
  let volumeList = [];
  let hiddenVolumeId = null;  // a saved volume being reshaped: its draft shows instead
  let volumeEdgeNodes = new Map();

  function setVolumes(list) {
    volumeList = list;
    const shown = list.filter((v) => v.id !== hiddenVolumeId);
    volumeLayer.replaceChildren(...shown.map((v) => svg('polygon', { class: `volume ${v.color}`, points: pointsAttr(v.points) })));
    volumeEdgeNodes = new Map();
    volumeEdges.replaceChildren(...shown.map((v) => {
      const edge = svg('polygon', { class: 'volume-edge', points: pointsAttr(v.points) });
      volumeEdgeNodes.set(v.id, edge);
      return edge;
    }));
    maskVolumes.replaceChildren(...shown.map((v) => svg('polygon', { points: pointsAttr(v.points), fill: '#000' })));
    clipVolumes.replaceChildren(...shown.map((v) => svg('polygon', { points: pointsAttr(v.points) })));
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
    reveal(fx, fy);
  }

  // Wall inches per screen pixel, as the wall is drawn (settle()).
  const drawnPerPx = () => base.w / (drawnK * frame.w);

  // Corner handles stay about the same size on screen at any zoom.
  function sizeVertices() {
    if (!frame.w) return;
    const r = Math.max(0.45, VERTEX_PX * drawnPerPx());
    volumeDraftLayer.querySelectorAll('.volume-vertex').forEach((c) => c.setAttribute('r', c.classList.contains('face') ? r * 0.75 : r));
  }

  // The holds' white border stays BORDER_PX wide on screen at any zoom: whole
  // device pixels at full strength, and the fraction left over as one more
  // pixel at that fraction of the strength (0.75 px is 1 solid + 1 half pixel
  // on a 2× screen; on a 1× screen, one pixel at 75%). The role rings' bands
  // (RING_BANDS, or PHONE_RING_BANDS) are whole pixels, each at least one wide.
  // Writing a radius makes every hold redraw, so sizes are only written when
  // they change.
  function sizeOutlines() {
    if (!frame.w) return;
    const dpr = window.devicePixelRatio || 1;
    const key = `${frame.w} ${dpr} ${drawnK} ${PHONE.matches}`;
    if (key === outlineKey) return;
    outlineKey = key;
    const device = BORDER_PX * dpr;
    const whole = Math.floor(device + 1e-6);
    const outer = (device - whole) * BORDER_OPACITY;
    // A quarter pixel more than the whole pixels wanted, as browsers round
    // (Chrome) or truncate the radius to whole pixels.
    const radius = (px) => ((px + 0.25) / dpr) * drawnPerPx();
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
  // The frame changes size with the page.
  new ResizeObserver(([entry]) => {
    frame.w = entry.contentRect.width;
    place();
    sizeVertices();
    sizeOutlines();
  }).observe(container);
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
    reveal(d.x, d.y);
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
    isZoomed: zoomed,
    zoomIn: () => zoomBy(ZOOM_STEP),
    zoomOut: () => zoomBy(1 / ZOOM_STEP),
    resetZoom,
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
      resetZoom();
      setDraft(null);
      setVolumeDraft(null);
      setHiddenVolume(null);
      highlightVolume(null);
      paintNow();
    },
  };
}
