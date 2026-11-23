import { api } from './api.js';
import { createBoard, holdTitle, imagePpi } from './board.js';
import { settleSwipe } from './swipe.js';
import { GRADES, PHONE, h, promptDialog, toast } from './ui.js';
import * as climbs from './views/climbs.js';
import * as routeDetail from './views/routeDetail.js';
import * as editor from './views/editor.js';
import * as logbook from './views/logbook.js';
import * as holdsView from './views/holds.js';
import * as circuits from './views/circuits.js';
import * as stats from './views/stats.js';
import * as drafts from './views/drafts.js';
import * as outdoor from './views/outdoor.js';
import * as workout from './views/workout.js';
import * as fingers from './views/fingers.js';

const ME_KEY = 'homewall.me';
const PREFS_KEY = 'homewall.filters.v1';
// Every page, by the first part of its link (#/route/12?circuit=3 is `route`):
//   render  draws it: render(root, ctx, params), returning an optional handle
//           { destroy, onHoldClick, onHoldHover, onWallPointer } (docs/development.md)
//   params  what it takes from the rest of the link: (the part after the name, the ?query)
//   nav     the tab it's under (or a function of its params)
//   admin   only for the admin, logged in (auth.py); anyone else goes to the Logbook
//   computer  not on phones, which go to the Climbs list instead
//   layout  'calendar': calendar.js takes the wall's place; 'solo': the panel alone,
//           centered; otherwise the wall beside the panel
//   list    its controls stay put while only its list scrolls
//   pinned  and on phones the board stays pinned above that list
// A link to no page opens the Climbs list.
const idOf = (raw) => Number(raw) || null;
const PAGES = {
  climbs: { render: climbs.render, nav: 'climbs', list: true, pinned: true },
  legacy: { render: climbs.render, params: () => ({ legacy: true }), nav: 'climbs', list: true, pinned: true },
  drafts: { render: drafts.render, nav: 'climbs', list: true, pinned: true },
  // ?circuit= opens the climb as a step of that circuit.
  route: {
    render: routeDetail.render,
    params: (raw, q) => ({ routeId: Number(raw), circuitId: idOf(q.get('circuit')) }),
    nav: (p) => (p.circuitId ? 'circuits' : 'climbs'),
  },
  // ?parent= sets a variation of that climb; ?draft= picks up a saved draft.
  new: { render: editor.render, params: (_, q) => ({ parentId: idOf(q.get('parent')), draftId: idOf(q.get('draft')) }), nav: 'editor' },
  edit: { render: editor.render, params: (raw) => ({ routeId: Number(raw) }), nav: 'editor' },
  circuits: { render: circuits.render, nav: 'circuits', list: true },
  circuit: {
    render: circuits.renderDetail, params: (raw, q) => ({ circuitId: Number(raw), adding: q.get('add') === '1' }), nav: 'circuits', list: true,
  },
  holds: { render: holdsView.render, nav: 'holds', computer: true },
  stats: { render: stats.render, nav: 'stats', list: true },
  // ?day= opens that day, as a day picked on the calendar.
  logbook: { render: logbook.render, params: (_, q) => ({ day: q.get('day') }), nav: 'logbook', layout: 'calendar', list: true },
  // ?date= is the day (today by default); ?phase= start or end.
  fingers: {
    render: fingers.render, params: (_, q) => ({ date: q.get('date'), phase: q.get('phase') }), nav: 'logbook', admin: true, layout: 'calendar',
  },
  outdoors: {
    render: outdoor.renderOutdoors, params: (raw) => ({ tab: raw === 'sent' ? 'sent' : 'progress' }),
    nav: 'outdoors', admin: true, layout: 'solo', list: true,
  },
  outdoor: {
    render: outdoor.renderSession, params: (raw, q) => ({ sessionId: raw === 'new' ? null : idOf(raw), date: q.get('date') }),
    nav: 'outdoors', admin: true, layout: 'solo',
  },
  'outdoor-climb': { render: outdoor.renderClimb, params: (raw) => ({ climbId: Number(raw) }), nav: 'outdoors', admin: true, layout: 'solo' },
  // #/workout/exercises is the exercise list; otherwise ?date= is the day (today by default).
  workout: {
    render: (root, ctx, p) => (p.exercises ? workout.renderExercises(root, ctx) : workout.render(root, ctx, p)),
    params: (raw, q) => (raw === 'exercises' ? { exercises: true } : { date: q.get('date') }),
    nav: 'workout', admin: true, layout: 'calendar',
  },
  exercise: { render: workout.renderExercise, params: (raw) => ({ exerciseId: Number(raw) }), nav: 'workout', admin: true, layout: 'calendar' },
};
PAGES['outdoor-climbs'] = PAGES.outdoors;   // an old link to the climbs list

