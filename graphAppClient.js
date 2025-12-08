// Minimal Microsoft Graph app-only client using client credentials (msal-node)
// Provides getAppToken() and graphRequest()/graphPost() helpers.

const axios = require('axios');
const { ConfidentialClientApplication } = require('@azure/msal-node');

const {
  AZURE_AD_TENANT_ID,
  AZURE_AD_CLIENT_ID,
  AZURE_AD_CLIENT_SECRET,
  GRAPH_TIMEOUT_MS = '15000',
} = process.env;

let _msal = null;
let _cached = { token: null, exp: 0 };

function isConfigured() {
  return !!(AZURE_AD_TENANT_ID && AZURE_AD_CLIENT_ID && AZURE_AD_CLIENT_SECRET);
}

function getMsal() {
  if (!_msal) {
    if (!isConfigured()) throw new Error('graph_app_not_configured');
    _msal = new ConfidentialClientApplication({
      auth: {
        clientId: AZURE_AD_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${AZURE_AD_TENANT_ID}`,
        clientSecret: AZURE_AD_CLIENT_SECRET,
      },
      system: { loggerOptions: { loggerCallback: () => {} } },
    });
  }
  return _msal;
}

async function getAppToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_cached.token && _cached.exp - 60 > now) return _cached.token; // 60s early refresh buffer
  const client = getMsal();
  const res = await client.acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'] });
  const token = res && res.accessToken;
  if (!token) throw new Error('graph_token_missing');
  const exp = res.expiresOn ? Math.floor(res.expiresOn.getTime() / 1000) : now + 3000;
  _cached = { token, exp };
  return token;
}

async function graphRequest(method, url, body, extraHeaders) {
  if (!/^https:\/\/graph\.microsoft\.com\//i.test(String(url))) {
    throw new Error('graph_invalid_url');
  }
  const token = await getAppToken();
  const timeout = Math.max(1000, parseInt(GRAPH_TIMEOUT_MS, 10) || 15000);
  const headers = Object.assign({
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }, extraHeaders || {});
  const resp = await axios({ method, url, data: body, headers, timeout, validateStatus: () => true });
  if (resp.status >= 200 && resp.status < 300) return resp.data;
  const detail = resp.data && (resp.data.error || resp.data);
  const err = new Error(`graph_${resp.status}`);
  err.detail = detail;
  throw err;
}

function graphPost(url, body, headers) {
  return graphRequest('POST', url, body, headers);
}

module.exports = { isConfigured, getAppToken, graphRequest, graphPost };
