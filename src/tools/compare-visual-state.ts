/**
 * Tool 7 — compare-visual-state: the blueprint's visual regression tool.
 *
 * Capture a screenshot of a page (or one element), compare it against a
 * stored baseline, and report *what* changed: how many pixels, where
 * (merged regions), and the average color shift — e.g. "the changed
 * area went from blue rgb(37,99,235) to red rgb(220,38,38)".
 */

import { z } from 'zod';
import { readFile, rm, stat } from 'node:fs/promises';
import { PlaywrightMcpError } from '../types/index.js';
import type { ToolContext, ToolResponse } from '../types/index.js';
import type { RgbaImage, Rgb } from '../utils/image-diff.js';
import { decodePng, diffImages, encodePng } from '../utils/image-diff.js';
import { assertRealPathInside, relativeToRoot, resolvePath, tempFilePath, writeFileInsideRoot } from '../utils/path-utils.js';
import { diagnoseOutput } from '../utils/report-parser.js';
import {
  assertHttpUrl,
  guard,
  pageStateShape,
  resolvePageState,
  resolveProjectRoot,
  runBrowserScript,
  toolError,
  toolText,
  confirmBeforeWrite,
  declinedResult,
} from './shared.js';
import { assertUrlAllowed } from '../utils/url-policy.js';
import { parseLocator } from '../utils/locator-expr.js';

const compareInput = z.object({
  url: z.string().describe('Full URL of the page (or element target) to capture'),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, 'letters, digits, dot, underscore, dash only')
    .describe('Baseline id, e.g. "checkout-page" or "submit-button"'),
  projectRoot: z.string().optional().describe('Project directory; defaults to the server working directory'),
  selector: z
    .string()
    .optional()
    .describe('Capture only this element (selector or locator)'),
  fullPage: z.boolean().optional().describe('Capture the full scrollable page (default false)'),
  mask: z
    .array(z.string().min(1).max(300))
    .max(20)
    .optional()
    .describe('Hide dynamic parts (timestamps, ads, avatars) from both images: selectors or locators. Saved with the baseline and reused by later compares'),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
  waitFor: z.string().optional().describe('Wait for this selector before capturing'),
  ...pageStateShape,
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
  action: z
    .enum(['compare', 'baseline'])
    .optional()
    .describe("'baseline' overwrites the stored baseline; 'compare' (default) compares against it"),
  tolerance: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe('Percent of pixels that may differ before reporting a change (default 0.1)'),
  pixelThreshold: z
    .number()
    .int()
    .min(1)
    .max(765)
    .optional()
    .describe('Combined per-pixel channel delta considered different (default 60)'),
});

export type CompareVisualStateInput = z.infer<typeof compareInput>;
export const compareVisualStateSchema = compareInput;

interface BaselineMeta {
  url: string;
  savedAt: string;
  width: number;
  height: number;
  selector?: string;
  /** Masked selectors/locators, painted over in the baseline and every compare. */
  mask?: string[];
}

const COLOR_NAMES: Array<{ name: string; rgb: Rgb }> = [
  { name: 'white', rgb: { r: 255, g: 255, b: 255 } },
  { name: 'black', rgb: { r: 0, g: 0, b: 0 } },
  { name: 'red', rgb: { r: 220, g: 38, b: 38 } },
  { name: 'orange', rgb: { r: 234, g: 88, b: 12 } },
  { name: 'yellow', rgb: { r: 234, g: 179, b: 8 } },
  { name: 'green', rgb: { r: 22, g: 163, b: 74 } },
  { name: 'cyan', rgb: { r: 8, g: 145, b: 178 } },
  { name: 'blue', rgb: { r: 37, g: 99, b: 235 } },
  { name: 'purple', rgb: { r: 126, g: 34, b: 206 } },
  { name: 'pink', rgb: { r: 219, g: 39, b: 119 } },
  { name: 'brown', rgb: { r: 120, g: 53, b: 15 } },
  { name: 'gray', rgb: { r: 120, g: 113, b: 108 } },
];

function colorName(rgb: Rgb): string {
  let best = COLOR_NAMES[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of COLOR_NAMES) {
    const distance =
      (rgb.r - candidate.rgb.r) ** 2 + (rgb.g - candidate.rgb.g) ** 2 + (rgb.b - candidate.rgb.b) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best.name;
}

function rgbText(rgb: Rgb): string {
  return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    (info) => info.isFile(),
    () => false,
  );
}

function decodeScreenshot(buf: Buffer): RgbaImage {
  try {
    return decodePng(buf);
  } catch (err) {
    throw new PlaywrightMcpError(
      `The screenshot could not be decoded: ${err instanceof Error ? err.message : String(err)}`,
      'UNKNOWN',
      { hint: 'Playwright produced an unexpected image format; re-run the capture.' },
    );
  }
}