const defaultFilters = () => ({ q: '', scope: 'all', grades: [], hideSent: false, holdId: null, sort: 'set_date', dir: 'desc' });

const state = {
  spec: null,
  climbers: [],
  me: null,
  admin: false,         // logged in as the admin on this device (auth.py)
  adminId: null,        // the admin's climber id, if there is an admin
  holds: [],
  holdById: new Map(),
  holdNames: null,
  volumes: [],
  colors: [],           // the shared color list: { id, name, hex, holds }
  // Climb-list filters and the logbook toggle survive navigation and reloads.
  filters: defaultFilters(),
  legacyFilters: defaultFilters(),
  logShowRepeats: true,
  statsUnusedOnly: false,  // the Stats tab shows only the unused holds
  statsVariations: true,   // and counts variations as climbs of their own
  listScroll: {},       // scrollTop per list view, restored when you come back
  listCache: {},        // { key, json, routes } the Climbs and Legacy lists last fetched, drawn at once on return
  listCounts: {},       // the Legacy and Drafts counts last seen
  lastRouteId: null,    // the climb last opened, marked in the list on return
  boardRouteId: null,   // the climb shown on the Climbs list's board (outlined in the list)
  lastCircuitId: null,  // likewise for the circuit last opened
  lastDraftId: null,    // and for the draft just saved
  climbSequence: null,  // { legacy, ids } of the problems last listed, for swiping between them
  logOpenDays: {},      // Logbook days opened or closed by hand: { 'YYYY-MM-DD': open }
  calendarMonth: null,  // 'YYYY-MM' the calendars last showed
};

const panel = document.getElementById('panel');
const sidePane = document.getElementById('side-pane');
const climberSelect = document.getElementById('climber-select');
const holdReadout = document.getElementById('hold-readout');
const boardEl = document.getElementById('board');
let board;
let current = null;
let currentView = null;
let renderToken = 0;

function readMe() {
  try {
    return Number(localStorage.getItem(ME_KEY)) || null;
  } catch {
    return null;
  }
}

function saveMe(id) {
  try {
    if (id) localStorage.setItem(ME_KEY, String(id));
    else localStorage.removeItem(ME_KEY);
  } catch {
    // Storage unavailable (private mode); the choice just won't persist.
  }
}

// Saved filters come from localStorage, so take only well-formed values.
function sanitizeFilters(saved) {
  const f = defaultFilters();
  if (!saved || typeof saved !== 'object') return f;
  if (typeof saved.q === 'string') f.q = saved.q;
  if (climbs.SCOPE_KEYS.includes(saved.scope)) f.scope = saved.scope;
  if (Array.isArray(saved.grades)) f.grades = saved.grades.filter((g) => GRADES.includes(g));
  f.hideSent = saved.hideSent === true;
  if (climbs.SORT_KEYS.includes(saved.sort)) f.sort = saved.sort;
  if (saved.dir === 'asc' || saved.dir === 'desc') f.dir = saved.dir;
  const hold = state.holdById.get(saved.holdId);
  if (hold && !hold.removed) f.holdId = hold.id;
  return f;
}

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null') || {};
    state.filters = sanitizeFilters(saved.filters);
    state.legacyFilters = sanitizeFilters(saved.legacyFilters);
    if (typeof saved.logShowRepeats === 'boolean') state.logShowRepeats = saved.logShowRepeats;
  } catch {
    // Unreadable or unavailable storage: start from the defaults.
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      filters: state.filters, legacyFilters: state.legacyFilters, logShowRepeats: state.logShowRepeats,
    }));
  } catch {
    // Storage unavailable (private mode); preferences just won't persist.
  }
}

function skeleton() {
  return h('div', { class: 'view-skeleton', 'aria-busy': 'true', 'aria-label': 'Loading' },
    h('div', { class: 'skeleton-line w40 tall' }), h('div', { class: 'skeleton-line w70' }),
    h('div', { class: 'skeleton-block' }), h('div', { class: 'skeleton-line w55' }), h('div', { class: 'skeleton-line w70' }));
}

function setHolds(holds) {
  state.holds = holds;
  state.holdById = new Map(holds.map((hold) => [hold.id, hold]));
}

