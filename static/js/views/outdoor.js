// The admin's outdoor climbing (outdoor.py), the Outdoors tab: the climbs in
// progress or sent (#/outdoors, #/outdoors/sent), a session's form
// (#/outdoor/new, #/outdoor/<id>) and a climb's page with every session on it
// (#/outdoor-climb/<id>). No calendar here; the Logbook's shows the days out.

import { confirmDialog, dialog, field, fmtDate, h, icon, sentMark, shortDate, today, trackListScroll } from '../ui.js';

const NAME_MAX = 120;

function backLink(ctx, label, hash) {
  return h('button', { type: 'button', class: 'back-link', onClick: () => ctx.go(hash) }, icon('arrow-left', { size: 15 }), label);
}

const sentBadge = (sent) => h('span', { class: `badge ${sent ? 'sent-tag' : 'tried-tag'}` }, sent ? 'Sent' : 'Tried');

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// A climb's earlier sessions, newest first, leaving out `skipSession`.
function historyList(history, skipSession = null) {
  const rows = history.filter((x) => x.session_id !== skipSession);
  if (!rows.length) return h('p', { class: 'muted small' }, 'No other sessions on it yet.');
  return h('ol', { class: 'climb-history' }, rows.map((x) => h('li', {},
    h('div', { class: 'my-history-head' }, sentBadge(x.sent), h('span', { class: 'muted' }, fmtDate(x.session_date)),
      h('span', { class: 'muted' }, `· Session ${x.session_number}`),
      x.area && h('span', { class: 'muted' }, `· ${x.area}`)),
    x.note ? h('p', { class: 'my-history-note' }, x.note) : h('p', { class: 'muted small' }, 'No note.'))));
}

// ---- a field's dropdown ----------------------------------------------------------

const COARSE = window.matchMedia('(pointer: coarse)');
let comboSeq = 0;

