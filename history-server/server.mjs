#!/usr/bin/env node
/**
 * The history server on plain Node, for a VM, a spare machine or the Docker
 * image: the API under /api/v1/* and the dashboard at /.
 *
 *   HISTORY_TOKENS=web:$(openssl rand -hex 24) HISTORY_DATA_DIR=./data node server.mjs
 *
 * PORT (default 8787) and HOST (default 0.0.0.0) pick where it listens. Put
 * it behind HTTPS (a reverse proxy such as Caddy, or your platform's TLS):
 * the MCP refuses to send a token over plain http except to localhost.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHandler, SECURITY_HEADERS } from './lib/app.mjs';

const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};
const MAX_BODY = 5 * 1024 * 1024;

export async function startServer({ port = Number(process.env.PORT ?? 8787), host = process.env.HOST ?? '0.0.0.0', env = process.env } = {}) {
  const handle = await getHandler(env);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const file = req.method === 'GET' ? FILES[url.pathname] : undefined;
      if (file) {
        const body = await readFile(PUBLIC + file[0]);
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': file[1], 'cache-control': 'no-cache' }).end(body);
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) {
          res.writeHead(413, { ...SECURITY_HEADERS, 'content-type': 'application/json' }).end('{"error":"Upload too large"}');
          return;
        }
        chunks.push(chunk);
      }
      const method = (req.method ?? 'GET').toUpperCase();
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
      const request = new Request(url, { method, headers, body: method === 'GET' || method === 'HEAD' || method === 'DELETE' ? undefined : Buffer.concat(chunks) });
      const response = await handle(request);
      const out = { ...SECURITY_HEADERS };
      response.headers.forEach((value, name) => (out[name] = value));
      res.writeHead(response.status, out).end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error('history-server', error);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"Something went wrong on the history server"}');
    }
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startServer()
    .then((server) => {
      const { port } = server.address();
      console.log(`history-server listening on port ${port}`);
    })
    .catch((error) => {
      console.error(`history-server: ${error.message}`);
      process.exit(1);
    });
}
