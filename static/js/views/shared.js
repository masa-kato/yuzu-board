// What more than one view needs: the climb list's query and its Active |
// Legacy | Drafts switch (climbs.js, drafts.js, and routeDetail.js, which
// steps through the same list), and the circuit name limit (circuits.js,
// routeDetail.js).

import { h } from '../ui.js';

export const CIRCUIT_NAME_MAX = 80;   // as CIRCUIT_NAME_MAX in circuits.py

// The /api/routes query for the list as it is filtered and sorted now.
export function listQuery(state, legacy) {
  const f = legacy ? state.legacyFilters : state.filters;
  return {
    q: f.q.trim(),
    scope: f.scope,
    grade: f.grades.join(','),
    hold_id: legacy ? null : f.holdId,
    me: state.me,
    hide_sent_by: f.hideSent && state.me ? state.me : null,
    legacy: legacy ? 1 : null,
    sort: f.sort,
    dir: f.dir,
  };
}

// Active | Legacy | Drafts, with how many legacy routes and drafts there are.
export function listSwitch(ctx, current) {
  // The counts last seen show at once, until the fresh ones arrive.
  const known = ctx.state.listCounts;
  const counts = {
    legacy: h('span', { class: 'segment-count' }, known.legacy || ''),
    drafts: h('span', { class: 'segment-count' }, known.drafts || ''),
  };
  const show = (key) => (items) => {
    known[key] = items.length ? String(items.length) : '';
    if (!ctx.stale()) counts[key].textContent = known[key];
  };
  ctx.api.routes({ legacy: 1 }).then(show('legacy')).catch(() => {});
  ctx.api.drafts().then(show('drafts')).catch(() => {});
  const link = (key, label) => h('a', { href: `#/${key}`, 'aria-current': key === current ? 'page' : null }, label, counts[key]);
  return h('nav', { class: 'segmented-nav', 'aria-label': 'Which routes' },
    link('climbs', 'Active'), link('legacy', 'Legacy'), link('drafts', 'Drafts'));
}
