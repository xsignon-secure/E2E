/**
 * Compact rendering of inspect-page's locator map.
 *
 * Two things keep it short without losing what an agent acts on:
 *
 * - Alternatives are listed only when they add a different, stable way to
 *   reach the element (a test id or role next to a text locator, say).
 *   getByText and raw CSS alternatives are dropped: the best locator is
 *   already verified unique.
 * - Repeated blocks (product cards, table rows, list items) are shown once
 *   and the rest are summarised by name, since their locators differ only
 *   in the item's name or number.
 */

import type { ElementInfo } from '../types/index.js';
import { formatLocator } from './locator-expr.js';

/** Alternatives worth a reader's tokens: they address the element another stable way. */
const USEFUL_ALT = /^(getByTestId|getByRole|getByLabel|getByPlaceholder)\(/;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function method(locator: string): string {
  return locator.slice(0, locator.indexOf('(') + 1);
}

function best(element: ElementInfo): string {
  const chain = element.locators?.[0];
  return chain ? formatLocator(chain) : element.selector;
}

export function renderLocatorLine(element: ElementInfo, position: number): string {
  const first = best(element);
  const alts = (element.locators ?? [])
    .slice(1)
    .map((chain) => formatLocator(chain))
    .filter((alt) => USEFUL_ALT.test(alt) && method(alt) !== method(first))
    .slice(0, 1)
    .map((alt) => `\`${alt}\``);
  const label = element.role ? `${element.role}${element.name ? ` "${clip(element.name, 60)}"` : ''}` : element.tag;
  return `${position}. \`${first}\` — ${label}${alts.length > 0 ? ` · also ${alts.join(', ')}` : ''}`;
}

/**
 * The shape of an element's locator with every name and number blanked,
 * so the "Add to cart" button of card 3 and card 7 compare equal.
 */
export function locatorShape(element: ElementInfo): string {
  const shape = best(element)
    .replace(/'(?:[^'\\]|\\.)*'/g, "'…'")
    .replace(/"(?:[^"\\]|\\.)*"/g, '"…"')
    .replace(/\d+/g, '#');
  return `${element.role ?? element.tag}|${shape}`;
}

interface Run {
  start: number;
  size: number;
  repeats: number;
}

/** The longest run of a repeated block starting at `start` (block size 1–8, at least 3 repeats, 5 hidden lines). */
function findRun(shapes: string[], start: number): Run | undefined {
  let found: Run | undefined;
  for (let size = 1; size <= 8 && start + size * 3 <= shapes.length; size += 1) {
    let repeats = 1;
    while (start + (repeats + 1) * size <= shapes.length) {
      let same = true;
      for (let k = 0; k < size; k += 1) {
        if (shapes[start + repeats * size + k] !== shapes[start + k]) {
          same = false;
          break;
        }
      }
      if (!same) break;
      repeats += 1;
    }
    // Collapse only when it hides at least five lines; shorter runs read better in full.
    if (repeats >= 3 && (repeats - 1) * size >= 5 && (!found || repeats * size > found.repeats * found.size)) found = { start, size, repeats };
  }
  return found;
}

/** A block's display name: its first named element (a heading or image name, usually). */
function blockName(block: ElementInfo[]): string | undefined {
  const named = block.find((el) => el.name && el.name.trim()) ?? block.find((el) => el.text && el.text.trim());
  const text = named?.name ?? named?.text;
  return text ? clip(text, 40) : undefined;
}

/**
 * Render the locator map, numbered by position in `elements`, with
 * repeated blocks collapsed after their first occurrence.
 */
export function renderLocatorMap(elements: ElementInfo[]): string[] {
  const shapes = elements.map(locatorShape);
  const lines: string[] = [];
  let i = 0;
  while (i < elements.length) {
    const run = findRun(shapes, i);
    if (!run) {
      lines.push(renderLocatorLine(elements[i], i + 1));
      i += 1;
      continue;
    }
    for (let k = 0; k < run.size; k += 1) lines.push(renderLocatorLine(elements[i + k], i + k + 1));
    const restStart = i + run.size;
    const restEnd = i + run.size * run.repeats;
    const names: string[] = [];
    for (let b = restStart; b < restEnd; b += run.size) {
      const name = blockName(elements.slice(b, b + run.size));
      if (name) names.push(`"${name}"`);
    }
    const shown = names.slice(0, 30);
    const more = names.length > shown.length ? `, …${names.length - shown.length} more` : '';
    lines.push(
      `${restStart + 1}–${restEnd}. ↳ ${run.repeats - 1} more blocks like ${run.size === 1 ? i + 1 : `${i + 1}–${restStart}`}: same locators with the item's own name or number` +
        (shown.length > 0 ? `: ${shown.join(', ')}${more}` : '') +
        '. Pass `selector` to list one in full.',
    );
    i = restEnd;
  }
  return lines;
}
