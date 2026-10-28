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
export function trackListScroll(root, scroller, store, key) {
  let frame = 0;
  scroller.addEventListener('scroll', () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      store[key] = scroller.scrollTop;
      root.classList.toggle('scrolled', scroller.scrollTop > 2);
    });
  }, { passive: true });
  return {
    restore() {
      scroller.scrollTop = store[key] || 0;
    },
    reset() {
      scroller.scrollTop = 0;
      store[key] = 0;
    },
    stop() {
      cancelAnimationFrame(frame);
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

// ---- small components ----------------------------------------------------

export const GRADES = ['easy', 'medium', 'hard', 'project'];
export const ROLES = ['start', 'hand', 'foot', 'finish'];
export const ROLE_LABELS = { start: 'Start', hand: 'Hand', foot: 'Foot', finish: 'Finish' };

export function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const GRADE_LEVEL = { easy: 1, medium: 2, hard: 3, project: 4 };

// A grade as one to four little yuzu, plus its name unless `label` is false.
export function gradePips(grade, { label = true } = {}) {
  const level = GRADE_LEVEL[grade] || 0;
  const name = cap(grade);
  const pips = h('span', { class: 'pips', 'aria-hidden': 'true' },
    [1, 2, 3, 4].map((i) => h('span', { class: `pip${i <= level ? ' on' : ''}${grade === 'project' && i === 4 ? ' project' : ''}` })));
  return h('span', { class: `grade grade-${grade}`, title: `Grade: ${name}`, ...(label ? {} : { role: 'img', 'aria-label': `Grade: ${name}` }) },
    pips, label && h('span', { class: 'grade-label' }, name));
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
export function dialog({ title, body, actions }) {
  return new Promise((resolve) => {
    const form = h('form', { method: 'dialog', class: 'dialog-form' },
      h('h2', { class: 'dialog-title' }, title),
      body,
      h('div', { class: 'dialog-actions' },
        actions.map((a) => h('button', { value: a.value, class: `btn ${a.class || ''}`, type: a.value === 'cancel' ? 'button' : 'submit', formnovalidate: a.value === 'cancel' }, a.label))));
    const el = h('dialog', { class: 'dialog' }, form);
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

export async function promptDialog(title, label, placeholder = '', { value = '', confirmLabel = 'Add', maxLength } = {}) {
  const input = h('input', { type: 'text', class: 'input', required: true, placeholder, value, maxlength: maxLength, autocomplete: 'off' });
  const result = await dialog({
    title,
    body: field(label, input),
    actions: [{ value: 'cancel', label: 'Cancel' }, { value: 'ok', label: confirmLabel, class: 'btn-primary' }],
  });
  return result === 'ok' ? input.value.trim() : null;
}
