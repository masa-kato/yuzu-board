// The Wall tab's Recolor holds: select holds on the board or by their color,
// then give them all one new color.

import { colorField, colorName } from '../../palette.js';
import { h, icon, plural } from '../../ui.js';

// `tab` is the Wall tab's { show, select }.
export function holdRecolor(ctx, tab) {
  const { state } = ctx;
  let recolor = null;     // { ids: Set of hold ids, color: '#rrggbb' | '' (none) | null (not chosen) }

  function start() {
    recolor = { ids: new Set(), color: null };
    tab.select(null);
    tab.show();
  }

  function end() {
    recolor = null;
    tab.show();
  }

  function panel() {
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
          tab.show();
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
      h('button', { type: 'button', class: 'back-link', onClick: end }, icon('arrow-left', { size: 15 }), 'Done'),
      h('h1', {}, 'Recolor holds'),
      h('p', { class: 'hint' }, 'Tap holds on the board to select them, or select every hold of a color below. Then pick their new color.'),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Select by color'),
        h('div', { class: 'color-chips' }, order.map(chip))),
      h('div', { class: 'recolor-count' },
        h('strong', {}, rc.ids.size ? `${plural(rc.ids.size, 'hold')} selected` : 'No holds selected'),
        rc.ids.size > 0 && h('button', { type: 'button', class: 'link', onClick: () => { rc.ids.clear(); tab.show(); } }, 'Clear')),
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
      tab.show();
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  return {
    get active() {
      return recolor != null;
    },
    get ids() {
      return recolor ? recolor.ids : null;
    },
    start,
    panel,
    // A tap on a hold selects it, or unselects it.
    onHoldClick(hold) {
      if (!hold.image_url) {
        ctx.toast('Placeholder holds have no image to color', 'error');
        return;
      }
      if (recolor.ids.has(hold.id)) recolor.ids.delete(hold.id);
      else recolor.ids.add(hold.id);
      tab.show();
    },
    // Esc is Done.
    onKey(e) {
      if (e.key === 'Escape') end();
    },
  };
}