async function refreshHolds() {
  setHolds(await api.holds(imagePpi(state.spec)));
  board.setHolds(state.holds);
}

async function refreshVolumes() {
  state.volumes = await api.volumes();
  board.setVolumes(state.volumes);
}

async function refreshColors() {
  state.colors = await api.colors();
}

async function refreshClimbers() {
  state.climbers = await api.climbers();
  if (!state.climbers.some((c) => c.id === state.me)) state.me = null;
  renderClimberSelect();
}

// Being the admin takes their password; anyone else is a choice away.
function canBe(id) {
  return state.climbers.some((c) => c.id === id) && (id !== state.adminId || state.admin);
}

function setSession(session) {
  state.admin = session.admin;
  state.adminId = session.admin_climber_id;
  document.body.classList.toggle('admin', state.admin);
  for (const tab of document.querySelectorAll('.tabs a[data-nav="outdoors"], .tabs a[data-nav="workout"]')) tab.hidden = !state.admin;
}

function renderClimberSelect() {
  climberSelect.replaceChildren(
    h('option', { value: '' }, state.me ? '— nobody —' : 'Choose climber…'),
    ...state.climbers.map((c) => h('option', { value: c.id }, c.id === state.adminId && !state.admin ? `${c.name} — log in…` : c.name)),
    h('option', { value: '__add' }, '+ Add climber…'),
    state.admin && h('option', { value: '__logout' }, `Log out ${state.climbers.find((c) => c.id === state.adminId)?.name || ''}`.trim()),
  );
  climberSelect.value = state.me ? String(state.me) : '';
  // The chip's avatar shows the climber's initial ("?" via CSS when nobody is chosen).
  const me = state.climbers.find((c) => c.id === state.me);
  document.getElementById('climber-avatar').textContent = me ? me.name.charAt(0).toUpperCase() : '';
}

function setMe(id) {
  state.me = id;
  saveMe(id);
  renderClimberSelect();
  render();
}

