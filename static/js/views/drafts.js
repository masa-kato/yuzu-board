import { enableSheet } from '../sheet.js';
import { fmtDate, gradePips, h, plural, trackListScroll } from '../ui.js';
import { listSwitch } from './shared.js';

// Climbs saved with Save draft and not published yet, shared by everyone.
// Opening one picks up the Set boulder form where it was left.
export async function render(root, ctx) {
  const { state, board } = ctx;
  const drafts = await ctx.api.drafts();
  if (ctx.stale()) return;

  const list = h('div', { class: 'route-list' });
  const scroller = h('div', { class: 'list-scroll' }, list);
  const scrolling = trackListScroll(root, scroller, state.listScroll, 'drafts');
  const listSheet = enableSheet(root.parentElement, scroller);   // on phones, a swipe up raises the list

  function card(d) {
    const roles = new Set(d.holds.map((x) => x.role));
    const missing = ['start', 'finish'].filter((r) => !roles.has(r));
    const saved = fmtDate(d.updated_at.slice(0, 10));
    const preview = () => board.preview(d.holds);
    const unpreview = () => board.preview(null);
    return h('article', { class: 'route-card draft-card', dataset: { draftId: d.id } },
      h('button', {
        type: 'button', class: 'route-main', onClick: () => ctx.go(`#/new?draft=${d.id}`),
        onMouseenter: preview, onMouseleave: unpreview, onFocus: preview, onBlur: unpreview,
      },
      h('div', { class: 'route-title' },
        gradePips(d.grade, { label: false }),
        d.name ? h('span', { class: 'route-name' }, d.name) : h('span', { class: 'route-name untitled' }, 'Untitled draft')),
      d.parent_id && h('div', { class: 'route-meta' }, `Variation of ${d.parent_name}`),
      h('div', { class: 'route-meta' }, d.saved_by_name ? `Saved by ${d.saved_by_name} · ${saved}` : `Saved ${saved}`),
      h('div', { class: 'route-meta' }, plural(d.holds.length, 'hold'), missing.length ? ` · needs ${missing.join(' and ')}` : '')));
  }

  // Outlines the draft just saved.
  function markLastSaved() {
    const id = state.lastDraftId;
    state.lastDraftId = null;
    const target = id && list.querySelector(`[data-draft-id="${id}"]`);
    if (!target) return;
    target.classList.add('recent');
    target.scrollIntoView({ block: 'nearest' });
  }

  const empty = h('div', { class: 'empty' }, 'No drafts. Press Save draft while setting a boulder to keep it here.',
    h('button', { type: 'button', class: 'btn btn-primary', onClick: () => ctx.go('#/new') }, 'Set a boulder'));
  list.replaceChildren(...(drafts.length ? drafts.map(card) : [empty]));

  root.classList.add('view-list');
  root.replaceChildren(
    h('div', { class: 'list-controls drafts-controls' },
      h('h1', { class: 'visually-hidden' }, 'Drafts'),
      h('div', { class: 'list-head' }, listSwitch(ctx, 'drafts'), h('span', { class: 'muted list-count' }, plural(drafts.length, 'draft')))),
    scroller);
  scrolling.restore();
  markLastSaved();

  return {
    destroy() {
      scrolling.stop();
      listSheet.stop();
    },
  };
}