// A text field with a dropdown of suggestions: `suggest(text)` gives its rows,
// each { label, note, mark, icon, kind } to pick, or { head } / { info } to
// read, and `pick(row)` takes one (`keepOpen` shows the list again after, for
// picking several). It opens when the field is focused and follows what's
// typed (anything can still be typed); arrows, Enter and Esc work it. It sits
// under the field (above, when there's more room there) in the top layer, so
// the scrolling panel can't clip it. Returns { close }.
function combo(input, { suggest, pick, keepOpen = false, label }) {
  const menu = h('div', {
    class: 'combo-menu', id: `combo-${++comboSeq}`, popover: 'manual', role: 'listbox', 'aria-label': label,
    // Pressing a row keeps the field's focus, and a phone its keyboard. (Not
    // on pointerdown: Safari then drops a tap's click.)
    onMousedown: (e) => e.preventDefault(),
  });
  input.classList.add('combo-input');
  for (const [k, v] of Object.entries({ role: 'combobox', autocomplete: 'off', 'aria-autocomplete': 'list', 'aria-controls': menu.id, 'aria-expanded': 'false' })) {
    input.setAttribute(k, v);
  }
  let rows = [];
  let active = -1;
  const isOpen = () => menu.matches(':popover-open');

  function fill() {
    const text = input.value.trim().replace(/\s+/g, ' ');
    const items = suggest(text);
    rows = items.filter((r) => r.label != null);
    // Enter takes the first row once something's typed.
    active = text && rows.length ? 0 : -1;
    let n = 0;
    menu.replaceChildren(...items.map((r) => {
      if (r.head) return h('div', { class: 'combo-head', role: 'presentation' }, r.head);
      if (r.info) return h('div', { class: 'combo-info', role: 'presentation' }, r.info);
      const i = n++;
      return h('div', {
        role: 'option', id: `${menu.id}-${i}`, class: `combo-option${r.kind ? ` ${r.kind}` : ''}`, 'aria-selected': String(i === active),
        onClick: () => choose(rows[i]),
      }, r.icon && icon(r.icon, { size: 15 }), h('span', { class: 'combo-name' }, r.label), r.mark, r.note && h('span', { class: 'combo-note' }, r.note));
    }));
    highlight(active);
    return items.length > 0;
  }

  function highlight(i) {
    active = i;
    const options = menu.querySelectorAll('[role="option"]');
    options.forEach((o, j) => o.setAttribute('aria-selected', String(j === i)));
    if (i >= 0) {
      input.setAttribute('aria-activedescendant', options[i].id);
      options[i].scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  // Under the field, or above it when there's more room there, within what a
  // phone's keyboard leaves showing.
  function place() {
    if (!input.isConnected) return close();
    const r = input.getBoundingClientRect();
    const vv = window.visualViewport;
    const top = vv ? vv.offsetTop : 0;
    const bottom = vv ? vv.offsetTop + vv.height : innerHeight;
    const width = Math.min(Math.max(r.width, 260), innerWidth - 16);
    const below = bottom - r.bottom - 10;
    const above = r.top - top - 10;
    const down = below >= Math.min(menu.scrollHeight, 240) || below >= above;
    Object.assign(menu.style, {
      width: `${width}px`,
      left: `${Math.max(8, Math.min(r.left, innerWidth - width - 8))}px`,
      top: down ? `${r.bottom + 4}px` : 'auto',
      bottom: down ? 'auto' : `${innerHeight - r.top + 4}px`,
      maxHeight: `${Math.max(140, Math.min(down ? below : above, 360))}px`,
    });
  }

  // A press anywhere else closes it (a tap on plain text keeps a phone's focus).
  const onPress = (e) => {
    if (e.target !== input && !menu.contains(e.target)) close();
  };

  function open() {
    if (!fill()) return close();
    if (!isOpen()) {
      menu.showPopover();
      input.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', onPress, true);
      document.addEventListener('scroll', place, true);
      window.addEventListener('resize', place);
      window.visualViewport?.addEventListener('resize', place);
      window.visualViewport?.addEventListener('scroll', place);
    }
    place();
  }

  function close() {
    if (isOpen()) menu.hidePopover();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    document.removeEventListener('pointerdown', onPress, true);
    document.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', place);
    window.visualViewport?.removeEventListener('resize', place);
    window.visualViewport?.removeEventListener('scroll', place);
  }

  function choose(row) {
    pick(row);
    if (keepOpen) open();
    else close();
  }

  input.addEventListener('focus', () => {
    open();
    // On a phone, bring the field up under the header so the list has room
    // above the keyboard.
    if (!COARSE.matches) return;
    setTimeout(() => {
      if (document.activeElement !== input) return;
      const header = document.querySelector('.topbar').getBoundingClientRect().bottom;
      const field = input.closest('.field') || input;
      window.scrollTo({ top: scrollY + field.getBoundingClientRect().top - header - 12, behavior: 'smooth' });
    }, 250);
  });
  input.addEventListener('input', open);
  // Tapping the field again (focus already there) brings the list back.
  input.addEventListener('click', () => isOpen() || open());
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen()) return open();
      if (!rows.length) return;
      const down = e.key === 'ArrowDown';
      highlight(active < 0 ? (down ? 0 : rows.length - 1) : (active + (down ? 1 : rows.length - 1)) % rows.length);
    } else if (e.key === 'Enter' && isOpen() && active >= 0) {
      e.preventDefault();
      choose(rows[active]);
    } else if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      close();
    }
  });
  return { menu, close };
}

// ---- a session ----------------------------------------------------------------

