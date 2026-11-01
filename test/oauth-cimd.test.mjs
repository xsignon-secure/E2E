/**
 * Client ID Metadata Documents: the sign-in MCP clients use since the
 * 2025-11-25 spec. The client's id is an https URL; the server fetches the
 * JSON document there and checks it. The fetch is faked here (with the real
 * fetcher's checks), and the whole sign-in runs against createOAuthServer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createOAuthServer, isAllowedRedirectUri } from '../dist/oauth.js';
import {
  MAX_METADATA_BYTES,
  createClientMetadataFetcher,
  isClientMetadataUrl,
  validateClientMetadata,
} from '../dist/utils/client-metadata.js';

const TOKEN = 'cimd-test-access-key';
const ORIGIN = 'https://bridge.example.org';
const CLIENT_ID = 'https://app.example.com/oauth/client.json';
const REDIRECT = 'https://app.example.com/callback';
const DOCUMENT = { client_id: CLIENT_ID, client_name: 'Example App', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' };

function fakeFetch(documents, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    const doc = documents[url];
    if (doc === undefined) return new Response('not found', { status: 404 });
    const body = typeof doc === 'string' ? doc : JSON.stringify(doc);
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const publicResolve = async () => ['93.184.216.34'];

function server({ documents = { [CLIENT_ID]: DOCUMENT }, calls, resolve = publicResolve, ...rest } = {}) {
  const redirectAllowed = (uri) => isAllowedRedirectUri(uri);
  return createOAuthServer({
    token: TOKEN,
    mcpPath: '/mcp',
    fetchClientMetadata: createClientMetadataFetcher({ fetch: fakeFetch(documents, calls), resolve, redirectAllowed }),
    ...rest,
  });
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function authorizeRequest(clientId, challenge, { post = false, extra = {} } = {}) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'abc',
    ...extra,
  });
  if (!post) return new Request(`${ORIGIN}/oauth/authorize?${params}`);
  params.set('access_key', TOKEN);
  return new Request(`${ORIGIN}/oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
}

function tokenRequest(params) {
  return new Request(`${ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

test('the server metadata says metadata documents are supported, and keeps registration', async () => {
  const meta = await (await server().handle(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`))).json();
  assert.equal(meta.client_id_metadata_document_supported, true);
  assert.equal(meta.registration_endpoint, `${ORIGIN}/oauth/register`);
  const off = await (await server({ clientMetadataDocuments: false }).handle(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`))).json();
  assert.equal(off.client_id_metadata_document_supported, false);
});

test('a client signs in with an https client_id, end to end', async () => {
  const calls = [];
  const oauth = server({ calls });
  const { verifier, challenge } = pkce();

  const pageRes = await oauth.handle(authorizeRequest(CLIENT_ID, challenge));
  assert.equal(pageRes.status, 200);
  const html = await pageRes.text();
  assert.match(html, /<strong>Example App<\/strong> at <code>app\.example\.com<\/code> wants/);

  const redirect = await oauth.handle(authorizeRequest(CLIENT_ID, challenge, { post: true }));
  assert.equal(redirect.status, 302);
  const location = new URL(redirect.headers.get('location'));
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT);
  assert.equal(location.searchParams.get('state'), 'abc');

  const tokens = await (
    await oauth.handle(
      tokenRequest({ grant_type: 'authorization_code', code: location.searchParams.get('code'), redirect_uri: REDIRECT, client_id: CLIENT_ID, code_verifier: verifier }),
    )
  ).json();
  assert.equal(tokens.token_type, 'Bearer');
  assert.ok(oauth.verifyAccessToken(`Bearer ${tokens.access_token}`));

  const refreshed = await (await oauth.handle(tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: CLIENT_ID }))).json();
  assert.ok(oauth.verifyAccessToken(`Bearer ${refreshed.access_token}`));

  // The document was fetched safely, once (then cached).
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, 'error');
  assert.ok(calls[0].init.signal);
});

test('a code issued to one client id cannot be redeemed by another', async () => {
  const other = 'https://evil.example.net/client.json';
  const oauth = server({ documents: { [CLIENT_ID]: DOCUMENT, [other]: { ...DOCUMENT, client_id: other } } });
  const { verifier, challenge } = pkce();
  const redirect = await oauth.handle(authorizeRequest(CLIENT_ID, challenge, { post: true }));
  const code = new URL(redirect.headers.get('location')).searchParams.get('code');
  const res = await oauth.handle(tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: other, code_verifier: verifier }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_grant');
});

test('a redirect_uri the document does not list is refused before anything is sent there', async () => {
  const { challenge } = pkce();
  const res = await server().handle(authorizeRequest(CLIENT_ID, challenge, { extra: { redirect_uri: 'https://attacker.example/cb' } }));
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Invalid redirect/);
});

test('bad documents are refused with a reason', async () => {
  const cases = [
    [{ ...DOCUMENT, client_id: 'https://app.example.com/other.json' }, /client_id does not match/],
    [{ ...DOCUMENT, redirect_uris: ['http://app.example.com/cb'] }, /redirect URI is not allowed/],
    [{ ...DOCUMENT, token_endpoint_auth_method: 'client_secret_basic' }, /only public clients/],
    ['not json', /not valid JSON/],
    ['x'.repeat(MAX_METADATA_BYTES + 1), /too large/],
  ];
  for (const [doc, reason] of cases) {
    const { challenge } = pkce();
    const res = await server({ documents: { [CLIENT_ID]: doc } }).handle(authorizeRequest(CLIENT_ID, challenge));
    assert.equal(res.status, 400);
    assert.match(await res.text(), reason);
  }
  const { challenge } = pkce();
  const missing = await server({ documents: {} }).handle(authorizeRequest(CLIENT_ID, challenge));
  assert.match(await missing.text(), /HTTP 404/);
});

test('documents on private or reserved addresses are never fetched', async () => {
  for (const address of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '::1', '::ffff:192.168.1.1']) {
    const calls = [];
    const { challenge } = pkce();
    const res = await server({ calls, resolve: async () => [address] }).handle(authorizeRequest(CLIENT_ID, challenge));
    assert.equal(res.status, 400);
    assert.match(await res.text(), /private or reserved address/);
    assert.equal(calls.length, 0, `${address} was not fetched`);
  }
});

test('only well-formed https URLs count as metadata document client ids', () => {
  assert.equal(isClientMetadataUrl(CLIENT_ID), true);
  for (const bad of [
    'http://app.example.com/client.json',
    'https://app.example.com/',
    'https://app.example.com',
    'https://user:pw@app.example.com/client.json',
    'https://app.example.com/client.json#x',
    'https://app.example.com/a/../client.json',
    'https://app.example.com/a/%2e%2e/client.json',
    'https://APP.example.com/client.json',
    'not a url',
    42,
  ]) {
    assert.equal(isClientMetadataUrl(bad), false, String(bad));
  }
  assert.throws(() => validateClientMetadata(CLIENT_ID, [], () => true), /not a JSON object/);
});

test('PW_MCP_OAUTH_CIMD=0 turns metadata documents off; registered clients still work', async () => {
  const oauth = server({ clientMetadataDocuments: false });
  const { challenge } = pkce();
  const res = await oauth.handle(authorizeRequest(CLIENT_ID, challenge));
  assert.equal(res.status, 400);
  assert.match(await res.text(), /not registered/);

  const registered = await (
    await oauth.handle(
      new Request(`${ORIGIN}/oauth/register`, { method: 'POST', body: JSON.stringify({ client_name: 'Old', redirect_uris: [REDIRECT] }) }),
    )
  ).json();
  const page = await oauth.handle(authorizeRequest(registered.client_id, challenge));
  assert.equal(page.status, 200);
});
