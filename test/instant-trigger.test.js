'use strict';
/** The instant trigger (contract 1.2): activation subscribes, deactivation deletes, deliveries are checked. */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const h = require('./harness');
const { signDelivery } = require('../../automation-mock');

const { KEYS, fixtures } = h;
const { IDS } = fixtures;
let api;
let receiver;
const got = [];
before(async () => {
  api = await h.startMockApi({ limits: { read: 1000, send: 1000 } });
  receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      got.push({ headers: req.headers, rawBody: Buffer.concat(chunks).toString('utf8') });
      res.end();
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
});
after(async () => {
  await api.close();
  await new Promise((r) => receiver.close(r));
});
beforeEach(() => {
  api.reset();
  got.length = 0;
});

const ALL = { location: { __rl: true, mode: 'list', value: '' } };
const hookUrl = () => `http://127.0.0.1:${receiver.address().port}/webhook/abc/webhook`;
const hook = (method, params, staticData, opts = {}) => h.hook(method, { ...ALL, ...params }, { baseUrl: api.baseUrl, staticData, webhookUrl: hookUrl(), ...opts });
const feedback = { id: 'f0000000-0000-4000-8000-0000000000aa', location_id: IDS.MITTE, request_id: null, rating: 2, text: 'Too loud.', contact: { name: 'Eva K.' }, status: 'new', created_at: '2026-11-08T11:00:00Z' };

test('description: a webhook trigger with the five events, next to the polling trigger', () => {
  const d = new h.CitypickedInstantTrigger().description;
  assert.equal(d.polling, undefined);
  assert.deepEqual(d.webhooks.map((w) => [w.name, w.httpMethod]), [['default', 'POST']]);
  assert.deepEqual(d.properties.find((p) => p.name === 'event').options.map((o) => o.value), ['newFiveStarClick', 'newGoogleReview', 'newFeedback', 'profileCheckPointOpen', 'requestRated']);
  assert.equal(new h.CitypickedTrigger().description.polling, true);
});

test('activation: create subscribes the webhook URL to the event and keeps id and secret; checkExists finds it; delete removes it', async () => {
  const staticData = {};
  assert.equal(await hook('checkExists', { event: 'requestRated' }, staticData), false);
  assert.equal(await hook('create', { event: 'requestRated' }, staticData), true);
  assert.deepEqual(api.lastCall().body, { url: hookUrl(), events: ['request.rated'] });
  assert.match(staticData.webhookSecret, /^cpwh_/);
  assert.ok(staticData.webhookId);
  assert.equal(await hook('checkExists', { event: 'requestRated' }, staticData), true);
  // Another event chosen since: the old webhook does not count.
  assert.equal(await hook('checkExists', { event: 'newFeedback' }, { ...staticData }), false);
  const id = staticData.webhookId;
  assert.equal(await hook('delete', { event: 'requestRated' }, staticData), true);
  assert.equal(api.lastCall().method, 'DELETE');
  assert.equal(api.lastCall().path, `/v1/webhooks/${id}`);
  assert.deepEqual(staticData, {});
  // Gone already: checkExists says so, delete is still fine.
  assert.equal(await hook('checkExists', { event: 'requestRated' }, { webhookId: id }), false);
  assert.equal(await hook('delete', { event: 'requestRated' }, { webhookId: id }), true);
});

test('a delivery starts the workflow with the event data; a bad signature is refused with 401; another event or location gives nothing', async () => {
  const staticData = {};
  await hook('create', { event: 'newFeedback' }, staticData);
  await api.emit('feedback.created', { data: feedback });
  assert.equal(got.length, 1);
  const params = { ...ALL, event: 'newFeedback' };
  const ok = await h.webhook(params, { staticData, rawBody: got[0].rawBody, headers: got[0].headers });
  assert.deepEqual(ok.out.workflowData, [[{ json: feedback }]]);
  const forged = await h.webhook(params, { staticData, rawBody: got[0].rawBody.replace('Too loud.', 'Too quiet.'), headers: got[0].headers });
  assert.equal(forged.out.noWebhookResponse, true);
  assert.equal(forged.response.code, 401);
  const old = signDelivery(staticData.webhookSecret, JSON.parse(got[0].rawBody), Date.now() - 600_000);
  assert.equal((await h.webhook(params, { staticData, rawBody: old.body, headers: old.headers })).response.code, 401);
  assert.equal((await h.webhook(params, { staticData: {}, rawBody: got[0].rawBody, headers: got[0].headers })).response.code, 401);
  const other = await h.webhook({ ...params, event: 'requestRated' }, { staticData, rawBody: got[0].rawBody, headers: got[0].headers });
  assert.deepEqual(other.out.workflowData, []);
  const elsewhere = await h.webhook({ event: 'newFeedback', location: { __rl: true, mode: 'id', value: IDS.NORD } }, { staticData, rawBody: got[0].rawBody, headers: got[0].headers });
  assert.deepEqual(elsewhere.out.workflowData, []);
});

test('1.5: New Google Review and Profile Check Point Open subscribe to their event and start with its data', async () => {
  for (const [event, type] of [['newGoogleReview', 'google_review.created'], ['profileCheckPointOpen', 'profile_check.point_opened']]) {
    api.reset();
    got.length = 0;
    const staticData = {};
    assert.equal(await hook('create', { event }, staticData), true);
    assert.deepEqual(api.lastCall().body, { url: hookUrl(), events: [type] });
    assert.equal(await hook('checkExists', { event }, staticData), true);
    const { event: sent } = await api.emit(type);
    assert.equal(got.length, 1);
    const params = { ...ALL, event };
    const ok = await h.webhook(params, { staticData, rawBody: got[0].rawBody, headers: got[0].headers });
    assert.deepEqual(ok.out.workflowData, [[{ json: sent.data }]]);
    const mitte = await h.webhook({ event, location: { __rl: true, mode: 'id', value: IDS.MITTE } }, { staticData, rawBody: got[0].rawBody, headers: got[0].headers });
    assert.deepEqual(mitte.out.workflowData, [[{ json: sent.data }]]);
    const nord = await h.webhook({ event, location: { __rl: true, mode: 'id', value: IDS.NORD } }, { staticData, rawBody: got[0].rawBody, headers: got[0].headers });
    assert.deepEqual(nord.out.workflowData, []);
    const other = await h.webhook({ ...params, event: event === 'newGoogleReview' ? 'profileCheckPointOpen' : 'newGoogleReview' }, { staticData, rawBody: got[0].rawBody, headers: got[0].headers });
    assert.deepEqual(other.out.workflowData, []);
  }
});

test('activation needs a key with the send scope', async () => {
  await assert.rejects(hook('create', { event: 'newFeedback' }, {}, { key: KEYS.readonly }), /send/);
});
