// A small set of stroke icons (24×24 grid, drawn in currentColor) so buttons
// and badges look the same on every device, unlike emoji.

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICONS = {
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  minus: [['path', { d: 'M5 12h14' }]],
  'arrow-left': [['path', { d: 'M19 12H5M11 18l-6-6 6-6' }]],
  'arrow-right': [['path', { d: 'M5 12h14M13 6l6 6-6 6' }]],
  'arrow-up': [['path', { d: 'M12 19V5M6 11l6-6 6 6' }]],
  'arrow-down': [['path', { d: 'M12 5v14M6 13l6 6 6-6' }]],
  sliders: [['path', { d: 'M4 7h10M18 7h2M4 17h4M12 17h8' }], ['circle', { cx: 16, cy: 7, r: 2 }], ['circle', { cx: 10, cy: 17, r: 2 }]],
  pencil: [['path', { d: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z' }], ['path', { d: 'M13.5 6.5l4 4' }]],
  trash: [['path', { d: 'M4 7h16M10 11v6M14 11v6M9 7V4.5h6V7M6 7l1 13h10l1-13' }]],
  dice: [
    ['rect', { x: 3.5, y: 3.5, width: 17, height: 17, rx: 4 }],
    ['circle', { cx: 8.5, cy: 8.5, r: 1.2, fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: 15.5, cy: 8.5, r: 1.2, fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: 12, cy: 12, r: 1.2, fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: 8.5, cy: 15.5, r: 1.2, fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: 15.5, cy: 15.5, r: 1.2, fill: 'currentColor', stroke: 'none' }],
  ],
  check: [['path', { d: 'M5 12.5l4.5 4.5L19 7' }]],
  star: [['path', { d: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8L12 3.5Z' }]],
  alert: [['path', { d: 'M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z' }], ['path', { d: 'M12 9.5v4M12 17h.01' }]],
  'rotate-left': [['path', { d: 'M4 4v5h5' }], ['path', { d: 'M4.6 15a8 8 0 1 0 1.8-8.3L4 9' }]],
  'rotate-right': [['path', { d: 'M20 4v5h-5' }], ['path', { d: 'M19.4 15a8 8 0 1 1-1.8-8.3L20 9' }]],
  undo: [['path', { d: 'M9 14 4 9l5-5' }], ['path', { d: 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11' }]],
  x: [['path', { d: 'M6 6l12 12M18 6 6 18' }]],
  search: [['circle', { cx: 11, cy: 11, r: 6.5 }], ['path', { d: 'm20 20-4.2-4.2' }]],
  'chevron-down': [['path', { d: 'M6 9l6 6 6-6' }]],
  upload: [['path', { d: 'M12 15V4M7 9l5-5 5 5' }], ['path', { d: 'M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3' }]],
  image: [['rect', { x: 3.5, y: 3.5, width: 17, height: 17, rx: 3 }], ['circle', { cx: 9, cy: 9, r: 1.8 }], ['path', { d: 'M20.5 15.5 15 10 5 20' }]],
  layers: [['path', { d: 'M12 3 3 8l9 5 9-5-9-5Z' }], ['path', { d: 'M3 13l9 5 9-5' }]],
  info: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M12 11v5M12 8h.01' }]],
  palette: [
    ['path', { d: 'M12 3.5a8.5 8.5 0 0 0 0 17c1.3 0 2-.8 2-1.8 0-1.3-1.2-1.7-1.2-2.9 0-1 .8-1.6 1.7-1.6h2.4a3.6 3.6 0 0 0 3.6-3.6c0-4-3.8-7.1-8.5-7.1Z' }],
    ['circle', { cx: 7.6, cy: 11.2, r: 1.2, fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: 9.8, cy: 7.4, r: 1.2, fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: 14.4, cy: 7.4, r: 1.2, fill: 'currentColor', stroke: 'none' }],
  ],
};

export function icon(name, { size = 16, label } = {}) {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('class', `icon icon-${name}`);
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('width', size);
  el.setAttribute('height', size);
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '1.9');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  if (label) {
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', label);
  } else {
    el.setAttribute('aria-hidden', 'true');
  }
  for (const [tag, attrs] of ICONS[name] || []) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, v);
    el.append(child);
  }
  return el;
}
