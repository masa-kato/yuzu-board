// Small DOM helpers shared by the views.

import { icon } from './icons.js';

export { icon };

const SVG_NS = 'http://www.w3.org/2000/svg';

// Appends children, skipping null/false (unlike Element.append, which would
// insert them as text).
export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

// h('button', { class: 'btn', onClick: fn }, 'Save')
// Children are appended before attributes are applied so that `value` on a
// <select> picks one of its options.
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  append(el, children);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value' || key === 'checked' || key === 'selected' || key === 'disabled') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  return el;
}

export function svg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value != null) el.setAttribute(key, value);
  }
  append(el, children);
  return el;
}

// ---- scrolling lists ----------------------------------------------------------

// For views whose list scrolls under fixed controls: remembers the list's
// scroll position in `store[key]` across visits, and marks `root` as
// `scrolled` (CSS shades the controls' bottom edge) once it leaves the top.
// With `page`, where the page scrolls instead of the list (phones), it
// remembers the page's.
export function trackListScroll(root, scroller, store, key, { page = false } = {}) {
  let frame = 0;
  scroller.addEventListener('scroll', () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      store[key] = scroller.scrollTop;
      root.classList.toggle('scrolled', scroller.scrollTop > 2);
    });
  }, { passive: true });
  const pageScrolls = () => page && scroller.scrollHeight <= scroller.clientHeight + 1;
  const onPageScroll = () => {
    if (pageScrolls()) store[key] = window.scrollY;
  };
  if (page) window.addEventListener('scroll', onPageScroll, { passive: true });
  return {
    restore() {
      if (pageScrolls()) window.scrollTo(0, store[key] || 0);
      else scroller.scrollTop = store[key] || 0;
    },
    reset() {
      scroller.scrollTop = 0;
      store[key] = 0;
    },
    stop() {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onPageScroll);
    },
  };
}

// ---- dates ---------------------------------------------------------------

export function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// "Nov 17", with the year only when it isn't this one.
export function shortDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  const year = d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year });
}

// ---- small components ----------------------------------------------------

// Easiest first. Warm-up sits below Easy.
export const GRADES = ['warmup', 'easy', 'medium', 'hard', 'project'];
export const ROLES = ['start', 'hand', 'foot', 'finish'];
export const ROLE_LABELS = { start: 'Start', hand: 'Hand', foot: 'Foot', finish: 'Finish' };

export function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const GRADE_LEVEL = { warmup: 0, easy: 1, medium: 2, hard: 3, project: 4 };

export const gradeLabel = (grade) => (grade === 'warmup' ? 'Warm-up' : cap(grade));

// Warm-up's mark: a leaf sprouting from a mound of soil (animated in app.css).
// The soil is drawn last, so the plant grows up from behind it and sinks back.
function sprout() {
  const green = 'var(--leaf-text)';
  return svg('svg', { class: 'sprout', viewBox: '0 0 18 12', width: 18, height: 12 },
    svg('g', { class: 'sprout-plant' },
      svg('path', { class: 'sprout-stem', d: 'M9 11V5', stroke: green, 'stroke-width': 1.3, 'stroke-linecap': 'round' }),
      svg('path', { class: 'sprout-leaf left', d: 'M9 5.4C6.6 5.8 4.6 4.4 4.2 2.1C6.6 1.9 8.6 3.2 9 5.4Z', fill: green }),
      svg('path', { class: 'sprout-leaf right', d: 'M9 5.4C11.4 5.8 13.4 4.4 13.8 2.1C11.4 1.9 9.4 3.2 9 5.4Z', fill: green })),
    svg('path', { d: 'M1.5 12C3 9.4 6 8.6 9 8.6S15 9.4 16.5 12Z', fill: '#7a5530' }));
}

// A grade as one to four little yuzu, plus its name unless `label` is false.
// Warm-up, below them all, is a leaf sprouting instead.
export function gradePips(grade, { label = true } = {}) {
  const level = GRADE_LEVEL[grade] || 0;
  const name = gradeLabel(grade);
  const pips = grade === 'warmup'
    ? h('span', { class: 'pips sprout-pips', 'aria-hidden': 'true' }, sprout())
    : h('span', { class: 'pips', 'aria-hidden': 'true' },
      [1, 2, 3, 4].map((i) => h('span', { class: `pip${i <= level ? ' on' : ''}${grade === 'project' && i === 4 ? ' project' : ''}` })));
  return h('span', { class: `grade grade-${grade}`, title: `Grade: ${name}`, ...(label ? {} : { role: 'img', 'aria-label': `Grade: ${name}` }) },
    pips, label && h('span', { class: 'grade-label' }, name));
}

// The mark on a climb you've sent: a slice of yuzu, its rind, pith and eight
// segments (the wedges are worked out once). Half a slice, cut straight
// across, marks a climb one of whose variations you've sent.
const SLICE_WEDGES = Array.from({ length: 8 }, (_, i) => {
  const at = (r, deg) => {
    const a = (deg * Math.PI) / 180;
    return `${(10 + r * Math.cos(a)).toFixed(2)} ${(10 + r * Math.sin(a)).toFixed(2)}`;
  };
  const a0 = i * 45 + 5;
  const a1 = (i + 1) * 45 - 5;
  return `M${at(1.3, a0)}L${at(6.3, a0)}A6.3 6.3 0 0 1 ${at(6.3, a1)}L${at(1.3, a1)}Z`;
});