export async function renderSession(root, ctx, { sessionId = null, date = null }) {
  const [session, climbs] = await Promise.all([
    sessionId ? ctx.api.outdoorSession(sessionId) : null,
    ctx.api.outdoorClimbs(),
  ]);
  if (ctx.stale()) return;
  const byId = new Map(climbs.map((c) => [c.id, c]));

  const dateInput = h('input', { type: 'date', class: 'input', required: true, max: today(), value: session?.session_date || date || today() });
  const areaInput = h('input', { type: 'text', class: 'input', maxlength: NAME_MAX, placeholder: 'e.g. Buttermilks', value: session?.area || '' });
  const sameArea = (c) => c.area.toLowerCase() === areaInput.value.trim().toLowerCase();

  // Areas you've been, the latest first, with how many climbs you've logged in each.
  const areas = new Map();
  for (const c of climbs) {
    if (!c.area) continue;
    const a = areas.get(c.area) || { climbs: 0, last: '' };
    a.climbs++;
    if ((c.last_date || '') > a.last) a.last = c.last_date;
    areas.set(c.area, a);
  }
  const areaOrder = [...areas].sort(([x, a], [y, b]) => b.last.localeCompare(a.last) || x.localeCompare(y));
  const areaCombo = combo(areaInput, {
    label: 'Areas',
    suggest: (text) => {
      const q = text.toLowerCase();
      const found = areaOrder.filter(([name]) => name.toLowerCase().includes(q));
      return found.length ? [{ head: q ? 'Areas' : 'Areas you’ve been' },
        ...found.map(([name, a]) => ({ label: name, value: name, note: plural(a.climbs, 'climb'), mark: name.toLowerCase() === q && icon('check', { size: 15 }) }))] : [];
    },
    pick: (row) => (areaInput.value = row.value),
  });
  const notesInput = h('textarea', { class: 'input', rows: 2, placeholder: 'How was the day? Conditions, skin, …', value: session?.notes || '' });

  // The climbs of the session: a known climb (climb_id) or a new one, to be
  // added in the session's area when it's saved.
  const entries = (session?.entries || []).map((e) => ({ ...e }));
  const entryList = h('div', { class: 'outdoor-entry-list' });

  function entryCard(entry, i) {
    const known = entry.climb_id != null ? byId.get(entry.climb_id) : null;
    const note = h('textarea', {
      class: 'input', rows: 2, placeholder: 'What did you learn on it?', value: entry.note || '',
      onInput: () => (entry.note = note.value),
    });
    const choice = (sent, label) => h('button', {
      type: 'button', class: `chip${entry.sent === sent ? ' on' : ''}`, 'aria-pressed': String(entry.sent === sent),
      onClick: () => {
        entry.sent = sent;
        renderEntries();
      },
    }, label);
    // Its notes from other sessions, fetched when opened.
    const others = known ? known.session_count - (session?.entries.some((e) => e.climb_id === known.id) ? 1 : 0) : 0;
    let earlier = null;
    if (others > 0) {
      const body = h('div', { class: 'earlier-body' }, h('p', { class: 'muted small' }, 'Loading…'));
      earlier = h('details', {
        class: 'earlier-notes',
        onToggle: async () => {
          if (!earlier.open || earlier.dataset.loaded) return;
          earlier.dataset.loaded = '1';
          try {
            const climb = await ctx.api.outdoorClimb(known.id);
            body.replaceChildren(historyList(climb.history, session?.id));
          } catch (err) {
            body.replaceChildren(h('p', { class: 'muted small' }, err.message));
          }
        },
      }, h('summary', {}, `Earlier notes (${others})`), body);
    }
    const grade = !known && h('input', {
      type: 'text', class: 'input grade-input', maxlength: 20, placeholder: 'Grade', value: entry.grade || '', 'aria-label': `Grade of ${entry.name}`,
      onInput: (e) => (entry.grade = e.target.value),
    });
    return h('div', { class: 'card outdoor-entry' },
      h('div', { class: 'outdoor-entry-head' },
        h('div', { class: 'outdoor-entry-name' },
          h('strong', {}, entry.name),
          known ? [known.grade && h('span', { class: 'outdoor-grade' }, known.grade), known.area && h('span', { class: 'muted small' }, known.area)]
            : h('span', { class: 'badge' }, 'New')),
        h('button', {
          type: 'button', class: 'icon-btn danger', title: 'Take it out of this session', 'aria-label': `Remove ${entry.name}`,
          onClick: () => {
            entries.splice(i, 1);
            renderEntries();
          },
        }, icon('x', { size: 16 }))),
      h('div', { class: 'outdoor-entry-row' }, h('div', { class: 'chip-row wrap' }, choice(false, 'Tried'), choice(true, 'Sent')), grade),
      note,
      earlier);
  }

  function renderEntries() {
    entryList.replaceChildren(...(entries.length
      ? entries.map(entryCard)
      : [h('p', { class: 'muted small' }, 'No climbs yet. Add the ones you tried below.')]));
  }

  // Adding a climb: the area's climbs drop down as soon as the field is
  // tapped (the ones not sent yet first, the latest tried first); typing
  // narrows them, finds the name in other areas too, and offers a new climb.
  const search = h('input', {
    type: 'text', class: 'input', placeholder: 'Climb name', maxlength: NAME_MAX, enterkeyhint: 'enter', 'aria-label': 'Add a climb',
    // Enter adds a climb, never sends the form.
    onKeydown: (e) => e.key === 'Enter' && e.preventDefault(),
  });
  const climbOrder = (a, b) => a.sent - b.sent || (b.last_date || '').localeCompare(a.last_date || '')
    || a.name.localeCompare(b.name, undefined, { numeric: true });
  function climbRows(text) {
    const q = text.toLowerCase();
    const area = areaInput.value.trim();
    const taken = new Set(entries.map((e) => e.climb_id).filter((id) => id != null));
    const matching = climbs.filter((c) => !taken.has(c.id) && c.name.toLowerCase().includes(q));
    const row = (c, where) => ({
      label: c.name, climb: c, mark: c.sent && sentMark(14), note: [c.grade, where && c.area].filter(Boolean).join(' · '),
    });
    const here = matching.filter((c) => !area || sameArea(c)).sort(climbOrder);
    // Other areas' climbs only once a name is typed: a boulder in two places is two climbs.
    const elsewhere = area && q ? matching.filter((c) => !sameArea(c)).sort(climbOrder) : [];
    const exact = here.some((c) => c.name.toLowerCase() === q) || entries.some((e) => e.climb_id == null && e.name.toLowerCase() === q);
    return [
      area && { head: area },
      ...here.map((c) => row(c, !area)),
      area && !here.length && { info: q ? `No climb like that in ${area} yet.` : `No climbs logged in ${area} yet. Type a name to add one.` },
      !area && !here.length && !q && { info: 'Type a climb’s name to add it.' },
      q && !exact && { label: `New climb “${text}”`, note: area && `in ${area}`, icon: 'plus', kind: 'new', name: text },
      elsewhere.length > 0 && { head: 'Other areas' },
      ...elsewhere.map((c) => row(c, true)),
    ].filter(Boolean);
  }
  const climbCombo = combo(search, {
    label: 'Climbs',
    keepOpen: true,
    suggest: climbRows,
    pick: (row) => {
      entries.push(row.climb ? { climb_id: row.climb.id, name: row.climb.name, sent: false, note: '' } : { climb_id: null, name: row.name, grade: '', sent: false, note: '' });
      search.value = '';
      renderEntries();
    },
  });

  async function save(e) {
    e.preventDefault();
    const area = areaInput.value.trim();
    const data = {
      session_date: dateInput.value, area, notes: notesInput.value,
      entries: entries.map((x) => (x.climb_id != null
        ? { climb_id: x.climb_id, sent: x.sent, note: x.note }
        : { climb: { name: x.name, area, grade: x.grade || '' }, sent: x.sent, note: x.note })),
    };
    try {
      if (session) await ctx.api.updateOutdoorSession(session.id, data);
      else await ctx.api.createOutdoorSession(data);
      ctx.toast(session ? 'Session updated.' : 'Session logged.', 'success');
      ctx.go('#/outdoors');
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  async function remove() {
    const ok = await confirmDialog('Delete this session?', `${session.area || 'Outdoor session'} on ${fmtDate(session.session_date)}. The climbs stay in your list.`);
    if (!ok) return;
    try {
      await ctx.api.deleteOutdoorSession(session.id);
      ctx.toast('Session deleted.');
      ctx.go('#/outdoors');
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  renderEntries();
  root.replaceChildren(
    backLink(ctx, 'Outdoors', '#/outdoors'),
    h('h1', {}, session ? 'Edit outdoor session' : 'Outdoor session'),
    h('form', { class: 'editor', onSubmit: save },
      h('div', { class: 'grid-2' }, field('Date', dateInput), field('Area', areaInput)),
      field('Notes on the day (optional)', notesInput),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Climbs'), entryList),
      field('Add a climb', search),
      h('div', { class: 'actions' },
        h('button', { type: 'submit', class: 'btn btn-primary' }, session ? 'Save session' : 'Log session'),
        h('button', { type: 'button', class: 'btn', onClick: () => ctx.go('#/outdoors') }, 'Cancel'),
        session && h('button', { type: 'button', class: 'btn btn-ghost-danger', onClick: remove }, 'Delete')),
      // The dropdowns, outside the fields' labels.
      areaCombo.menu, climbCombo.menu));

  return {
    destroy() {
      areaCombo.close();
      climbCombo.close();
    },
  };
}

// ---- the Outdoors tab ----------------------------------------------------------

// In progress | Sent, with how many of each.
function listSwitch(tab, counts) {
  const link = (key, label, hash) => h('a', { href: hash, 'aria-current': key === tab ? 'page' : null },
    label, h('span', { class: 'segment-count' }, counts[key] || ''));
  return h('nav', { class: 'segmented-nav', 'aria-label': 'Which climbs' },
    link('progress', 'In progress', '#/outdoors'), link('sent', 'Sent', '#/outdoors/sent'));
}

// The climbs not sent yet, the latest tried first, or the sent ones, the
// latest send first; a climb opens its page.
export async function renderOutdoors(root, ctx, { tab }) {
  const climbs = await ctx.api.outdoorClimbs();
  if (ctx.stale()) return;
  const latest = (key) => (a, b) => (b[key] || '').localeCompare(a[key] || '') || a.name.localeCompare(b.name, undefined, { numeric: true });
  const lists = {
    progress: climbs.filter((c) => !c.sent).sort(latest('last_date')),
    sent: climbs.filter((c) => c.sent).sort(latest('first_sent')),
  };
  const sent = tab === 'sent';
  const list = h('div', { class: 'outdoor-climbs' });
  const scroller = h('div', { class: 'list-scroll' }, list);
  const scrolling = trackListScroll(root, scroller, ctx.state.listScroll, `outdoors-${tab}`, { page: true });
  const search = h('input', { type: 'search', class: 'input', placeholder: 'Search climbs or areas', autocomplete: 'off', onInput: () => draw() });

  function row(c) {
    const meta = sent
      ? `Sent ${shortDate(c.first_sent)} · took ${plural(c.sent_session, 'session')}`
      : [plural(c.total_sessions, 'session'), c.last_date && `last ${shortDate(c.last_date)}`].filter(Boolean).join(' · ');
    return h('button', { type: 'button', class: 'outdoor-row', onClick: () => ctx.go(`#/outdoor-climb/${c.id}`) },
      h('span', { class: 'outdoor-row-text' },
        h('span', { class: 'outdoor-row-title' },
          h('span', { class: 'lookup-name' }, c.name), sent && sentMark(16),
          h('span', { class: 'outdoor-grade' }, [c.grade, c.area].filter(Boolean).join(' · '))),
        h('span', { class: 'muted small' }, meta)),
      icon('chevron-right', { size: 16 }));
  }

  function draw() {
    const q = search.value.trim().toLowerCase();
    const shown = lists[tab].filter((c) => !q || c.name.toLowerCase().includes(q) || c.area.toLowerCase().includes(q));
    if (!shown.length) {
      list.replaceChildren(h('div', { class: 'empty' }, q ? 'No climbs match.'
        : sent ? 'No outdoor sends yet.' : 'Nothing in progress. Log a session to start one.'));
      return;
    }
    list.replaceChildren(...shown.map(row));
  }

  draw();
  root.replaceChildren(
    h('div', { class: 'list-controls' },
      h('div', { class: 'panel-head' }, h('h1', {}, 'Outdoors'),
        h('button', { type: 'button', class: 'btn btn-small', onClick: () => ctx.go(`#/outdoor/new?date=${today()}`) }, icon('plus', { size: 14 }), 'Session')),
      listSwitch(tab, { progress: lists.progress.length, sent: lists.sent.length }),
      search),
    scroller);
  root.classList.add('view-list');
  scrolling.restore();

  return {
    destroy() {
      scrolling.stop();
    },
  };
}

// ---- a climb --------------------------------------------------------------------

export async function renderClimb(root, ctx, { climbId }) {
  const climb = await ctx.api.outdoorClimb(climbId);
  if (ctx.stale()) return;
  const list = climb.sent ? '#/outdoors/sent' : '#/outdoors';

  async function edit() {
    const name = h('input', { type: 'text', class: 'input', required: true, maxlength: NAME_MAX, value: climb.name });
    const area = h('input', { type: 'text', class: 'input', maxlength: NAME_MAX, value: climb.area });
    const grade = h('input', { type: 'text', class: 'input', maxlength: 20, value: climb.grade, placeholder: 'e.g. V5' });
    const notes = h('textarea', { class: 'input', rows: 3, value: climb.notes, placeholder: 'Beta, the approach, where it is, …' });
    const prior = h('input', { type: 'number', class: 'input', min: 0, max: 999, step: 1, inputmode: 'numeric', value: climb.prior_sessions });
    const result = await dialog({
      title: `Edit ${climb.name}`,
      body: h('div', {}, field('Name', name), h('div', { class: 'grid-2' }, field('Area', area), field('Grade', grade)),
        field('Sessions before logging here', prior, 'The logged ones count on from these: with 4, the first logged is its 5th.'),
        field('Notes', notes)),
      actions: [{ value: 'cancel', label: 'Cancel' }, { value: 'ok', label: 'Save', class: 'btn-primary' }],
    });
    if (result !== 'ok') return;
    try {
      await ctx.api.updateOutdoorClimb(climb.id, {
        name: name.value, area: area.value, grade: grade.value, notes: notes.value, prior_sessions: prior.value,
      });
      ctx.toast('Climb updated.', 'success');
      ctx.go(`#/outdoor-climb/${climb.id}`);
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  async function remove() {
    const ok = await confirmDialog(`Delete ${climb.name}?`,
      climb.session_count ? `It comes out of the ${plural(climb.session_count, 'session')} it's in, with its notes there.` : 'It’s in no sessions.');
    if (!ok) return;
    try {
      await ctx.api.deleteOutdoorClimb(climb.id);
      ctx.toast('Climb deleted.');
      ctx.go(list);
    } catch (err) {
      ctx.toast(err.message, 'error');
    }
  }

  root.replaceChildren(
    backLink(ctx, 'Outdoors', list),
    h('div', { class: 'route-kicker' }, climb.area || 'Outdoor climb'),
    h('h1', { class: 'route-heading' }, climb.name, climb.grade && h('span', { class: 'outdoor-grade heading-grade' }, climb.grade)),
    h('dl', { class: 'meta' },
      h('dt', {}, 'Sessions'), h('dd', {}, climb.total_sessions || 'None yet',
        climb.prior_sessions > 0 && h('span', { class: 'muted' }, ` (${climb.prior_sessions} before logging here)`)),
      h('dt', {}, 'Sent'), h('dd', {}, climb.first_sent
        ? [fmtDate(climb.first_sent), h('span', { class: 'muted' }, ` (session ${climb.sent_session})`)]
        : h('span', { class: 'muted' }, 'Not yet'))),
    climb.notes && h('p', { class: 'notes' }, climb.notes),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn', onClick: edit }, 'Edit'),
      h('button', { type: 'button', class: 'btn btn-ghost-danger', onClick: remove }, 'Delete')),
    h('section', { class: 'my-history' },
      h('h2', {}, 'Notes by session'),
      climb.history.length
        ? h('ol', {}, climb.history.map((x) => h('li', {},
          h('div', { class: 'my-history-head' }, sentBadge(x.sent),
            h('button', { type: 'button', class: 'link muted', title: 'Open the session', onClick: () => ctx.go(`#/outdoor/${x.session_id}`) }, fmtDate(x.session_date)),
            h('span', { class: 'muted' }, `· Session ${x.session_number}`),
            x.area && h('span', { class: 'muted' }, `· ${x.area}`)),
          x.note && h('p', { class: 'my-history-note' }, x.note),
          x.session_notes && h('p', { class: 'my-history-day' }, h('strong', {}, 'On the day: '), x.session_notes))))
        : h('p', { class: 'muted' }, 'Not in any session yet.')));
}
