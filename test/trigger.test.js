'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

const { KEYS, fixtures } = h;
const { IDS } = fixtures;
let api;
before(async () => {
  api = await h.startMockApi();
});
after(() => api.close());
beforeEach(() => api.reset());

const poll = (params, staticData, opts = {}) => h.poll({ location: { __rl: true, mode: 'list', value: '' }, ...params }, { baseUrl: api.baseUrl, staticData, ...opts });
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function addFeedback(id, locationId = IDS.MITTE) {
  api.state.feedback.push({ id, location_id: locationId, request_id: null, rating: 2, text: 'Too loud.', contact: { name: 'Ida Klein' }, status: 'new', created_at: nowIso() });
}

function addRequest(id, status) {
  api.state.requests.push({ id, location_id: IDS.NORD, channel: 'email', source: 'api', status, contact: { name: 'Ida Klein', email: 'ida@example.org', phone: null }, rating: 5, created_at: nowIso(), sent_at: nowIso(), clicked_at: nowIso(), rated_at: nowIso() });
}

test('trigger description: the five events of the instant trigger, polling, no inputs', () => {
  const d = new h.CitypickedTrigger().description;
  assert.equal(d.polling, true);
  assert.deepEqual(d.inputs, []);
  const values = d.properties.find((p) => p.name === 'event').options.map((o) => o.value);
  assert.deepEqual(values, ['newFiveStarClick', 'newGoogleReview', 'newFeedback', 'profileCheckPointOpen', 'requestRated']);
  const instant = new h.CitypickedInstantTrigger().description.properties.find((p) => p.name === 'event').options;
  assert.deepEqual(values, instant.map((o) => o.value));
});

test('manual run shows the newest item', async () => {
  const out = await poll({ event: 'newFeedback' }, {}, { mode: 'manual' });
  assert.equal(out[0].length, 1);
  assert.equal(out[0][0].json.id, 'f0000000-0000-4000-8000-000000000001');
  assert.deepEqual(api.lastCall().query, { limit: '1' });
});

