// SVG rendering of the wall. Units are inches, straight from /api/board.

import { ROLES, h, icon, svg } from './ui.js';

const MARGIN = 4.5;     // room around the wall for the grid labels
const MAX_ZOOM = 6;     // the closest view shows about 7 columns
const ZOOM_STEP = 1.6;  // per zoom button / key press
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

// Every hold's color shows at one shared opacity, set by the slider
// under the board (75% unless changed) and remembered in this browser. The
// key is new with the 75% default, so a setting saved under the old 100%
// default (homewall.holdOpacity) starts over once.
const OPACITY_KEY = 'homewall.colorOpacity';
const DEFAULT_OPACITY = 0.75;
let tintOpacity = readOpacity();

function readOpacity() {
  try {
    localStorage.removeItem('homewall.holdOpacity');
    const saved = localStorage.getItem(OPACITY_KEY);
    const v = saved == null ? NaN : Number(saved);
    return v >= 0 && v <= 1 ? v : DEFAULT_OPACITY;
  } catch {
    return DEFAULT_OPACITY;
  }
}

export const holdOpacity = () => tintOpacity;

// Changes every hold color on the page at once: the board, the hold being
// placed, and the Wall tab's thumbnails and preview.
export function setHoldOpacity(v) {
  tintOpacity = Math.min(1, Math.max(0, v));
  try {
    localStorage.setItem(OPACITY_KEY, String(tintOpacity));
  } catch {
    // Storage unavailable (private mode); the setting just won't persist.
  }
  document.querySelectorAll('filter.hold-tint').forEach((f) => updateTint(f, f.dataset.color || null));
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

// Materials: the wood grain, and resin-like placeholder holds with a soft
// shadow.
function materialDefs(spec) {
  const radial = (id, stops) => svg('radialGradient', { id, cx: '38%', cy: '32%', r: '75%' },
    stops.map(([offset, color]) => svg('stop', { offset, style: `stop-color: ${color}` })));
  return [
    svg('pattern', { id: 'wood', patternUnits: 'userSpaceOnUse', width: 60, height: 15 },
      svg('image', { href: GRAIN_TILE, width: 60, height: 15, preserveAspectRatio: 'none' })),
    svg('clipPath', { id: 'wall-clip' },
      svg('rect', { x: 0, y: 0, width: spec.width, height: spec.height, rx: 0.75 }),
      svg('rect', { x: 0, y: spec.foot.top, width: spec.width, height: spec.foot.height, rx: 0.75 })),
    radial('hold-resin', [[0, 'var(--hold-hi)'], [0.55, 'var(--hold)'], [1, 'var(--hold-lo)']]),
    radial('hold-resin-on', [[0, '#ffffff'], [0.6, 'var(--hold-on)'], [1, 'var(--hold-on-lo)']]),
    svg('filter', { id: 'hold-shadow', x: '-60%', y: '-60%', width: '220%', height: '220%' },
      svg('feDropShadow', { dx: 0, dy: 0.14, stdDeviation: 0.13, 'flood-color': '#000', 'flood-opacity': 0.7 })),
  ];
}

// `zoomHost` is where the zoom control goes (off the board); defaults to `container`.
export function createBoard(container, spec, holds, { onHoldClick, onHoldHover, onWallPointer, zoomHost } = {}) {
  const { width: W, height: H, foot } = spec;
  const viewW = W + 2 * MARGIN;
  const viewH = spec.total_height + 2 * MARGIN;
  const root = svg('svg', {
    class: 'board',
    viewBox: `${-MARGIN} ${-MARGIN} ${viewW} ${viewH}`,
    role: 'img',
    'aria-label': `Climbing wall: main panel with ${spec.cols} by ${spec.rows} t-nuts, footboard with ${foot.cols} by ${foot.rows}`,
  });

  // The grid is drawn twice: at full strength everywhere except volumes (an
  // all-or-nothing mask), and dimmed inside volumes (a clip at GRID_ON_VOLUME
  // opacity). This keeps the dimming an exact, predictable opacity; a single
  // partially-gray mask renders inconsistently because mask luminance isn't
  // a simple opacity.
  const maskVolumes = svg('g');
  const clipVolumes = svg('clipPath', { id: 'volume-clip' });
  const defs = svg('defs', {}, Object.entries(OUTLINES).map(([name, c]) => outlineFilter(name, c)), volumeDefs(), materialDefs(spec),
    svg('mask', { id: 'grid-mask', maskUnits: 'userSpaceOnUse', x: -MARGIN, y: -MARGIN, width: viewW, height: viewH },
      svg('rect', { x: -MARGIN, y: -MARGIN, width: viewW, height: viewH, fill: '#fff' }), maskVolumes),
    clipVolumes);
  const tintDefs = svg('defs');

  const footBottom = foot.top + foot.height;
  function gridLines(attrs) {
    const g = svg('g', attrs);
    spec.col_x.forEach((x) => g.append(svg('line', { x1: x, y1: 0, x2: x, y2: H })));
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
  const holePath = [];
  spec.col_x.forEach((x, c) => spec.row_y.forEach((y, r) => {
    if ((c + r) % 2 === 0) holePath.push(hole(x, y));
  }));
  foot.col_x.forEach((x) => foot.row_y.forEach((y) => holePath.push(hole(x, y))));
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
  const ringGrows = [];   // per role: [dilation, CSS pixels out from the hold's edge] for each band
  function ringFilter(role) {
    let px = 0;
    const grows = RING_BANDS[role].map((band, i) => {
      px += band;
      return [svg('feMorphology', { in: 'SourceAlpha', operator: 'dilate', radius: 0.1, result: `edge${i}` }), px];
    });
    ringGrows.push(grows);
    const ringBands = grows.map((_, i) => i).filter((i) => i % 2 === 1);   // the gaps are the others
    return svg('filter', { id: `ring-${role}`, x: '-200%', y: '-200%', width: '500%', height: '500%', 'color-interpolation-filters': 'sRGB' },
      grows.map(([grow]) => grow),
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
    svg('mask', { id: 'hole-mask', maskUnits: 'userSpaceOnUse', x: -MARGIN, y: -MARGIN, width: viewW, height: viewH },
      svg('rect', { x: -MARGIN, y: -MARGIN, width: viewW, height: viewH, fill: '#fff' }), holeCovers));
  const holes = svg('g', { class: 'wall-holes', mask: 'url(#grid-mask)' },
    svg('path', { d: holePath.join(''), mask: 'url(#hole-mask)' }));

  // Label elements are kept per panel and index so the nearest row and
  // column can be highlighted while a hold is being placed.
  const labels = svg('g', { class: 'labels' });
  const colLabelEls = { main: [], foot: [] };
  const rowLabelEls = { main: [], foot: [] };
  const rowLabels = (panel, ys, texts) => ys.forEach((y, i) => {
    rowLabelEls[panel][i] = [
      svg('text', { x: -1.2, y, 'text-anchor': 'end', 'dominant-baseline': 'central' }, texts[i]),
      svg('text', { x: W + 1.2, y, 'text-anchor': 'start', 'dominant-baseline': 'central' }, texts[i]),
    ];
    labels.append(...rowLabelEls[panel][i]);
  });
  spec.col_x.forEach((x, i) => {
    colLabelEls.main[i] = [svg('text', { x, y: -1.5, 'text-anchor': 'middle' }, spec.col_labels[i])];
    labels.append(...colLabelEls.main[i]);
  });
  rowLabels('main', spec.row_y, spec.row_labels);
  // The main panel sits above the footboard, so its column letters go underneath.
  foot.col_x.forEach((x, i) => {
    colLabelEls.foot[i] = [svg('text', { x, y: footBottom + 1.1, 'text-anchor': 'middle', 'dominant-baseline': 'hanging' }, foot.col_labels[i])];
    labels.append(...colLabelEls.foot[i]);
  });
  rowLabels('foot', foot.row_y, foot.row_labels);

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
    svg('mask', { id: 'edge-mask', maskUnits: 'userSpaceOnUse', x: -MARGIN, y: -MARGIN, width: viewW, height: viewH },
      svg('rect', { x: -MARGIN, y: -MARGIN, width: viewW, height: viewH, fill: '#fff' }), edgeMaskLines),
    faceClips);
  const holdLayer = svg('g', { class: 'holds' });
  const draftLayer = svg('g', { class: 'draft-layer' });
  const volumeDraftLayer = svg('g', { class: 'volume-draft-layer' });
  root.append(defs, tintDefs,
    svg('rect', { class: 'wall', x: 0, y: 0, width: W, height: H, rx: 0.75 }),
    svg('rect', { class: 'wall footboard', x: 0, y: foot.top, width: W, height: foot.height, rx: 0.75 }),
    svg('g', { class: 'wall-grain', 'clip-path': 'url(#wall-clip)' },
      svg('rect', { x: 0, y: 0, width: W, height: spec.total_height, fill: 'url(#wood)' })),
    volumeLayer,
    grid, gridOnVolumes, holes, volumeFaces, volumeEdges, nearGuides,
    labels, holdLayer, draftLayer, volumeDraftLayer);
  container.replaceChildren(root);
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

  function holdNode(hold) {
    const classes = ['hold', hold.image_url && 'has-image', hold.removed && 'removed'].filter(Boolean).join(' ');
    const g = svg('g', { class: classes, 'data-id': hold.id, transform: `translate(${hold.x} ${hold.y})` },
      svg('title', {}, holdTitle(hold)));
    if (hold.image_url) {
      const s = hold.size;
      const image = svg('image', { href: hold.image_url, x: -s / 2, y: -s / 2, width: s, height: s, preserveAspectRatio: 'xMidYMid meet' });
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
      svg('image', { href: hold.image_url, x: -s / 2, y: -s / 2, width: s, height: s, preserveAspectRatio: 'xMidYMid meet', filter: imageFilter }));
  }

  // The hold in black, for the hole mask.
  const holeCover = (hold) => holdShape(hold, 'url(#silhouette)');

  function ringFor(id) {
    if (!rings.has(id)) rings.set(id, svg('g', { class: 'role-ring' }, holdShape(holdById.get(id))));
    return rings.get(id);
  }

  function paint() {
    const active = preview || roles;
    root.classList.toggle('dim', active.size > 0 && (preview ? true : dimOthers));
    const unlit = (role) => !!spotlit && !!role && role !== spotlit;
    for (const [id, g] of nodes) {
      const role = active.get(id);
      if (role) g.dataset.role = role;
      else delete g.dataset.role;
      g.classList.toggle('unlit', unlit(role));
      g.classList.toggle('picked', picked.has(id));
      g.classList.toggle('editing', id === hiddenId);
    }
    const shownRings = [...active].filter(([id]) => holdById.has(id) && id !== hiddenId).map(([id, role]) => {
      const ring = ringFor(id);
      ring.setAttribute('filter', `url(#ring-${role})`);
      ring.classList.toggle('unlit', unlit(role));
      return ring;
    });
    ringLayer.replaceChildren(...shownRings);
    // The holds on the problem are drawn last, and the rings just under them,
    // so a neighbour off the problem never covers a ring, and a hold on the
    // problem always shows over its neighbours' rings.
    const order = [...nodes].filter(([id]) => !active.get(id)).map(([, g]) => g);
    order.push(ringLayer, ...[...nodes].filter(([id]) => active.get(id)).map(([, g]) => g));
    if (order.some((g, i) => holdLayer.children[i] !== g)) holdLayer.append(...order);
    // The hold being moved uncovers its old hole.
    for (const [id, cover] of covers) cover.style.display = id === hiddenId ? 'none' : '';
  }

  function setHolds(list) {
    holdById = new Map(list.map((h) => [h.id, h]));
    nodes.clear();
    rings.clear();
    tintDefs.replaceChildren();
    holdLayer.replaceChildren(...list.map((hold) => {
      const g = holdNode(hold);
      nodes.set(hold.id, g);
      return g;
    }));
    // Removed holds are off the wall, so their holes show again.
    covers.clear();
    holeCovers.replaceChildren(...list.filter((hold) => !hold.removed).map((hold) => {
      const cover = holeCover(hold);
      covers.set(hold.id, cover);
      return cover;
    }));
    paint();
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
  // Zooming narrows the viewBox; the SVG keeps its size and aspect ratio, and
  // toWall() goes through the screen transform, so placement stays exact.
  const base = { x: -MARGIN, y: -MARGIN, w: viewW, h: viewH };
  let view = { ...base };
  let goal = view;    // where the view is heading (differs from `view` mid-animation)
  let viewAnim = 0;
  const zoomLevel = () => base.w / view.w;
  const zoomed = () => zoomLevel() > 1.001;
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const zoomOut = h('button', { type: 'button', class: 'icon-btn', title: 'Zoom out (−)', 'aria-label': 'Zoom out', onClick: () => zoomBy(1 / ZOOM_STEP) }, icon('minus', { size: 16 }));
  const zoomIn = h('button', { type: 'button', class: 'icon-btn', title: 'Zoom in (+)', 'aria-label': 'Zoom in', onClick: () => zoomBy(ZOOM_STEP) }, icon('plus', { size: 16 }));
  const zoomReset = h('button', { type: 'button', class: 'zoom-level', title: 'Show the whole wall (0)', 'aria-label': 'Show the whole wall', onClick: () => resetZoom(true) });
  const zoomControls = h('div', { class: 'zoom-controls', role: 'group', 'aria-label': 'Zoom' }, zoomOut, zoomReset, zoomIn);

  // One color opacity for every hold, beside the zoom.
  const opacityValue = h('span', { class: 'opacity-value' });
  const opacityRange = h('input', {
    type: 'range', min: 0, max: 100, step: 1, value: Math.round(holdOpacity() * 100), 'aria-label': 'Hold color opacity',
    onInput: () => {
      setHoldOpacity(Number(opacityRange.value) / 100);
      opacityValue.textContent = `${opacityRange.value}%`;
    },
  });
  opacityValue.textContent = `${opacityRange.value}%`;
  const opacityControl = h('label', { class: 'opacity-control', title: 'Color opacity of every hold' },
    h('span', { class: 'opacity-label' }, 'Color'), opacityRange, opacityValue);
  (zoomHost || container).append(opacityControl, zoomControls);

  function clampView(v) {
    const w = Math.min(base.w, Math.max(base.w / MAX_ZOOM, v.w));
    const ht = (w * base.h) / base.w;
    return {
      x: Math.min(base.x + base.w - w, Math.max(base.x, v.x)),
      y: Math.min(base.y + base.h - ht, Math.max(base.y, v.y)),
      w,
      h: ht,
    };
  }

  // `final` is false only for the in-between frames of an animation.
  function applyView(v, final = true) {
    view = clampView(v);
    if (final) goal = view;
    root.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    const k = zoomLevel();
    root.style.setProperty('--zoom', k);   // keeps grid lines hairline (app.css)
    zoomReset.textContent = `${Math.round(k * 10) / 10}×`;
    zoomOut.disabled = !zoomed();
    zoomIn.disabled = k >= MAX_ZOOM - 0.001;
    container.classList.toggle('zoomed', zoomed());
    zoomControls.classList.toggle('zoomed', zoomed());
    sizeVertices();
    sizeOutlines();
  }

  applyView(base);

  function animateTo(v, animate) {
    cancelAnimationFrame(viewAnim);
    const target = clampView(v);
    if (!animate || reducedMotion()) {
      applyView(target);
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
    };
    viewAnim = requestAnimationFrame(step);
  }

  // Zoom to `k`, keeping wall point (fx, fy) where it is on screen.
  function zoomAt(k, fx, fy, animate = false) {
    const w = base.w / Math.min(MAX_ZOOM, Math.max(1, k));
    const ht = (w * base.h) / base.w;
    animateTo({ x: fx - ((fx - view.x) / view.w) * w, y: fy - ((fy - view.y) / view.h) * ht, w, h: ht }, animate);
  }

  // Buttons and keys: zoom around the centre of what is shown (or about to be,
  // when a zoom is still animating), so quick repeated presses add up.
  function zoomBy(factor) {
    const w = base.w / Math.min(MAX_ZOOM, Math.max(1, (base.w / goal.w) * factor));
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

  // Wall inches under a screen point.
  const toWall = (e) => {
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(root.getScreenCTM().inverse());
    return { x: p.x, y: p.y };
  };

  // Ctrl/⌘ + wheel (also a trackpad pinch) zooms at the pointer, in every view;
  // a plain wheel pans once zoomed in (and scrolls the page as usual when not).
  root.addEventListener('wheel', (e) => {
    const lines = e.deltaMode === 1 ? 16 : 1;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const p = toWall(e);
      zoomAt(zoomLevel() * Math.exp(-e.deltaY * lines * 0.01), p.x, p.y);
    } else if (zoomed()) {
      e.preventDefault();
      const perPx = view.w / root.getBoundingClientRect().width;
      animateTo({ ...view, x: view.x + e.deltaX * lines * perPx, y: view.y + e.deltaY * lines * perPx });
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
  let pan = null;              // { id, at, view, moved } a press that may turn into a pan
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
    p.px = view.w / root.getBoundingClientRect().width;
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

  // While dragging near the board's edge, zoomed in: pan that way, and keep
  // the hold under the pointer.
  function edgePan() {
    edgeFrame = 0;
    if (!dragging || !zoomed() || !last) return;
    const r = root.getBoundingClientRect();
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
      cancelAnimationFrame(viewAnim);
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
      pan = { id: e.pointerId, at, view: { ...view }, moved: false };
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
      const r = root.getBoundingClientRect();
      const w = base.w / Math.min(MAX_ZOOM, Math.max(1, (pinch.k * dist) / pinch.dist));
      const ht = (w * base.h) / base.w;
      applyView({ x: pinch.anchor.x - ((mid.clientX - r.left) / r.width) * w, y: pinch.anchor.y - ((mid.clientY - r.top) / r.height) * ht, w, h: ht });
      return;
    }
    if (pan && pan.id === e.pointerId) {
      if (e.pointerType === 'mouse' && !e.buttons) {
        endPan();   // released somewhere we didn't hear about
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
      const perPx = pan.view.w / root.getBoundingClientRect().width;
      applyView({ ...pan.view, x: pan.view.x - dx * perPx, y: pan.view.y - dy * perPx });
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
      }
      return;
    }
    if (!touches.size) settling = false;
    if (pan && pan.id === e.pointerId) endPan();
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

  // Corner handles stay about the same size on screen at any zoom.
  function sizeVertices() {
    const width = root.getBoundingClientRect().width;
    if (!width) return;
    const r = Math.max(0.45, (VERTEX_PX * view.w) / width);
    volumeDraftLayer.querySelectorAll('.volume-vertex').forEach((c) => c.setAttribute('r', c.classList.contains('face') ? r * 0.75 : r));
  }

  // The holds' white border stays BORDER_PX wide on screen at any zoom: whole
  // device pixels at full strength, and the fraction left over as one more
  // pixel at that fraction of the strength (0.75 px is 1 solid + 1 half pixel
  // on a 2× screen; on a 1× screen, one pixel at 75%). The role rings' bands
  // (RING_BANDS) are whole pixels, each at least one wide.
  function sizeOutlines() {
    const width = root.getBoundingClientRect().width;
    if (!width) return;
    const dpr = window.devicePixelRatio || 1;
    const device = BORDER_PX * dpr;
    const whole = Math.floor(device + 1e-6);
    const outer = (device - whole) * BORDER_OPACITY;
    // A quarter pixel more than the whole pixels wanted, as browsers round
    // (Chrome) or truncate the radius to whole pixels.
    const radius = (px) => (((px + 0.25) / dpr) * view.w) / width;
    borderInner.setAttribute('radius', radius(Math.max(whole, 1)));
    borderOuter.setAttribute('radius', radius(whole + 1));
    // Over the outer fill, the inner one tops the border up to BORDER_OPACITY.
    innerFlood.setAttribute('flood-opacity', whole ? (BORDER_OPACITY - outer) / (1 - outer) : 0);
    outerFlood.setAttribute('flood-opacity', outer);
    for (const grows of ringGrows) {
      let edge = 0;   // device pixels out from the hold's edge
      for (const [grow, px] of grows) {
        edge = Math.max(edge + 1, Math.round(px * dpr));
        grow.setAttribute('radius', radius(edge));
      }
    }
  }
  new ResizeObserver(sizeOutlines).observe(root);
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
  function showNearest(n) {
    nearLabels.forEach((t) => t.classList.remove('near'));
    nearLabels = [];
    if (!n) {
      nearGuides.replaceChildren();
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
    tnut.setAttribute('transform', `translate(${d.nearest.x} ${d.nearest.y})`);
    for (const [k, v] of Object.entries({ x1: d.x, y1: d.y, x2: d.nearest.x, y2: d.nearest.y })) guide.setAttribute(k, v);
    reveal(d.x, d.y);
  }

  // The zoom carries over between modes of the same view (e.g. from picking a
  // hold to placing it); a new view starts from the whole wall (reset()).
  function setMode(mode) {
    root.dataset.mode = mode;
  }

  return {
    setHolds,
    // Show a route's holds. `dim` fades every hold not on the route.
    setRoute(routeHolds, { dim = true } = {}) {
      roles = toRoleMap(routeHolds);
      dimOthers = dim;
      paint();
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
    setDraft,
    setVolumes,
    setHiddenVolume,
    setVolumeDraft,
    highlightVolume,
    reset() {
      roles = new Map();
      preview = null;
      dimOthers = true;
      spotlit = null;
      picked = new Set();
      hiddenId = null;
      setMode('view');
      resetZoom();
      setDraft(null);
      setVolumeDraft(null);
      setHiddenVolume(null);
      highlightVolume(null);
      paint();
    },
  };
}
