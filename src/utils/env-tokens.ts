/**
 * {{env:NAME}} placeholders: secrets the agent names but never sees. Only
 * names that are plainly test credentials are readable (E2E_*, TEST_*, PW_*,
 * PLAYWRIGHT_*, LOGIN_*; never the server's own PW_MCP_* settings), plus any the user lists in PW_MCP_LOGIN_ENV, so a
 * page cannot talk the agent into sending AWS_SECRET_ACCESS_KEY somewhere.
 */

import { PlaywrightMcpError } from '../types/index.js';

export const ENV_TOKEN_RE = /\{\{env:([A-Z0-9_]+)\}\}/g;

export function secretEnvAllowed(name: string): boolean {
  if (/^(E2E|TEST|PW|PLAYWRIGHT|LOGIN)_[A-Z0-9_]+$/.test(name) && !name.startsWith('PW_MCP_')) return true;
  const extra = (process.env.PW_MCP_LOGIN_ENV ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return extra.includes(name);
}

/** Replace every {{env:NAME}} in `text` with the allowed, set variable. */
export function resolveEnvTokens(text: string): string {
  return text.replace(ENV_TOKEN_RE, (_all, name: string) => {
    if (!secretEnvAllowed(name)) {
      throw new PlaywrightMcpError(`{{env:${name}}} is not an allowed variable`, 'INVALID_INPUT', {
        hint: 'Name it E2E_*, TEST_*, PW_*, PLAYWRIGHT_* or LOGIN_* (e.g. E2E_API_TOKEN), or list it in PW_MCP_LOGIN_ENV.',
      });
    }
    const value = process.env[name];
    if (value === undefined || value === '') {
      throw new PlaywrightMcpError(`Not set in the server's environment: ${name}`, 'INVALID_INPUT', {
        hint: 'Set it where the MCP server starts (the env block of your MCP client config), then restart the server.',
      });
    }
    return value;
  });
}
