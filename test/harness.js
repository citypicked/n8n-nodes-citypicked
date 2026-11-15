'use strict';
/**
 * Minimal stand-ins for n8n's execute, poll and load-options contexts, enough to run the built nodes (dist/)
 * against integrations/automation-mock. Authentication comes from the credential class itself: its generic
 * authenticate headers are resolved with the test credentials, so a wrong header template fails the tests.
 */
const { startMockApi, KEYS, fixtures } = require('../../automation-mock');
const { Citypicked } = require('../dist/nodes/Citypicked/Citypicked.node.js');
const { CitypickedTrigger } = require('../dist/nodes/CitypickedTrigger/CitypickedTrigger.node.js');
const { CitypickedInstantTrigger } = require('../dist/nodes/CitypickedInstantTrigger/CitypickedInstantTrigger.node.js');
const { CitypickedApi } = require('../dist/credentials/CitypickedApi.credentials.js');

const credentialType = new CitypickedApi();

function resolveCredentialTemplate(template, credentials) {
  return String(template)
    .replace(/^=/, '')
    .replace(/\{\{\s*\$credentials\??\.(\w+)\s*\}\}/g, (_, key) => String(credentials[key] ?? ''));
}

/** this.helpers.httpRequestWithAuthentication, as far as the nodes use it. */
async function httpRequestWithAuthentication(credentials, credentialName, options) {
  if (credentialName !== credentialType.name) throw new Error(`unexpected credential ${credentialName}`);
  const headers = { ...(options.headers || {}) };
  for (const [name, template] of Object.entries(credentialType.authenticate.properties.headers)) {
    headers[name] = resolveCredentialTemplate(template, credentials);
  }
  const url = new URL(options.url);
  for (const [k, v] of Object.entries(options.qs || {})) if (v !== undefined) url.searchParams.set(k, String(v));
  let body;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { method: options.method || 'GET', headers, body });
  const raw = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || '';
  let parsed = raw;
  if (options.encoding !== 'arraybuffer') parsed = contentType.includes('json') ? JSON.parse(raw.toString('utf8')) : raw.toString('utf8');
  if (!options.ignoreHttpStatusErrors && res.status >= 400) throw new Error(`HTTP ${res.status}`);
  return options.returnFullResponse ? { statusCode: res.status, headers: Object.fromEntries(res.headers.entries()), body: parsed } : parsed;
}

const NODE = { id: 'test', name: 'Citypicked', type: 'n8n-nodes-citypicked.citypicked', typeVersion: 1, position: [0, 0], parameters: {} };

function baseContext(credentials) {
  return {
    getCredentials: async () => credentials,
    getNode: () => NODE,
    helpers: {
      httpRequestWithAuthentication(name, options) {
        return httpRequestWithAuthentication(credentials, name, options);
      },
      async prepareBinaryData(data, fileName, mimeType) {
        return { data: Buffer.from(data).toString('base64'), fileName, mimeType, fileExtension: fileName.split('.').pop() };
      },
    },
  };
}

/** Runs the Citypicked node once per item; params(i) or a plain object gives the node parameters. */
async function execute(params, { key = KEYS.owner, baseUrl, items = [{ json: {} }], continueOnFail = false } = {}) {
  const credentials = { apiKey: key, baseUrl };
  const ctx = {
    ...baseContext(credentials),
    getInputData: () => items,
    getNodeParameter(name, i, fallback) {
      const p = typeof params === 'function' ? params(i) : params;
      return p[name] === undefined ? fallback : p[name];
    },
    continueOnFail: () => continueOnFail,
  };
  const [out] = await new Citypicked().execute.call(ctx);
  return out;
}

/** One poll of the trigger node, with the static data kept by the caller between polls. */
async function poll(params, { key = KEYS.owner, baseUrl, staticData, mode = 'trigger' }) {
  const ctx = {
    ...baseContext({ apiKey: key, baseUrl }),
    getNodeParameter: (name, fallback) => (params[name] === undefined ? fallback : params[name]),
    getWorkflowStaticData: () => staticData,
    getMode: () => mode,
  };
  return new CitypickedTrigger().poll.call(ctx);
}

/** The instant trigger's activation methods (checkExists, create, delete) with n8n's hook context. */
async function hook(method, params, { key = KEYS.owner, baseUrl, staticData, webhookUrl }) {
  const ctx = {
    ...baseContext({ apiKey: key, baseUrl }),
    getNodeParameter: (name, fallback) => (params[name] === undefined ? fallback : params[name]),
    getWorkflowStaticData: () => staticData,
    getNodeWebhookUrl: () => webhookUrl,
  };
  return new CitypickedInstantTrigger().webhookMethods.default[method].call(ctx);
}

/** One delivery to the instant trigger: the raw body and headers as n8n's webhook request has them. */
async function webhook(params, { staticData, rawBody, headers }) {
  const response = { code: 200, body: undefined };
  const res = { status(c) { response.code = c; return res; }, send(b) { response.body = b; return res; }, end() { return res; } };
  const ctx = {
    getNode: () => NODE,
    getNodeParameter: (name, fallback) => (params[name] === undefined ? fallback : params[name]),
    getWorkflowStaticData: () => staticData,
    getRequestObject: () => ({ rawBody: Buffer.from(rawBody), headers }),
    getBodyData: () => JSON.parse(rawBody),
    getResponseObject: () => res,
  };
  const out = await new CitypickedInstantTrigger().webhook.call(ctx);
  return { out, response };
}

async function searchLocations(filter, { key = KEYS.owner, baseUrl }) {
  const node = new Citypicked();
  return node.methods.listSearch.searchLocations.call(baseContext({ apiKey: key, baseUrl }), filter);
}

module.exports = { startMockApi, KEYS, fixtures, execute, poll, hook, webhook, searchLocations, credentialType, Citypicked, CitypickedTrigger, CitypickedInstantTrigger, httpRequestWithAuthentication };
