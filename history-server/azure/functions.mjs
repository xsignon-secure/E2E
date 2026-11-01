/**
 * Azure Functions entry (Node, v4 programming model): the same API as on
 * Vercel under /api/v1/*, plus the dashboard from public/ at /. host.json
 * sets an empty route prefix so the paths match the Vercel deployment.
 * Configuration is in lib/app.mjs (app settings = environment variables).
 */

import { app } from '@azure/functions';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getHandler, SECURITY_HEADERS } from '../lib/app.mjs';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const FILES = { '': ['index.html', 'text/html; charset=utf-8'], 'index.html': ['index.html', 'text/html; charset=utf-8'], 'app.js': ['app.js', 'text/javascript; charset=utf-8'] };

async function toAzure(response) {
  const headers = { ...SECURITY_HEADERS };
  response.headers.forEach((value, name) => { headers[name] = value; });
  return { status: response.status, headers, body: await response.text() };
}

app.http('api', {
  route: 'api/v1/{*path}',
  methods: ['GET', 'POST', 'DELETE'],
  authLevel: 'anonymous',
  handler: async (request) => {
    const method = request.method.toUpperCase();
    const body = method === 'GET' || method === 'DELETE' ? undefined : await request.arrayBuffer();
    const webRequest = new Request(request.url, { method, headers: request.headers, body });
    return toAzure(await (await getHandler())(webRequest));
  },
});

app.http('dashboard', {
  route: '{file?}',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request) => {
    const entry = FILES[request.params.file ?? ''];
    if (!entry) return { status: 404, headers: SECURITY_HEADERS, body: 'Not found' };
    const body = await readFile(PUBLIC + entry[0], 'utf8');
    return { status: 200, headers: { ...SECURITY_HEADERS, 'content-type': entry[1], 'cache-control': 'no-cache' }, body };
  },
});