export function sentMark(size = 16, { half = false } = {}) {
  // A disc of radius r, or its top half.
  const disc = (r, fill) => (half
    ? svg('path', { d: `M${10 - r} 10A${r} ${r} 0 0 1 ${10 + r} 10Z`, fill })
    : svg('circle', { cx: 10, cy: 10, r, fill }));
  const wedges = half ? SLICE_WEDGES.slice(4) : SLICE_WEDGES;   // the top four
  return h('span', { class: `sent-mark${half ? ' half' : ''}`, title: half ? "You've sent a variation" : "You've sent this" },
    svg('svg', {
      viewBox: half ? '0 0 20 10.6' : '0 0 20 20', width: size, height: half ? (size * 10.6) / 20 : size,
      role: 'img', 'aria-label': half ? 'A variation sent' : 'Sent',
    },
    disc(9.6, '#b9860a'),
    disc(8.7, '#edbb1c'),
    disc(7.4, '#fff4cc'),
    svg('path', { d: wedges.join(''), fill: '#ffd23f', stroke: '#ffd23f', 'stroke-width': 0.5, 'stroke-linejoin': 'round' }),
    // the cut face, closing the half off
    half && svg('path', { d: 'M0.9 10H19.1', stroke: '#b9860a', 'stroke-width': 1.2, 'stroke-linecap': 'round' }),
    svg('path', { d: 'M5.2 6.4A6.6 6.6 0 0 1 9 3.6', fill: 'none', stroke: '#fff', 'stroke-width': 1.1, 'stroke-linecap': 'round', opacity: 0.75 })));
}

export function faBadge() {
  return h('span', { class: 'badge fa', title: 'First ascent' }, icon('star', { size: 12 }), 'FA');
}

export function roleDot(role) {
  return h('span', { class: `role-dot role-${role}` });
}

export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint && h('span', { class: 'field-hint' }, hint));
}

export function climberOptions(climbers, selected, emptyLabel) {
  return [
    emptyLabel != null && h('option', { value: '' }, emptyLabel),
    ...climbers.map((c) => h('option', { value: c.id, selected: c.id === selected }, c.name)),
  ];
}

// ---- feedback ------------------------------------------------------------

const TOAST_ICONS = { success: 'check', celebrate: 'star', error: 'alert', info: 'info' };

let toastTimer;
export function toast(message, kind = 'info') {
  const el = document.getElementById('toast');
  el.replaceChildren(icon(TOAST_ICONS[kind] || 'info', { size: 16 }), h('span', {}, message));
  el.className = `toast show toast-${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), kind === 'celebrate' ? 3600 : 2800);
}

// A short burst of little yuzu (and, for big moments, leaves) from `anchor`.
// Lives on <body> so it survives the view re-rendering underneath it.
export function celebrate(anchor, { big = false } = {}) {
  if (!anchor || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = anchor.getBoundingClientRect();
  const layer = h('div', { class: 'celebrate', 'aria-hidden': 'true', style: `left:${box.left + box.width / 2}px;top:${box.top + box.height / 2}px` });
  const count = big ? 14 : 8;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
    const distance = (big ? 70 : 44) + Math.random() * (big ? 46 : 20);
    layer.append(h('span', {
      class: `burst ${big && i % 3 === 0 ? 'leaf' : 'fruit'}`,
      style: `--dx:${(Math.cos(angle) * distance).toFixed(1)}px;--dy:${(Math.sin(angle) * distance).toFixed(1)}px;`
        + `--rot:${Math.round(Math.random() * 240 - 120)}deg;--delay:${Math.round(Math.random() * 80)}ms`,
    }));
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 1200);
}

// Opens a <dialog>. `body` is a node; resolves with the button value or null.
// `className` is added to the dialog's own (e.g. to size one differently).
export function dialog({ title, body, actions, className = '' }) {
  return new Promise((resolve) => {
    const form = h('form', { method: 'dialog', class: 'dialog-form' },
      h('h2', { class: 'dialog-title' }, title),
      body,
      h('div', { class: 'dialog-actions' },
        actions.map((a) => h('button', { value: a.value, class: `btn ${a.class || ''}`, type: a.value === 'cancel' ? 'button' : 'submit', formnovalidate: a.value === 'cancel' }, a.label))));
    const el = h('dialog', { class: `dialog ${className}`.trim() }, form);
    form.querySelectorAll('button[value=cancel]').forEach((b) => b.addEventListener('click', () => el.close('cancel')));
    el.addEventListener('close', () => {
      el.remove();
      resolve(el.returnValue && el.returnValue !== 'cancel' ? el.returnValue : null);
    });
    document.body.append(el);
    el.showModal();
  });
}

export async function confirmDialog(title, message, confirmLabel = 'Delete', confirmClass = 'btn-danger') {
  const result = await dialog({
    title,
    body: h('p', { class: 'muted' }, message),
    actions: [{ value: 'cancel', label: 'Cancel' }, { value: 'ok', label: confirmLabel, class: confirmClass }],
  });
  return result === 'ok';
}

export async function promptDialog(title, label, placeholder = '', { value = '', confirmLabel = 'Add', maxLength, type = 'text' } = {}) {
  const input = h('input', {
    type, class: 'input', required: true, placeholder, value, maxlength: maxLength,
    autocomplete: type === 'password' ? 'current-password' : 'off',
  });
  const result = await dialog({
    title,
    body: field(label, input),
    actions: [{ value: 'cancel', label: 'Cancel' }, { value: 'ok', label: confirmLabel, class: 'btn-primary' }],
  });
  return result === 'ok' ? input.value.trim() : null;
}
