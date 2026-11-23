// The shared color list (state.colors, from /api/colors): a color field for
// forms, and the dialogs that edit the list. Holds store the hex itself, so
// the server recolors the holds in a color when its hex changes.

import { append, confirmDialog, h, icon, plural } from './ui.js';

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
const NEW_COLOR = '#888888';

// '#abc', 'ABC' or '#AABBCC' → '#aabbcc'; null if it isn't a color.
export function normalizeHex(text) {
  const m = HEX_RE.exec(String(text).trim());
  if (!m) return null;
  const digits = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return `#${digits.toLowerCase()}`;
}

export const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
export const rgbToHex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

export function colorName(colors, hex) {
  return colors.find((c) => c.hex === hex)?.name ?? null;
}

let menuSeq = 0;
const hexNote = (note) => (note.startsWith('#') ? ' mono' : '');

// A color's square: `color` is a hex, '' for none (striped), 'custom' for the
// rainbow of "Custom…", or null for nothing chosen yet (dashed).
function swatch(color, cls = '') {
  const kind = color == null ? ' unset' : !color ? ' none' : color === 'custom' ? ' custom' : '';
  return h('span', { class: `color-swatch${kind}${cls ? ` ${cls}` : ''}`, style: kind ? null : `background:${color}` });
}

// A color dropdown with the list's colors (plus "None" and "Custom…"), each
// shown with its square, and an Edit colors button that opens the list. The
// value is '#rrggbb', '' for the hold's original colors, or null while nothing
// is chosen (only with a `placeholder`). If the list changes the hex of the
// chosen color, the field follows it and reports the new value.
export function colorField(ctx, { value = '', onChange, placeholder = null }) {
  let current = value;
  const isListed = (hex) => ctx.state.colors.some((c) => c.hex === hex);
  // "Custom…" stays chosen once picked (its picker showing), even while the
  // picked value happens to match a color in the list.
  let customMode = !!value && !isListed(value);
  const custom = h('input', {
    type: 'color', class: 'color-input', 'aria-label': 'Custom color', value: value || '#7a0404',
    onInput: () => set(custom.value),
  });
  // A popover list rather than a <select>, whose options can't show a color.
  // It lives in the top layer, so the scrolling panel doesn't clip it.
  const menu = h('div', { class: 'color-menu', id: `color-menu-${++menuSeq}`, popover: 'manual', role: 'listbox', 'aria-label': 'Hold color' });
  const trigger = h('button', {
    type: 'button', class: 'input color-select', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': menu.id,
    onClick: () => (isOpen() ? close() : open()),
    onKeydown: (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      e.stopPropagation();   // not a nudge for the hold being placed
      open();
    },
  });
  const chosen = () => (current == null ? null : !current ? '' : customMode ? 'custom' : current);

  function fill() {
    if (current && !isListed(current)) customMode = true;
    const key = chosen();
    const listed = ctx.state.colors.find((c) => c.hex === key);
    const [name, note] = key == null ? [placeholder, '']
      : !key ? ['None', 'original colors']
        : listed ? [listed.name, listed.hex.toUpperCase()] : ['Custom', current.toUpperCase()];
    trigger.replaceChildren();
    append(trigger, [swatch(key === 'custom' ? current : key),
      h('span', { class: `color-select-name${key == null ? ' placeholder' : ''}` }, name),
      note && h('span', { class: `color-select-note${hexNote(note)}` }, note)]);
    trigger.setAttribute('aria-label', `Hold color: ${name}${note ? ` ${note}` : ''}`);

    const option = (v, label, optionNote, color) => h('div', {
      role: 'option', class: 'color-option', tabindex: -1, 'aria-selected': String(v === key), dataset: { value: v },
      onClick: () => choose(v),
    }, swatch(color), h('span', { class: 'color-option-name' }, label), h('span', { class: `color-option-note${hexNote(optionNote)}` }, optionNote),
    h('span', { class: 'color-option-check' }, v === key && icon('check', { size: 14 })));
    menu.replaceChildren();
    append(menu, [
      option('', 'None', 'original colors', ''),
      ctx.state.colors.map((c) => option(c.hex, c.name, c.hex.toUpperCase(), c.hex)),
      option('custom', 'Custom…', key === 'custom' ? current.toUpperCase() : 'pick any color', 'custom')]);

    custom.hidden = key !== 'custom';
    if (current) custom.value = current;
  }

  function set(v) {
    current = v;
    fill();
    onChange?.(current);
  }

  function choose(v) {
    close();
    trigger.focus();
    customMode = v === 'custom';
    set(customMode ? custom.value : v);
  }

  // ---- the menu: opens under the field (or above it, when there's more room
  // there), follows it as the page scrolls, and closes on a press elsewhere.
  const isOpen = () => menu.matches(':popover-open');

  function place() {
    const r = trigger.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, 240), innerWidth - 16);
    const below = innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const down = below >= Math.min(menu.scrollHeight, 280) || below >= above;
    Object.assign(menu.style, {
      width: `${width}px`,
      left: `${Math.max(8, Math.min(r.left, innerWidth - width - 8))}px`,
      top: down ? `${r.bottom + 4}px` : 'auto',
      bottom: down ? 'auto' : `${innerHeight - r.top + 4}px`,
      maxHeight: `${Math.max(120, Math.min(down ? below : above, 420))}px`,
    });
  }

  const onPress = (e) => {
    if (!menu.contains(e.target) && !trigger.contains(e.target)) close();
  };
  const onScroll = (e) => {
    if (!trigger.isConnected) close();
    else if (!menu.contains(e.target)) place();
  };

  function open() {
    if (isOpen()) return;
    fill();
    menu.showPopover();
    place();
    trigger.setAttribute('aria-expanded', 'true');
    (menu.querySelector('[aria-selected="true"]') || menu.firstElementChild).focus();
    document.addEventListener('pointerdown', onPress, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
  }

  function close() {
    if (isOpen()) menu.hidePopover();
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onPress, true);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', place);
  }

  // Arrows, Home/End and a letter move through the options; Enter or Space
  // chooses; Esc and Tab close. None of it reaches the board's own keys.
  menu.addEventListener('keydown', (e) => {
    e.stopPropagation();
    const options = [...menu.children];
    const i = options.indexOf(document.activeElement);
    const go = (j) => {
      e.preventDefault();
      options[Math.max(0, Math.min(options.length - 1, j))].focus();
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(options.length - 1);
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (i >= 0) choose(options[i].dataset.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
      trigger.focus();
    } else if (e.key === 'Tab') {
      close();
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      // The next option whose name starts with the letter, wrapping around.
      const letter = e.key.toLowerCase();
      const next = [...options.slice(i + 1), ...options.slice(0, i + 1)]
        .find((o) => o.querySelector('.color-option-name').textContent.toLowerCase().startsWith(letter));
      if (next) go(options.indexOf(next));
    }
  });

  const edit = h('button', {
    type: 'button', class: 'btn btn-small', title: 'Change, add or remove colors in the list',
    onClick: (e) => {
      e.preventDefault();   // inside a <label>, don't also open the menu
      close();
      openColorList(ctx, {
        onChange: ({ oldHex, newHex } = {}) => {
          if (oldHex && current === oldHex) set(newHex);
          else fill();
        },
      });
    },
  }, icon('pencil', { size: 13 }), 'Edit colors');

  fill();
  return {
    el: h('div', { class: 'color-field' }, h('div', { class: 'color-row' }, trigger, custom), menu, edit),
    get value() {
      return current;
    },
    set value(v) {
      current = v;
      fill();
    },
  };
}

