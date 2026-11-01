/**
 * `playwright-e2e-mcp upload`: send the project's recorded runs to the
 * team's history server (PW_MCP_HISTORY_TOKEN + PW_MCP_HISTORY_URL), so CI
 * runs from every machine end up in one history that analyze-history and
 * the dashboard read.
 *
 * Only runs newer than the last upload are sent (remembered in
 * .playwright-e2e-mcp/history-upload.json); the server also ignores
 * duplicates, so a repeated upload is harmless.
 *
 * Exit codes: 0 uploaded (or nothing new), 1 the upload failed,
 * 2 bad arguments or no history server configured.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { joinProjectPath, toNativePath } from '../utils/path-utils.js';
import { historyProjectName, historySettings, uploadRuns } from '../utils/history-client.js';
import { HISTORY_DIR, readHistory } from '../utils/run-history.js';

export const UPLOAD_USAGE = [
  'Usage: playwright-e2e-mcp upload [options]',
  '',
  "Uploads recorded runs to your team's history server (history-server/ in the",
  'repo, free to self-host). Needs PW_MCP_HISTORY_TOKEN and PW_MCP_HISTORY_URL.',
  '',
  '  --project <name>       name to file runs under (default: PW_MCP_HISTORY_PROJECT,',
  '                         the GitHub repository, or the folder name)',
  '  --project-root <dir>   project directory (default: cwd)',
  '  --all                  send every recorded run, not only new ones',
  '',
].join('\n');

const MARKER = 'history-upload.json';
/** The marker's name in 0.7 and 0.8, still read so an upgrade does not resend everything. */
const OLD_MARKER = 'pro-upload.json';

export async function runUpload(argv: string[]): Promise<number> {
  let values: { project?: string; 'project-root'?: string; all?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { project: { type: 'string' }, 'project-root': { type: 'string' }, all: { type: 'boolean' } },
      strict: true,
    }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${UPLOAD_USAGE}`);
    return 2;
  }
  let settings;
  try {
    settings = historySettings();
  } catch (error) {
    process.stderr.write(`upload: ${(error as Error).message}\n`);
    return 2;
  }
  if (!settings) {
    process.stderr.write('upload: PW_MCP_HISTORY_TOKEN is not set. A shared history server is optional; without one nothing is sent anywhere.\n');
    return 2;
  }
  const root = path.resolve(values['project-root'] ?? process.cwd()).replace(/\\/g, '/');
  const project = values.project ?? (await historyProjectName(root));
  const marker = joinProjectPath(root, `${HISTORY_DIR}/${MARKER}`);
  const readMarker = (file: string) =>
    readFile(toNativePath(file), 'utf8')
      .then((text) => String((JSON.parse(text) as { lastAt?: string }).lastAt ?? ''))
      .catch(() => '');
  const last = values.all ? '' : (await readMarker(marker)) || (await readMarker(joinProjectPath(root, `${HISTORY_DIR}/${OLD_MARKER}`)));
  const runs = (await readHistory(root, 500)).filter((entry) => entry.at > last);
  if (runs.length === 0) {
    process.stdout.write(`Nothing new to upload for ${project}.\n`);
    return 0;
  }
  try {
    const result = await uploadRuns(settings, project, runs);
    process.stdout.write(`Uploaded ${runs.length} run(s) to ${project}: ${result.stored} stored, ${result.skipped} already there.\n`);
    await writeFile(toNativePath(marker), `${JSON.stringify({ lastAt: runs[runs.length - 1].at, project })}\n`, 'utf8').catch(() => undefined);
    return 0;
  } catch (error) {
    const err = error as Error & { hint?: string };
    process.stderr.write(`upload: ${err.message}${err.hint ? `\n${err.hint}` : ''}\n`);
    return 1;
  }
}