async function addClimber() {
  const name = await promptDialog('Add a climber', 'Name', 'e.g. Alex');
  if (!name) return null;
  try {
    const climber = await api.addClimber(name);
    await refreshClimbers();
    return climber;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

// Asks for the admin's password until it's right or cancelled; true once logged in.
async function logIn() {
  const name = state.climbers.find((c) => c.id === state.adminId)?.name || 'the admin';
  for (;;) {
    const password = await promptDialog(`Log in as ${name}`, 'Password', '', { type: 'password', confirmLabel: 'Log in' });
    if (password == null) return false;
    try {
      setSession(await api.login(password));
      return true;
    } catch (err) {
      toast(err.message, 'error');
    }
  }
}

async function logOut() {
  try {
    setSession(await api.logout());
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  // render() sends an admin page on to the Logbook.
  if (state.me === state.adminId) setMe(null);
  else {
    renderClimberSelect();
    render();
  }
}

climberSelect.addEventListener('change', async () => {
  if (climberSelect.value === '__add') {
    const climber = await addClimber();
    if (climber) setMe(climber.id);
    else renderClimberSelect();
    return;
  }
  if (climberSelect.value === '__logout') {
    await logOut();
    return;
  }
  const id = Number(climberSelect.value) || null;
  if (id && id === state.adminId && !state.admin && !(await logIn())) {
    renderClimberSelect();
    return;
  }
  setMe(id);
});

// A request turned away for want of the admin login: this device's login has
// lapsed (or a new password was set), so check the session and redraw.
window.addEventListener('homewall:unauthorized', async () => {
  const wasAdmin = state.admin;
  try {
    setSession(await api.session());
  } catch {
    return;
  }
  if (state.admin === wasAdmin) return;
  if (!canBe(state.me)) {
    state.me = null;
    saveMe(null);
  }
  renderClimberSelect();
  render();
});

// Shared context handed to every view.
const ctx = {
  state,
  api,
  toast,
  get board() {
    return board;
  },
  go(path) {
    if (location.hash === path) render();
    else location.hash = path;
  },
  climberName(id) {
    return state.climbers.find((c) => c.id === id)?.name || '';
  },
  addClimber,
  savePrefs,
  refreshClimbers,
  refreshHolds,
  refreshVolumes,
  refreshColors,
  boardEl,
  sidePane,
  // Views call this before acting on behalf of "me"; nudges the user to pick someone.
  requireMe() {
    if (state.me) return state.me;
    toast('Choose who you are in the top-right first', 'error');
    climberSelect.focus();
    return null;
  },
};

// The page the link is to (PAGES), and what it takes from the link.
function parseHash() {
  const [path, queryString] = location.hash.replace(/^#\/?/, '').split('?');
  const [first, raw] = path.split('/');
  const name = Object.prototype.hasOwnProperty.call(PAGES, first) ? first : 'climbs';
  const page = PAGES[name];
  return { view: name, page, params: page.params ? page.params(raw, new URLSearchParams(queryString || '')) : {} };
}

async function render() {
  const { view, page, params } = parseHash();
  if (page.computer && PHONE.matches) {
    location.replace('#/climbs');   // e.g. an old link to the Wall tab
    return;
  }
  if (page.admin && !state.admin) {
    location.replace('#/logbook');
    return;
  }
  current?.destroy?.();
  current = null;
  // From one climb to the next (or the same one, after logging a send), the
  // board keeps the old route until the new one is drawn over it; back on the
  // Climbs list, the climb just left stays on the board (climbs.js).
  board.reset({ keepRoute: currentView === 'route' && ['route', 'climbs', 'legacy'].includes(view) });
  currentView = view;
  const nav = typeof page.nav === 'function' ? page.nav(params) : page.nav;
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));

  panel.classList.toggle('panel-list', !!page.list);
  document.body.classList.toggle('list-mode', !!page.pinned);
  document.body.classList.toggle('calendar-mode', page.layout === 'calendar');
  document.body.classList.toggle('solo-mode', page.layout === 'solo');
  sidePane.hidden = page.layout !== 'calendar';
  sidePane.replaceChildren();
  // Start each page at the top, so on phones the board is in view.
  window.scrollTo(0, 0);

  const token = ++renderToken;
  const root = h('div', { class: 'view' });
  panel.replaceChildren(root);
  // Views draw with replaceChildren, so this placeholder vanishes once they do.
  const placeholder = setTimeout(() => {
    if (token === renderToken && !root.childElementCount) root.append(skeleton());
  }, 150);
  // A view whose data arrives after the user has navigated away must not touch the board.
  const viewCtx = Object.assign(Object.create(ctx), { stale: () => token !== renderToken });
  try {
    const handle = await page.render(root, viewCtx, params);
    if (token === renderToken) current = handle || {};
    else handle?.destroy?.();
  } catch (err) {
    if (token === renderToken) {
      board.reset();   // not the route that was showing before
      root.replaceChildren(h('div', { class: 'empty' }, err.message));
    }
  } finally {
    clearTimeout(placeholder);
    // A swipe whose next page didn't take it over must not leave the wall offset.
    if (token === renderToken) settleSwipe(board.swipeLayer);
  }
}

// A copy that isn't the live app (the test app, deploy/mac/test-app.sh) says
// so on every page, so nothing is logged there by mistake.
function markCopy({ label }) {
  if (!label) return;
  document.title = `${label} · ${document.title}`;
  document.body.classList.add('labeled-copy');
  document.body.append(h('div', { class: 'copy-label', role: 'note' }, `${label} · not the live logbook`));
}

async function init() {
  api.health().then(markCopy, () => {});
  // The hold images are sized for this screen and the board, so the holds wait for the board.
  const loadSpec = api.board();
  const [spec, holds, climbers, volumes, colors, session] = await Promise.all([
    loadSpec, loadSpec.then((s) => api.holds(imagePpi(s))), api.climbers(), api.volumes(), api.colors(), api.session()]);
  state.spec = spec;
  setHolds(holds);
  state.climbers = climbers;
  state.volumes = volumes;
  state.colors = colors;
  setSession(session);
  state.me = readMe();
  if (!canBe(state.me)) state.me = null;
  loadPrefs();   // after the holds, so a saved hold filter can be checked
  renderClimberSelect();

  board = createBoard(boardEl, spec, holds, {
    onHoldClick: (hold) => current?.onHoldClick?.(hold),
    onHoldHover: (hold) => {
      holdReadout.textContent = hold ? holdTitle(hold) : '';
      current?.onHoldHover?.(hold);
    },
    onWallPointer: (type, point) => current?.onWallPointer?.(type, point),
    zoomHost: document.getElementById('zoom-slot'),   // under the board, below the key
  });
  board.setVolumes(volumes);

  window.addEventListener('hashchange', render);
  render();
}

init().catch((err) => {
  panel.replaceChildren(h('div', { class: 'empty' }, `Could not load the app: ${err.message}`));
});
