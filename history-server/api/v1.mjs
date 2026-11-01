/**
 * Vercel entry: every /api/v1/* path is rewritten here (see vercel.json).
 * Configuration is in lib/app.mjs.
 */

import { getHandler } from '../lib/app.mjs';

async function route(request) {
  // The rewrite passes the original path in ?path=; restore it.
  const url = new URL(request.url);
  const original = url.searchParams.get('path');
  if (original !== null) {
    url.searchParams.delete('path');
    url.pathname = `/api/v1/${original.replace(/^\/+/, '')}`;
    request = new Request(url, request);
  }
  return (await getHandler())(request);
}

export const GET = route;
export const POST = route;
export const DELETE = route;
