/**
 * Serves the bundled agent skill over MCP with the Skills extension
 * (`io.modelcontextprotocol/skills`, SEP-2640).
 *
 * The same `skill/playwright-e2e-mcp` folder that ships as a zip for Claude
 * Code, Gemini CLI and skill marketplaces is offered here as
 * `skill://playwright-e2e-mcp/SKILL.md` plus its reference files. A client
 * that supports the extension can load the playbook straight from the
 * server it is connected to, so the instructions always match the installed
 * server version and nobody has to install the skill separately. Clients
 * that do not know the extension never see it: it only adds the
 * `skills/list` and `skills/get` methods and a resource template.
 *
 * Set PW_MCP_SKILLS=0 to turn it off. When the folder is missing (a build
 * that left it out), nothing is attached.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { SkillsExtension, skillEntry } from '@modelcontextprotocol/server/ext/skills';
import type { Skill, SkillSource } from '@modelcontextprotocol/server/ext/skills';
import { bundledSkillDir, SKILL_NAME } from './cli/init.js';
import { LIST_TTL_MS } from './discovery.js';
import { logger } from './utils/logger.js';

export const SKILL_BASE_URI = 'skill://';

/** Every regular file under `dir`, keyed by its `/`-separated relative path. */
function readTree(dir: string, prefix = ''): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const entry of readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, readTree(dir, rel));
    else if (entry.isFile()) files[rel] = readFileSync(path.join(dir, rel));
  }
  return files;
}

interface LoadedSkill {
  entry: Skill;
  /** File contents by resource URI. */
  files: Map<string, Uint8Array>;
}

/** A SkillSource over one skill folder, read once on first use. */
export function folderSkillSource(dir: string, name = SKILL_NAME): SkillSource {
  let loaded: Promise<LoadedSkill> | undefined;
  const load = (): Promise<LoadedSkill> => {
    loaded ??= (async () => {
      const raw = readTree(dir);
      const entry = await skillEntry(name, raw, { baseUri: SKILL_BASE_URI });
      const files = new Map(Object.entries(raw).map(([rel, bytes]) => [`${SKILL_BASE_URI}${name}/${rel}`, bytes]));
      return { entry, files };
    })();
    return loaded;
  };
  return {
    async list() {
      return { skills: [(await load()).entry] };
    },
    async get(uri) {
      const { entry } = await load();
      return uri === entry.uri ? entry : undefined;
    },
    async read(uri) {
      const bytes = (await load()).files.get(uri);
      if (!bytes) return undefined;
      return uri.endsWith('.md') ? { text: Buffer.from(bytes).toString('utf8'), mimeType: 'text/markdown' } : { bytes };
    },
  };
}

let extension: SkillsExtension | null | undefined;

/** The shared extension instance, or null when skills are off or missing. */
function bundledSkillsExtension(): SkillsExtension | null {
  if (extension !== undefined) return extension;
  const dir = bundledSkillDir();
  if (process.env.PW_MCP_SKILLS === '0') {
    extension = null;
  } else if (!existsSync(path.join(dir, 'SKILL.md')) || !statSync(dir).isDirectory()) {
    logger.debug('bundled skill folder not found; skills extension off', { dir });
    extension = null;
  } else {
    extension = new SkillsExtension({
      source: folderSkillSource(dir),
      // The files only change with the package version.
      cacheHint: { ttlMs: LIST_TTL_MS, cacheScope: 'public' },
      onWarning: (warning) => logger.warn('skill problem', { ...warning }),
    });
  }
  return extension;
}

/** Attach the bundled skill to `server` (before it connects). Returns whether it did. */
export function attachBundledSkill(server: McpServer): boolean {
  const ext = bundledSkillsExtension();
  if (!ext) return false;
  try {
    ext.attach(server);
    return true;
  } catch (err) {
    logger.warn('could not attach the skills extension', { error: err });
    return false;
  }
}
