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

const run = (params, opts = {}) => h.execute(params, { baseUrl: api.baseUrl, ...opts });
const loc = (value) => ({ __rl: true, mode: 'list', value });
const SEND = { resource: 'request', operation: 'send', location: loc(IDS.MITTE), channel: 'email', email: 'rita.lopez@example.com', customerName: 'Rita Lopez', consent: true, consentMethod: '', additionalFields: {} };

test('credentials: Bearer header, GET {baseUrl}/me as the test, production by default', async () => {
  const cred = h.credentialType;
  assert.equal(cred.name, 'citypickedApi');
  assert.equal(cred.authenticate.properties.headers.Authorization, '=Bearer {{$credentials.apiKey}}');
  assert.deepEqual(cred.test.request, { baseURL: '={{$credentials.baseUrl}}', url: '/me' });
  assert.equal(cred.properties.find((p) => p.name === 'baseUrl').default, 'https://api.citypicked.com/v1');
  assert.equal(cred.properties.find((p) => p.name === 'apiKey').typeOptions.password, true);
  const me = await h.httpRequestWithAuthentication({ apiKey: KEYS.owner }, 'citypickedApi', { url: `${api.baseUrl}${cred.test.request.url}`, json: true });
  assert.equal(me.account.name, 'Salon Sonnenschein');
  assert.equal(api.lastCall().key, KEYS.owner);
});

test('node description: the resources and operations of #488', () => {
  const { properties } = new h.Citypicked().description;
  const ops = (resource) => properties.find((p) => p.name === 'operation' && p.displayOptions.show.resource[0] === resource).options.map((o) => o.value);
  assert.deepEqual(properties.find((p) => p.name === 'resource').options.map((o) => o.value), ['feedback', 'location', 'request', 'stats']);
  assert.deepEqual(ops('request'), ['get', 'getAll', 'send']);
  assert.deepEqual(ops('feedback'), ['getAll']);
  assert.deepEqual(ops('location'), ['getAll', 'getReviewLink']);
  assert.deepEqual(ops('stats'), ['get']);
});