export const compareVisualStateTool = {
  name: 'compare-visual-state',
  description:
    'Visual regression check: screenshot a live page (or element), compare it to a stored baseline, and report how many pixels changed, WHERE they changed (bounding regions), and the average color shift ("blue → red"). First call saves the baseline; later calls compare. Writes a red-highlighted diff image for review.',
  inputSchema: compareVisualStateSchema,
  handler: async (args: CompareVisualStateInput, ctx: ToolContext): Promise<ToolResponse> =>
    guard('compare-visual-state', async () => {
      const root = await resolveProjectRoot(args.projectRoot, ctx);
      const url = assertHttpUrl(args.url);
      await assertUrlAllowed(url);
      const state = await resolvePageState(args, root, url, ctx);
      const tolerance = args.tolerance ?? 0.1;
      const timeoutMs = args.timeoutMs ?? 45_000;

      const visualDir = resolvePath(root, '.pw-mcp/visual');
      const baselinePath = resolvePath(visualDir, `${args.name}.png`);
      const metaPath = resolvePath(visualDir, `${args.name}.json`);
      // .pw-mcp/ could be a symlink planted in the project; keep writes inside.
      await assertRealPathInside(visualDir, root);

      // Masks: the argument, else the ones saved with the baseline, so a
      // compare paints over exactly what the baseline painted over.
      const savedMeta = await readFile(metaPath, 'utf8')
        .then((text) => JSON.parse(text) as BaselineMeta)
        .catch(() => null);
      const masks = args.mask ?? (args.action === 'baseline' ? undefined : savedMeta?.mask);
      const maskChains = (masks ?? []).map((entry) => parseLocator(entry));
      const maskChanged = args.mask !== undefined && savedMeta !== null && JSON.stringify(args.mask) !== JSON.stringify(savedMeta.mask ?? []);

      // 1. Capture a fresh screenshot.
      const shotPath = tempFilePath('pw-shot', '.png');
      try {
        const outcome = await runBrowserScript(
          {
            ...state,
            mode: 'screenshot',
            projectRoot: root,
            url,
            selectorChain: args.selector ? parseLocator(args.selector) : undefined,
            waitFor: args.waitFor,
            waitUntil: args.waitUntil,
            includeHtml: false,
            fullPage: args.fullPage,
            maskChains: maskChains.length > 0 ? maskChains : undefined,
            screenshotPath: shotPath,
            gotoTimeout: Math.max(5_000, timeoutMs - 8_000),
            waitTimeout: Math.min(10_000, Math.max(3_000, timeoutMs - 8_000)),
            startedAt: Date.now(),
          },
          { timeoutMs, signal: ctx.signal },
        );

        if (!outcome.ok) {
          const diagnosis = outcome.stderrTail ? diagnoseOutput(outcome.stderrTail) : null;
          return toolError(
            outcome.kind ?? 'UNKNOWN',
            `Could not capture ${url}: ${outcome.error ?? 'unknown error'}`,
            outcome.hint ?? diagnosis?.hint,
            outcome.stderrTail,
          );
        }

        const shot = await readFile(shotPath);
        const current = decodeScreenshot(shot);

        const meta: BaselineMeta = {
          url,
          savedAt: new Date().toISOString(),
          width: current.width,
          height: current.height,
          selector: args.selector,
          ...(masks && masks.length > 0 ? { mask: masks } : {}),
        };

        // 2. First call (or action: 'baseline') stores the baseline.
        const hasBaseline = await exists(baselinePath);
        if (args.action === 'baseline' || !hasBaseline) {
          // Replacing a baseline hides every visual change since it was taken.
          if (hasBaseline) {
            const confirmed = await confirmBeforeWrite(
              ctx,
              `Replace the visual baseline for ${url}?`,
              `The new screenshot (${current.width}×${current.height}${args.selector ? `, ${args.selector}` : ''}) becomes the baseline at ${relativeToRoot(root, baselinePath)}. Later comparisons will no longer flag what changed since the old one.`,
            );
            if (confirmed === 'declined') return declinedResult(`replacing the baseline for ${url}`);
          }
          try {
            await writeFileInsideRoot(baselinePath, shot, root);
            await writeFileInsideRoot(metaPath, JSON.stringify(meta, null, 2), root);
          } catch (err) {
            if (err instanceof PlaywrightMcpError) throw err;
            const code = (err as NodeJS.ErrnoException).code;
            const kind = code === 'ENOSPC' ? 'DISK_FULL' : 'UNKNOWN';
            const diagnosis = diagnoseOutput(`${code ?? ''} ${err instanceof Error ? err.message : ''}`);
            throw new PlaywrightMcpError(
              `Could not save the baseline at ${relativeToRoot(root, baselinePath)}`,
              kind,
              {
                hint:
                  diagnosis?.hint ??
                  'Check that the project directory is writable and has free space.',
              },
            );
          }
          const verb = args.action === 'baseline' ? 'overwritten' : 'created';
          return toolText(
            [
              `## 📸 Baseline ${verb} — "${args.name}"`,
              '',
              `**URL:** ${url}`,
              `**Size:** ${current.width}×${current.height}${args.selector ? ` (element: \`${args.selector}\`)` : ''}`,
              `**Saved:** \`${relativeToRoot(root, baselinePath)}\``,
              ...(masks && masks.length > 0 ? [`**Masked:** ${masks.map((m) => `\`${m}\``).join(', ')} (reused by later compares)`] : []),
              '',
              hasBaseline && args.action === 'baseline'
                ? '_Future `compare` calls will diff against this new baseline._'
                : '_Make your UI change, then call compare-visual-state again with the same `name` (and `action: "compare"` or omitted)._',
            ].join('\n'),
          );
        }

        // 3. Compare against the baseline.
        const baselinePng = await readFile(baselinePath);
        const baseline = decodeScreenshot(baselinePng);
        const baselineMeta = savedMeta;
        const maskLines = [
          ...(masks && masks.length > 0 ? [`**Masked:** ${masks.map((m) => `\`${m}\``).join(', ')}`] : []),
          ...(maskChanged ? ['> ⚠️ These masks differ from the ones saved with the baseline, so masked areas may show as changes. Re-take the baseline with `action: "baseline"` and the same `mask`.'] : []),
        ];

        const result = diffImages(baseline, current, { pixelThreshold: args.pixelThreshold });

        const lines: string[] = [];
        if (result.diffPixels === 0 || result.percent <= tolerance) {
          lines.push(
            `## ✅ No visual change — "${args.name}"`,
            '',
            `**Changed:** 0 pixel(s)${result.diffPixels > 0 ? ` (${result.percent}% — within tolerance ${tolerance}%)` : ''}`,
            `**Size:** ${result.width}×${result.height} · **Baseline:** ${baselineMeta?.savedAt ?? 'unknown date'}`,
            ...maskLines,
            '',
            '_Nothing worth flagging — the render matches the baseline._',
          );
          return toolText(lines.join('\n'));
        }

        // Write the annotated diff image for review.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const diffPath = resolvePath(visualDir, `diffs/${args.name}-${stamp}.png`);
        try {
          await writeFileInsideRoot(diffPath, encodePng(result.diffImage), root);
        } catch {
          // Diff image is a nice-to-have; the numbers below still stand.
        }

        lines.push(`## ⚠️ Visual change detected — "${args.name}"`, '');
        lines.push(`**URL:** ${url}`);
        lines.push(...maskLines);
        lines.push(
          `**Changed:** ${result.percent}% of pixels (${result.diffPixels.toLocaleString('en-US')} px) — tolerance ${tolerance}%`,
        );
        lines.push(`**Size:** baseline ${baseline.width}×${baseline.height} → now ${current.width}×${current.height}`);
        if (result.dimensionsChanged) {
          lines.push('> ⚠️ Dimensions changed between baseline and capture — layout shifted.');
        }
        if (baselineMeta && baselineMeta.url !== url) {
          lines.push(
            `> ⚠️ This baseline was captured for a different URL (${baselineMeta.url}) on ${baselineMeta.savedAt}.`,
          );
        }
        lines.push('');

        if (result.regions.length > 0) {
          lines.push('### Changed regions (largest first)', '');
          for (const region of result.regions) {
            lines.push(
              `- (${region.x}, ${region.y}) ${region.width}×${region.height} — ${region.pixels.toLocaleString('en-US')} px`,
            );
          }
          lines.push('');
        }

        if (result.beforeAvg && result.afterAvg) {
          const beforeName = colorName(result.beforeAvg);
          const afterName = colorName(result.afterAvg);
          const shift =
            beforeName === afterName
              ? `stayed ${afterName} but shifted in shade`
              : `${beforeName} → ${afterName}`;
          lines.push('### Color shift in changed area', '');
          lines.push(`- Average: ${rgbText(result.beforeAvg)} (${beforeName}) → ${rgbText(result.afterAvg)} (${afterName})`);
          lines.push(`- **${shift}**`);
          lines.push('');
        }

        lines.push(`**Diff image:** \`${relativeToRoot(root, diffPath)}\` (gray = unchanged, red = changed)`, '');
        lines.push('### Next steps', '');
        lines.push(
          '1. If the change is intentional, re-baseline: `compare-visual-state` with `action: "baseline"`.',
          '2. If not, review the CSS/markdown files you touched — the regions above point at the affected area.',
          '3. Re-run the affected E2E tests with `run-test` to confirm behavior still matches.',
        );
        return toolText(lines.join('\n'));
      } finally {
        await rm(shotPath, { force: true }).catch(() => undefined);
      }
    }),
};
