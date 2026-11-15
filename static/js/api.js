async function request(method, url, body) {
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method,
    headers: body && !isForm ? { 'Content-Type': 'application/json' } : {},
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function query(params) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '' && !(Array.isArray(value) && !value.length)) qs.set(key, value);
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export const api = {
  board: () => request('GET', '/api/board'),

  // `ppi` sizes the board images for this screen (board.js imagePpi).
  holds: (ppi) => request('GET', `/api/holds${query({ ppi })}`),
  holdNames: () => request('GET', '/api/hold-names'),
  // Every hold on the wall in one picture, as touch screens draw them (board.js LIGHT).
  holdsPicture: (params) => request('GET', `/api/holds/picture${query(params)}`),
  createHold: (form) => request('POST', '/api/holds', form),
  updateHold: (id, form) => request('PUT', `/api/holds/${id}`, form),
  holdImpact: (id) => request('GET', `/api/holds/${id}/impact`),
  removeHold: (id) => request('DELETE', `/api/holds/${id}`),
  restoreHold: (id) => request('POST', `/api/holds/${id}/restore`),
  deleteHoldPermanently: (id) => request('DELETE', `/api/holds/${id}/permanent`),
  // `color` is '#rrggbb', or null for the holds' original colors.
  recolorHolds: (holdIds, color) => request('PUT', '/api/holds/color', { hold_ids: holdIds, color }),

  // The shared color list. Changing a color's hex recolors the holds in it.
  colors: () => request('GET', '/api/colors'),
  createColor: (data) => request('POST', '/api/colors', data),
  updateColor: (id, data) => request('PUT', `/api/colors/${id}`, data),
  deleteColor: (id) => request('DELETE', `/api/colors/${id}`),

  volumes: () => request('GET', '/api/volumes'),
  createVolume: (data) => request('POST', '/api/volumes', data),
  updateVolume: (id, data) => request('PUT', `/api/volumes/${id}`, data),
  deleteVolume: (id) => request('DELETE', `/api/volumes/${id}`),

  climbers: () => request('GET', '/api/climbers'),
  addClimber: (name) => request('POST', '/api/climbers', { name }),
  logbook: (climberId) => request('GET', `/api/climbers/${climberId}/sends`),

  routes: (params = {}) => request('GET', `/api/routes${query(params)}`),
  route: (id, me) => request('GET', `/api/routes/${id}${query({ me })}`),
  createRoute: (data) => request('POST', '/api/routes', data),
  updateRoute: (id, data) => request('PUT', `/api/routes/${id}`, data),
  deleteRoute: (id) => request('DELETE', `/api/routes/${id}`),
  // A climb nobody has sent goes back to Drafts; returns the draft.
  routeToDraft: (id, savedBy) => request('POST', `/api/routes/${id}/draft`, { saved_by: savedBy }),

  // Climbs not published yet, shared by everyone. createRoute with `draft_id` publishes one.
  drafts: () => request('GET', '/api/drafts'),
  draft: (id) => request('GET', `/api/drafts/${id}`),
  createDraft: (data) => request('POST', '/api/drafts', data),
  updateDraft: (id, data) => request('PUT', `/api/drafts/${id}`, data),
  deleteDraft: (id) => request('DELETE', `/api/drafts/${id}`),

  // Circuit calls return the whole circuit, with "sent by me" filled in for `me`.
  circuits: (me) => request('GET', `/api/circuits${query({ me })}`),
  circuit: (id, me) => request('GET', `/api/circuits/${id}${query({ me })}`),
  createCircuit: (data, me) => request('POST', `/api/circuits${query({ me })}`, data),
  updateCircuit: (id, data, me) => request('PUT', `/api/circuits/${id}${query({ me })}`, data),
  addToCircuit: (id, routeId, me) => request('POST', `/api/circuits/${id}/routes${query({ me })}`, { route_id: routeId }),
  removeFromCircuit: (id, routeId, me) => request('DELETE', `/api/circuits/${id}/routes/${routeId}${query({ me })}`),
  deleteCircuit: (id) => request('DELETE', `/api/circuits/${id}`),

  logSend: (data) => request('POST', '/api/sends', data),
  updateSend: (id, data) => request('PUT', `/api/sends/${id}`, data),
  deleteSend: (id) => request('DELETE', `/api/sends/${id}`),
};