test('request send: POST /v1/requests with one contact, Idempotency-Key from the booking ID', async () => {
  const [item] = await run({ ...SEND, additionalFields: { bookingId: 'booking-1001' } });
  assert.equal(item.json.outcome, 'created');
  assert.match(item.json.request_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(item.pairedItem, { item: 0 });
  const call = api.lastCall();
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/v1/requests');
  assert.equal(call.idempotencyKey, 'email:booking-1001');
  assert.deepEqual(call.body, { channel: 'email', consent: true, contacts: [{ name: 'Rita Lopez', email: 'rita.lopez@example.com' }], location_id: IDS.MITTE });
  const [replay] = await run({ ...SEND, additionalFields: { bookingId: 'booking-1001' } });
  assert.deepEqual(replay.json, item.json);
});

test('request send: SMS to a US number needs the consent method; with it, it sends', async () => {
  const sms = { ...SEND, location: loc(IDS.BROOKLYN), channel: 'sms', phone: '+12015550111', email: undefined };
  await assert.rejects(run(sms), (e) => e.name === 'NodeOperationError' && /needs a consent method/.test(e.message));
  const [failed] = await run(sms, { continueOnFail: true });
  assert.match(failed.json.error, /needs a consent method/);
  const [ok] = await run({ ...sms, consentMethod: 'booking' });
  assert.equal(ok.json.outcome, 'created');
  assert.deepEqual(api.lastCall().body, { channel: 'sms', consent: true, contacts: [{ name: 'Rita Lopez', phone: '+12015550111' }], location_id: IDS.BROOKLYN, consent_method: 'booking' });
});

test('request send: duplicate passes with its outcome; no consent and no credits fail', async () => {
  const [dup] = await run({ ...SEND, email: 'anna.mueller@example.org' });
  assert.deepEqual(dup.json, { request_id: null, outcome: 'duplicate', message: 'Asked within the last 30 days.', created: 0, channel: 'email', location_id: IDS.MITTE, whatsapp_url: null });
  await assert.rejects(run({ ...SEND, consent: false }), (e) => e.name === 'NodeApiError' && e.httpCode === '400' && /\(field: consent\)/.test(e.message));
  await assert.rejects(run({ ...SEND, location: loc(''), channel: 'sms', phone: '+447700900111' }, { key: KEYS.nocredits }), (e) => /No SMS credits left/.test(e.message));
});

test('request send: WhatsApp link, Send At in UTC, conflicting booking ID', async () => {
  const [wa] = await run({ ...SEND, channel: 'whatsapp', phone: '+447700900555', email: undefined });
  assert.equal(wa.json.whatsapp_url, 'https://wa.me/447700900555');
  await run({ ...SEND, additionalFields: { sendAt: '2026-11-09T10:00:00+01:00', bookingId: 'b-9' } });
  assert.equal(api.lastCall().body.send_at, '2026-11-09T09:00:00Z');
  await assert.rejects(run({ ...SEND, email: 'other@example.com', additionalFields: { bookingId: 'b-9' } }), (e) => e.httpCode === '409' && /different body/.test(e.message));
  await assert.rejects(run({ ...SEND, additionalFields: { sendAt: 'soon' } }), (e) => /Send At is not a date/.test(e.message));
});

test('request send: empty location works when the key sees one location', async () => {
  const [item] = await run({ ...SEND, location: loc(''), email: 'zoe@example.com' }, { key: KEYS.single });
  assert.equal(item.json.outcome, 'created');
  assert.equal(api.lastCall().body.location_id, undefined);
});

test('request get and get many: filters, limit and every page', async () => {
  const [one] = await run({ resource: 'request', operation: 'get', requestId: 'a0000000-0000-4000-8000-000000000001' });
  assert.equal(one.json.contact.name, 'Anna M.');
  assert.equal(api.lastCall().path, '/v1/requests/a0000000-0000-4000-8000-000000000001');
  const three = await run({ resource: 'request', operation: 'getAll', returnAll: false, limit: 3, filters: {} });
  assert.equal(three.length, 3);
  assert.equal(api.lastCall().query.limit, '3');
  const all = await run({ resource: 'request', operation: 'getAll', returnAll: true, filters: {} });
  assert.equal(all.length, 10);
  // status rated means "has a rating"; since compares the rating time (contract 1.1).
  const rated = await run({ resource: 'request', operation: 'getAll', returnAll: true, filters: { status: 'rated', since: '2026-11-05T00:00:00.000Z', location: loc(IDS.MITTE) } });
  assert.deepEqual(rated.map((r) => r.json.id), ['a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002']);
  assert.deepEqual(api.lastCall().query, { status: 'rated', since: '2026-11-05T00:00:00Z', location_id: IDS.MITTE, limit: '100' });
});

test('feedback get many and location get many', async () => {
  const feedback = await run({ resource: 'feedback', operation: 'getAll', returnAll: true, filters: { status: 'new' } });
  assert.deepEqual(feedback.map((f) => f.json.text), ['The wait was too long.']);
  assert.equal(api.lastCall().path, '/v1/feedback');
  const locations = await run({ resource: 'location', operation: 'getAll', returnAll: false, limit: 2 });
  assert.deepEqual(locations.map((l) => l.json.name), ['Salon Sonnenschein Brooklyn', 'Salon Sonnenschein Nord']);
});

test('location review link, with the QR code as a file', async () => {
  const [link] = await run({ resource: 'location', operation: 'getReviewLink', location: loc(IDS.NORD), downloadQrCode: false });
  assert.equal(link.json.url, 'https://go.example.com/salon-nord');
  assert.equal(link.binary, undefined);
  const [withQr] = await run({ resource: 'location', operation: 'getReviewLink', location: { __rl: true, mode: 'id', value: IDS.NORD }, downloadQrCode: true, qrFormat: 'png', binaryPropertyName: 'qr' });
  assert.equal(withQr.binary.qr.mimeType, 'image/png');
  assert.equal(withQr.binary.qr.fileName, 'citypicked-review-qr.png');
  assert.equal(Buffer.from(withQr.binary.qr.data, 'base64').subarray(1, 4).toString('latin1'), 'PNG');
  assert.deepEqual(api.lastCall().query, { format: 'png' });
  await assert.rejects(run({ resource: 'location', operation: 'getReviewLink', location: loc(IDS.MITTE), downloadQrCode: false }, { key: KEYS.member }), (e) => e.httpCode === '404');
});

test('stats get: location and date range as days', async () => {
  const [stats] = await run({ resource: 'stats', operation: 'get', location: loc(IDS.NORD), dateRange: { from: '2026-11-01T00:00:00', to: '2026-11-08T00:00:00' } });
  assert.deepEqual(api.lastCall().query, { location_id: IDS.NORD, from: '2026-11-01', to: '2026-11-08' });
  assert.equal(stats.json.rated, 2);
  const [all] = await run({ resource: 'stats', operation: 'get', location: loc(''), dateRange: {} });
  assert.equal(all.json.location_id, null);
});

test('location dropdown: searchLocations filters by name', async () => {
  const all = await h.searchLocations(undefined, { baseUrl: api.baseUrl });
  assert.equal(all.results.length, 3);
  const nord = await h.searchLocations('nord', { baseUrl: api.baseUrl });
  assert.deepEqual(nord.results, [{ name: 'Salon Sonnenschein Nord', value: IDS.NORD, url: 'https://go.example.com/salon-nord' }]);
});

test('errors: 401 says how to fix the key, 429 says when to retry', async () => {
  await assert.rejects(run({ resource: 'stats', operation: 'get', dateRange: {} }, { key: 'cp_live_wrong' }), (e) => e.httpCode === '401' && /Settings > API/.test(e.description));
  await assert.rejects(run({ resource: 'stats', operation: 'get', dateRange: {} }, { key: KEYS.ratelimited }), (e) => e.httpCode === '429' && /30 seconds/.test(e.message));
});