// The color list: every color with its hold count, Edit, and × for colors no
// hold uses; "Add a color" at the end. `onChange({ oldHex, newHex })` runs
// after each change (both hexes are set when a color's hex changed).
export function openColorList(ctx, { onChange } = {}) {
  const list = h('div', { class: 'color-list' });
  const el = h('dialog', { class: 'dialog color-list-dialog' },
    h('div', { class: 'dialog-form' },
      h('h2', { class: 'dialog-title' }, 'Colors'),
      h('p', { class: 'muted small' }, 'The colors offered for holds, for everyone. Changing a color recolors every hold in it.'),
      list,
      h('button', { type: 'button', class: 'btn btn-small add-color', onClick: () => editColor(null) }, icon('plus', { size: 14 }), 'Add a color'),
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onClick: () => el.close() }, 'Done'))));

  function draw() {
    list.replaceChildren(...ctx.state.colors.map((c) => h('div', { class: 'color-list-row' },
      h('span', { class: 'color-swatch', style: `background:${c.hex}` }),
      h('span', { class: 'color-list-name' }, c.name, h('span', { class: 'color-list-hex' }, c.hex.toUpperCase())),
      h('span', { class: 'color-list-count' }, c.holds ? plural(c.holds, 'hold') : 'Unused'),
      h('button', { type: 'button', class: 'btn btn-small', 'aria-label': `Edit ${c.name}`, onClick: () => editColor(c) }, 'Edit'),
      c.holds
        ? h('span', { class: 'color-list-gap', title: `${c.name} is in use, so it can't be removed` })
        : h('button', { type: 'button', class: 'icon-btn danger', title: `Remove ${c.name}`, 'aria-label': `Remove ${c.name}`, onClick: () => remove(c) }, icon('x', { size: 14 })))));
  }

  async function editColor(color) {
    const saved = await colorEditor(ctx, color);
    if (!saved) return;
    await ctx.refreshColors();
    if (saved.recolored) await ctx.refreshHolds();
    draw();
    ctx.toast(color
      ? `${saved.color.name} saved${saved.recolored ? `; ${plural(saved.recolored, 'hold')} recolored` : ''}.`
      : `${saved.color.name} added.`, 'success');
    onChange?.(color && color.hex !== saved.color.hex ? { oldHex: color.hex, newHex: saved.color.hex } : {});
  }

  async function remove(color) {
    if (!(await confirmDialog(`Remove ${color.name}?`, 'It leaves the color list. No hold uses it, so nothing on the wall changes.', 'Remove'))) return;
    try {
      await ctx.api.deleteColor(color.id);
      await ctx.refreshColors();
      draw();
      onChange?.({});
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  el.addEventListener('close', () => el.remove());
  draw();
  document.body.append(el);
  el.showModal();
  // Hold counts change whenever a hold is saved, so fetch them fresh.
  ctx.refreshColors().then(draw).catch((err) => ctx.toast(err.message, 'error'));
}

// Edit one color (or make a new one, `color` null): its name, and its value
// typed as HEX or RGB, or picked. Resolves to the server's answer
// ({ color, recolored }) once saved, or null if cancelled.
function colorEditor(ctx, color) {
  return new Promise((resolve) => {
    let value = color?.hex ?? NEW_COLOR;
    let mode = 'hex';
    let result = null;

    const name = h('input', { type: 'text', class: 'input', required: true, maxlength: 24, autocomplete: 'off', value: color?.name ?? '', placeholder: 'e.g. Mint', onInput: sync });
    const picker = h('input', { type: 'color', class: 'color-input color-picker', 'aria-label': 'Pick a color', value, onInput: () => show(picker.value) });
    const hex = h('input', { type: 'text', class: 'input mono', 'aria-label': 'Hex', spellcheck: false, autocomplete: 'off', placeholder: '#1E3A8A', onInput: () => { value = normalizeHex(hex.value); sync(); } });
    const rgb = ['R', 'G', 'B'].map((c) => h('input', {
      type: 'number', class: 'input', min: 0, max: 255, step: 1, inputmode: 'numeric', 'aria-label': c,
      onInput: () => {
        const v = rgb.map((i) => (i.value.trim() === '' ? NaN : Number(i.value)));
        value = v.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? rgbToHex(v) : null;
        sync();
      },
    }));
    const hexRow = h('div', { class: 'color-value-row' }, hex);
    const rgbRow = h('div', { class: 'color-value-row rgb' },
      rgb.map((input, i) => h('label', { class: 'rgb-field' }, h('span', {}, 'RGB'[i]), input)));
    const modeSeg = (m, label) => h('label', { class: 'seg' },
      h('input', { type: 'radio', name: 'color-mode', value: m, checked: m === mode, onChange: () => switchMode(m) }),
      h('span', {}, label));
    const error = h('p', { class: 'field-hint error', role: 'alert' });
    const save = h('button', { type: 'submit', class: 'btn btn-primary' }, color ? 'Save' : 'Add color');

    // Writes `v` into every input (except the one being typed in) and redraws.
    function show(v) {
      value = v;
      hex.value = v.toUpperCase();
      hexToRgb(v).forEach((n, i) => (rgb[i].value = n));
      sync();
    }

    function switchMode(m) {
      mode = m;
      if (value) show(value);
      hexRow.hidden = mode !== 'hex';
      rgbRow.hidden = mode !== 'rgb';
    }

    function sync() {
      if (value) picker.value = value;
      error.textContent = value ? '' : mode === 'hex' ? 'Enter 6 hex digits, like #1E3A8A' : 'R, G and B are whole numbers from 0 to 255';
      save.disabled = !value || !name.value.trim();
    }

    const form = h('form', {
      class: 'dialog-form color-editor',
      onSubmit: async (e) => {
        e.preventDefault();
        if (!value || !name.value.trim()) return;
        save.disabled = true;
        try {
          const data = { name: name.value.trim(), hex: value };
          result = color
            ? await ctx.api.updateColor(color.id, data)
            : { color: await ctx.api.createColor(data), recolored: 0 };
          el.close();
        } catch (err) {
          error.textContent = err.message;
          save.disabled = false;
        }
      },
    },
    h('h2', { class: 'dialog-title' }, color ? `Edit ${color.name}` : 'New color'),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), name),
    h('div', { class: 'field' },
      h('span', { class: 'field-label' }, 'Color'),
      h('div', { class: 'color-editor-row' },
        picker,
        h('div', { class: 'color-editor-inputs' },
          h('div', { class: 'segmented two', role: 'radiogroup', 'aria-label': 'Type the color as' }, modeSeg('hex', 'HEX'), modeSeg('rgb', 'RGB')),
          hexRow, rgbRow)),
      error),
    color?.holds > 0 && h('p', { class: 'muted small' }, `Changing it recolors the ${plural(color.holds, 'hold')} in ${color.name}.`),
    h('div', { class: 'dialog-actions' },
      h('button', { type: 'button', class: 'btn', onClick: () => el.close() }, 'Cancel'),
      save));

    const el = h('dialog', { class: 'dialog' }, form);
    el.addEventListener('close', () => {
      el.remove();
      resolve(result);
    });
    show(value);
    switchMode('hex');
    document.body.append(el);
    el.showModal();
    (color ? hex : name).focus();
  });
}
