#!/usr/bin/env node
/**
 * Says whether a release tag is the newest stable release, so the publish
 * workflows only move npm's `latest` dist-tag and the Docker `latest` tag
 * forward. Without this, two tags pushed together (or a patch for an older
 * line, e.g. v0.15.2 after v0.16.0) let whichever job finishes last own
 * `latest`.
 *
 *   node scripts/is-latest-tag.mjs v0.16.0            # prints true or false
 *   node scripts/is-latest-tag.mjs v0.16.0 v0.15.0 …  # compare with these tags instead of the remote's
 *
 * With no tags given it reads every v* tag on `origin` (git ls-remote), so it
 * sees tags pushed after this checkout was made.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const STABLE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** [major, minor, patch] for a stable release tag; undefined for anything else. */
export function parseStable(tag) {
  const match = STABLE.exec(String(tag).trim());
  return match ? match.slice(1, 4).map(Number) : undefined;
}

/** True when `tag` is stable and no other stable tag in `tags` is newer. */
export function isLatestTag(tag, tags) {
  const mine = parseStable(tag);
  if (!mine) return false;
  for (const other of tags) {
    const theirs = parseStable(other);
    if (!theirs) continue;
    for (let i = 0; i < 3; i += 1) {
      if (theirs[i] > mine[i]) return false;
      if (theirs[i] < mine[i]) break;
    }
  }
  return true;
}

/** Tags on origin, else the local ones; empty (so the tag counts as newest) when git cannot say. */
function remoteTags() {
  try {
    const out = execFileSync('git', ['ls-remote', '--tags', '--refs', 'origin', 'refs/tags/v*'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out
      .split('\n')
      .map((line) => line.split('refs/tags/')[1])
      .filter(Boolean);
  } catch {
    try {
      return execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
    } catch {
      console.error('is-latest-tag: could not list tags; treating this tag as the newest');
      return [];
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [tag, ...given] = process.argv.slice(2);
  if (!tag) {
    console.error('usage: node scripts/is-latest-tag.mjs <tag> [other tags…]');
    process.exit(2);
  }
  console.log(isLatestTag(tag, given.length > 0 ? given : remoteTags()) ? 'true' : 'false');
}