test('new private feedback: first poll remembers, later polls emit only new items, once', async () => {
  const state = {};
  assert.equal(await poll({ event: 'newFeedback' }, state), null);
  assert.ok(state.lastTimeChecked);
  assert.match(api.lastCall().query.since, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  addFeedback('f1000000-0000-4000-8000-000000000001');
  addFeedback('f1000000-0000-4000-8000-000000000002');
  const out = await poll({ event: 'newFeedback' }, state);
  assert.deepEqual(out[0].map((i) => i.json.id), ['f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002']);
  assert.equal(api.lastCall().path, '/v1/feedback');

  // The overlap window returns them again; they are not emitted twice.
  assert.equal(await poll({ event: 'newFeedback' }, state), null);
  addFeedback('f1000000-0000-4000-8000-000000000003');
  const next = await poll({ event: 'newFeedback' }, state);
  assert.deepEqual(next[0].map((i) => i.json.id), ['f1000000-0000-4000-8000-000000000003']);
});

test('request rated and new 5-star click poll their status, with the location filter', async () => {
  const rated = {};
  const clicks = {};
  await poll({ event: 'requestRated', location: { __rl: true, mode: 'list', value: IDS.NORD } }, rated);
  assert.deepEqual(api.lastCall().query.status, 'rated');
  assert.equal(api.lastCall().query.location_id, IDS.NORD);
  await poll({ event: 'newFiveStarClick' }, clicks);
  assert.equal(api.lastCall().query.status, 'public_click');

  addRequest('c1000000-0000-4000-8000-000000000001', 'rated');
  addRequest('c1000000-0000-4000-8000-000000000002', 'public_click');
  // Request Rated fires for every new rating, also one that went on to a review site (contract 1.1).
  const r = await poll({ event: 'requestRated', location: { __rl: true, mode: 'list', value: IDS.NORD } }, rated);
  assert.deepEqual(r[0].map((i) => i.json.id), ['c1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002']);
  const c = await poll({ event: 'newFiveStarClick' }, clicks);
  assert.deepEqual(c[0].map((i) => [i.json.id, i.json.status]), [['c1000000-0000-4000-8000-000000000002', 'public_click']]);
});

test('a revoked key fails the poll with the API error', async () => {
  await assert.rejects(poll({ event: 'newFeedback' }, {}, { key: KEYS.closed }), (e) => e.httpCode === '403' && /closed/.test(e.message));
});

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** A review that reached Citypicked now (created_at), written at reviewedAtMs. */
function addReview(id, reviewedAtMs, locationId = IDS.MITTE) {
  api.state.reviews.push({ id, location_id: locationId, rating: 5, text: 'Lovely cut.', author_name: 'Maya Chen', reviewed_at: iso(reviewedAtMs), created_at: nowIso(), reply_text: null, replied_at: null, can_reply: true });
}

test('new Google review: GET /v1/reviews with since on created_at, first poll remembers, then each new review once', async () => {
  api.state.reviews.length = 0;
  addReview('e1000000-0000-4000-8000-000000000001', Date.now() - 60_000);
  const state = {};
  const before = Date.now();
  assert.equal(await poll({ event: 'newGoogleReview' }, state), null);
  assert.equal(api.lastCall().path, '/v1/reviews');
  const { since } = api.lastCall().query;
  assert.deepEqual(api.lastCall().query, { since, limit: '100' });
  assert.ok(Math.abs(Date.parse(since) - (before - 2 * 60 * 1000)) < 5000);

  // Google handed this one over five days after it was written: it reached Citypicked now, so it counts. The old
  // review of a newly connected profile (written 30 days ago) does not.
  addReview('e1000000-0000-4000-8000-000000000002', Date.now() - 5 * DAY);
  addReview('e1000000-0000-4000-8000-000000000003', Date.now() - 30 * DAY);
  addReview('e1000000-0000-4000-8000-000000000004', Date.now() - 30_000, IDS.NORD);
  const out = await poll({ event: 'newGoogleReview' }, state);
  assert.ok(api.lastCall().query.since);
  assert.deepEqual(out[0].map((i) => i.json.id), ['e1000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000004']);
  // The fields of the instant trigger's google_review.created, plus created_at, author, reply and can_reply.
  assert.deepEqual(Object.keys(out[0][0].json), ['id', 'location_id', 'rating', 'text', 'author', 'reviewer_name', 'reviewed_at', 'created_at', 'reply', 'replied', 'url', 'can_reply']);
  const late = out[0][0].json;
  const event = api.reviewEvent(api.state.reviews.find((r) => r.id === late.id));
  for (const k of Object.keys(event)) assert.deepEqual(late[k], event[k], k);
  assert.equal(await poll({ event: 'newGoogleReview' }, state), null);

  const nord = {};
  await poll({ event: 'newGoogleReview', location: { __rl: true, mode: 'list', value: IDS.NORD } }, nord);
  assert.equal(api.lastCall().query.location_id, IDS.NORD);
});

test('new Google review: the fixtures\' late review is found by a poll from before it reached Citypicked', async () => {
  // e7 was written on 11-03 and reached Citypicked on 11-08 11:00, after the newer e1, e2 and e3.
  const state = { lastTimeChecked: '2026-11-08T10:30:00Z', seenIds: [] };
  const out = await poll({ event: 'newGoogleReview' }, state);
  assert.equal(api.lastCall().query.since, '2026-11-08T10:28:00Z');
  assert.deepEqual(out[0].map((i) => i.json.id), ['e0000000-0000-4000-8000-000000000007']);
});

test('new Google review: a manual run shows the newest review', async () => {
  const out = await poll({ event: 'newGoogleReview' }, {}, { mode: 'manual' });
  assert.equal(out[0][0].json.id, 'e0000000-0000-4000-8000-000000000001');
  assert.deepEqual(api.lastCall().query, { limit: '1' });
});

/** An opening of a profile check point now, as the API lists it. */
function addOpening(id, point, locationId = IDS.MITTE, extra = {}) {
  api.state.openings.push({ id, location_id: locationId, point, title: 'Opening hours', hint: null, score: 64, url: 'https://app.example.com/google-profile#' + point, opened_at: nowIso(), done_at: null, ...extra });
}

test('profile check point open: GET /v1/profile-check/points?state=open with since on opened_at, then each new opening once', async () => {
  const state = {};
  const before = Date.now();
  assert.equal(await poll({ event: 'profileCheckPointOpen' }, state), null);
  assert.equal(api.lastCall().path, '/v1/profile-check/points');
  const { since } = api.lastCall().query;
  assert.deepEqual(api.lastCall().query, { state: 'open', since, limit: '100' });
  assert.ok(Math.abs(Date.parse(since) - (before - 2 * 60 * 1000)) < 5000);

  addOpening('d1000000-0000-4000-8000-000000000001', 'hours');
  addOpening('d1000000-0000-4000-8000-000000000002', 'contact', IDS.NORD);
  // Opened and done again since the last poll: not open, so not asked for.
  addOpening('d1000000-0000-4000-8000-000000000003', 'photos', IDS.MITTE, { done_at: nowIso() });
  const out = await poll({ event: 'profileCheckPointOpen' }, state);
  assert.deepEqual(out[0].map((i) => i.json.id).sort(), ['d1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002']);
  // The fields of the instant trigger's profile_check.point_opened, plus id and opened_at.
  const first = out[0].find((i) => i.json.id === 'd1000000-0000-4000-8000-000000000001').json;
  assert.deepEqual(Object.keys(first), ['location_id', 'point', 'title', 'hint', 'score', 'url', 'id', 'opened_at']);
  assert.deepEqual(Object.keys(first).slice(0, 6), Object.keys(h.fixtures.PROFILE_CHECK_POINTS[0]));
  assert.equal(first.point, 'hours');
  assert.equal(await poll({ event: 'profileCheckPointOpen' }, state), null);

  // The same point opens again after it was done: a new opening with a new id, so it starts the workflow again.
  addOpening('d1000000-0000-4000-8000-000000000004', 'hours');
  const again = await poll({ event: 'profileCheckPointOpen' }, state);
  assert.deepEqual(again[0].map((i) => [i.json.id, i.json.point]), [['d1000000-0000-4000-8000-000000000004', 'hours']]);

  await poll({ event: 'profileCheckPointOpen', location: { __rl: true, mode: 'list', value: IDS.NORD } }, {});
  assert.equal(api.lastCall().query.location_id, IDS.NORD);
});

test('profile check point open: a manual run shows the newest open point', async () => {
  const out = await poll({ event: 'profileCheckPointOpen' }, {}, { mode: 'manual' });
  assert.equal(out[0].length, 1);
  assert.equal(out[0][0].json.id, 'd0000000-0000-4000-8000-000000000001');
  assert.equal(out[0][0].json.point, 'photos');
  assert.equal(out[0][0].json.done_at, undefined);
  assert.deepEqual(api.lastCall().query, { state: 'open', limit: '1' });
});
