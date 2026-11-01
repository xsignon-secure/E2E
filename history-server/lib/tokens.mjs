/**
 * Who is calling: a bearer token the person hosting the server handed out.
 * There are no accounts and no billing; the host lists the tokens in
 * HISTORY_TOKENS and each one opens its own space (team), so one team can
 * never read or delete another's runs.
 *
 *   HISTORY_TOKENS="web:9f2c…,mobile:41aa…"   two teams, each with its token
 *   HISTORY_TOKENS="9f2c…"                     one shared space
 *
 * A token is at least 16 characters (letters, digits, - and _). Generate one
 * with `openssl rand -hex 24`. Tokens are compared in constant time and
 * never stored or logged; a bare token's space is named after its hash.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;
const TEAM_RE = /^[A-Za-z0-9][\w.-]{0,63}$/;

/** Stable, non-reversible id for a token; never store the token itself. */
export function tokenFingerprint(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/** Parse HISTORY_TOKENS into [{ team, token }], throwing on a bad entry. */
export function parseTokens(raw) {
  const entries = [];
  for (const part of String(raw ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const colon = part.indexOf(':');
    const team = colon > 0 ? part.slice(0, colon).trim() : undefined;
    const token = colon > 0 ? part.slice(colon + 1).trim() : part;
    if (!TOKEN_RE.test(token)) throw new Error('HISTORY_TOKENS: each token needs 16+ characters of letters, digits, - or _ (try: openssl rand -hex 24)');
    if (team !== undefined && !TEAM_RE.test(team)) throw new Error(`HISTORY_TOKENS: "${team}" is not a valid team name (letters, digits, . _ -)`);
    entries.push({ team: team ?? `token-${tokenFingerprint(token)}`, token });
  }
  return entries;
}

/**
 * A validator over the configured tokens. Resolves { ok, team } so the
 * handler can scope every call to that team.
 */
export function tokenValidator(env = process.env) {
  const entries = parseTokens(env.HISTORY_TOKENS);
  if (!entries.length) throw new Error('HISTORY_TOKENS is not set: list at least one token (see the README)');
  const known = entries.map(({ team, token }) => ({ team, digest: createHash('sha256').update(token).digest() }));
  return async function validate(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return { ok: false, reason: 'invalid' };
    const digest = createHash('sha256').update(token).digest();
    let team;
    for (const entry of known) if (timingSafeEqual(entry.digest, digest)) team = entry.team;
    return team ? { ok: true, team } : { ok: false, reason: 'invalid' };
  };
}
