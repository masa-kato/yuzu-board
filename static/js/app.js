import { api } from './api.js';
import { createBoard, holdTitle, imagePpi } from './board.js';
import { settleSwipe } from './swipe.js';
import { GRADES, h, promptDialog, toast } from './ui.js';
import * as climbs from './views/climbs.js';
import * as routeDetail from './views/routeDetail.js';
import * as editor from './views/editor.js';
import * as logbook from './views/logbook.js';
import * as holdsView from './views/holds.js';
import * as circuits from './views/circuits.js';
import * as stats from './views/stats.js';
import * as drafts from './views/drafts.js';

const ME_KEY = 'homewall.me';
const PREFS_KEY = 'homewall.filters.v1';
const VIEWS = {
  climbs, legacy: climbs, route: routeDetail, editor, logbook, holds: holdsView,
  circuits, circuit: { render: circuits.renderDetail }, stats, drafts,
};
const NAV_FOR_VIEW = {
  climbs: 'climbs', legacy: 'climbs', route: 'climbs', editor: 'editor', logbook: 'logbook', holds: 'holds',
  circuits: 'circuits', circuit: 'circuits', stats: 'stats', drafts: 'climbs',
};
// Views whose controls stay put while only their list scrolls; on phones the
// climb lists also pin the board above them.
const LIST_VIEWS = new Set(['climbs', 'legacy', 'drafts', 'logbook', 'circuits', 'circuit', 'stats']);
const PINNED_BOARD_VIEWS = new Set(['climbs', 'legacy', 'drafts']);
// Phones have no Wall tab (app.css): holds are added and removed on a computer.
const PHONE = window.matchMedia('(max-width: 900px)');

const defaultFilters = () => ({ q: '', scope: 'all', grades: [], hideSent: false, holdId: null, sort: 'set_date', dir: 'desc' });

const state = {
  spec: null,
  climbers: [],
  me: null,
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
};

const panel = document.getElementById('panel');
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

function renderClimberSelect() {
  climberSelect.replaceChildren(
    h('option', { value: '' }, state.me ? '— nobody —' : 'Choose climber…'),
    ...state.climbers.map((c) => h('option', { value: c.id }, c.name)),
    h('option', { value: '__add' }, '+ Add climber…'),
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

climberSelect.addEventListener('change', async () => {
  if (climberSelect.value === '__add') {
    const climber = await addClimber();
    if (climber) setMe(climber.id);
    else renderClimberSelect();
    return;
  }
  setMe(Number(climberSelect.value) || null);
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
  // Views call this before acting on behalf of "me"; nudges the user to pick someone.
  requireMe() {
    if (state.me) return state.me;
    toast('Choose who you are in the top-right first', 'error');
    climberSelect.focus();
    return null;
  },
};

function parseHash() {
  const [path, queryString] = location.hash.replace(/^#\/?/, '').split('?');
  const [name, id] = path.split('/');
  const params = new URLSearchParams(queryString || '');
  switch (name) {
    case 'route':
      // ?circuit= opens the climb as a step of that circuit.
      return { view: 'route', params: { routeId: Number(id), circuitId: Number(params.get('circuit')) || null } };
    case 'circuits':
      return { view: 'circuits', params: {} };
    case 'circuit':
      return { view: 'circuit', params: { circuitId: Number(id), adding: params.get('add') === '1' } };
    case 'edit':
      return { view: 'editor', params: { routeId: Number(id) } };
    case 'new':
      // ?draft= picks up a saved draft.
      return { view: 'editor', params: { parentId: Number(params.get('parent')) || null, draftId: Number(params.get('draft')) || null } };
    case 'logbook':
      return { view: 'logbook', params: {} };
    case 'legacy':
      return { view: 'legacy', params: { legacy: true } };
    case 'drafts':
      return { view: 'drafts', params: {} };
    case 'holds':
      return { view: 'holds', params: {} };
    case 'stats':
      return { view: 'stats', params: {} };
    default:
      return { view: 'climbs', params: {} };
  }
}

async function render() {
  const { view, params } = parseHash();
  if (view === 'holds' && PHONE.matches) {
    location.replace('#/climbs');   // an old link to the Wall tab
    return;
  }
  current?.destroy?.();
  current = null;
  // From one climb to the next (or the same one, after logging a send), the
  // board keeps the old route until the new one is drawn over it; back on the
  // Climbs list, the climb just left stays on the board (climbs.js).
  board.reset({ keepRoute: currentView === 'route' && ['route', 'climbs', 'legacy'].includes(view) });
  currentView = view;
  const nav = view === 'route' && params.circuitId ? 'circuits' : NAV_FOR_VIEW[view];
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));

  panel.classList.toggle('panel-list', LIST_VIEWS.has(view));
  document.body.classList.toggle('list-mode', PINNED_BOARD_VIEWS.has(view));
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
    const handle = await VIEWS[view].render(root, viewCtx, params);
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

async function init() {
  // The hold images are sized for this screen and the board, so the holds wait for the board.
  const loadSpec = api.board();
  const [spec, holds, climbers, volumes, colors] = await Promise.all([
    loadSpec, loadSpec.then((s) => api.holds(imagePpi(s))), api.climbers(), api.volumes(), api.colors()]);
  state.spec = spec;
  setHolds(holds);
  state.climbers = climbers;
  state.volumes = volumes;
  state.colors = colors;
  state.me = readMe();
  if (!climbers.some((c) => c.id === state.me)) state.me = null;
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
