/**
 * Ask the person before a tool changes files in their project.
 *
 * Tools that write test code or project state (suggest-fix `apply`,
 * generate-e2e-test, quarantine add/remove, compare-visual-state `baseline`)
 * call `ctx.confirmWrite()` right before the write, with the exact change
 * they are about to make. When the client can show a form (MCP elicitation),
 * the server answers the call with an `input_required` result (the
 * 2026-07-28 multi-round-trip pattern; the SDK turns it into a classic
 * elicitation request for 2025 clients). The client shows the change, the
 * person says yes or no, and the client retries the call with the answer.
 *
 * The approval is bound to the change: the question's key is a hash of the
 * tool, title and detail, so if the retried call would write something
 * different it asks again instead of reusing an old "yes".
 *
 * PW_MCP_CONFIRM_WRITES:
 *   auto   (default) ask when the client supports elicitation; otherwise
 *          write as before and say no one was asked
 *   always ask, and refuse to write when the client cannot ask
 *   off    never ask
 */

import { createHash } from 'node:crypto';
import { CLIENT_CAPABILITIES_META_KEY, inputRequired, inputResponse } from '@modelcontextprotocol/server';
import type { InputRequiredResult } from '@modelcontextprotocol/server';
import { PlaywrightMcpError } from '../types/index.js';

export type ConfirmMode = 'auto' | 'always' | 'off';

/** What the tool is about to do, shown to the person. */
export interface WriteConfirmation {
  /** One line: "Apply this fix to tests/cart.spec.ts:42?" */
  title: string;
  /** The change itself (a diff, the file to be written, the entry to add). */
  detail: string;
}

/**
 * - `approved`: the person said yes.
 * - `declined`: the person said no (or cancelled): do not write.
 * - `not-asked`: confirmation is off, or the client cannot ask: write as before.
 */
export type ConfirmOutcome = 'approved' | 'declined' | 'not-asked';

export type ConfirmWrite = (request: WriteConfirmation) => Promise<ConfirmOutcome>;

/**
 * Thrown by `confirmWrite` when the person has to be asked. It carries the
 * `input_required` result; the server returns it instead of a tool result.
 * Tools must let it through (guard() rethrows it).
 */
export class ConfirmationPending extends Error {
  readonly result: InputRequiredResult;

  constructor(result: InputRequiredResult) {
    super('waiting for the person to confirm a file change');
    this.name = 'ConfirmationPending';
    this.result = result;
  }
}

export function confirmMode(value = process.env.PW_MCP_CONFIRM_WRITES): ConfirmMode {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'off' || normalized === '0' || normalized === 'false') return 'off';
  if (normalized === 'always' || normalized === 'require' || normalized === 'required') return 'always';
  return 'auto';
}

/** Longest change shown in the question; clients show it as plain text. */
export const MAX_DETAIL_CHARS = 4_000;

/** Whether declared client capabilities include form-mode elicitation. */
export function supportsFormElicitation(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== 'object') return false;
  const elicitation = (capabilities as Record<string, unknown>).elicitation;
  if (!elicitation || typeof elicitation !== 'object') return false;
  const modes = elicitation as Record<string, unknown>;
  // `{}` (2025-06-18) means form mode; a client that lists modes must list form.
  if ('form' in modes || 'url' in modes) return 'form' in modes;
  return true;
}

/** The input key for one exact change: a new change gets a new question. */
export function confirmationKey(tool: string, request: WriteConfirmation): string {
  const digest = createHash('sha256').update(`${tool}\n${request.title}\n${request.detail}`).digest('hex');
  return `confirm_write_${digest.slice(0, 20)}`;
}

function questionText(tool: string, request: WriteConfirmation): string {
  const detail =
    request.detail.length > MAX_DETAIL_CHARS
      ? `${request.detail.slice(0, MAX_DETAIL_CHARS)}\n… (${request.detail.length - MAX_DETAIL_CHARS} more characters)`
      : request.detail;
  return `${request.title}\n\n${detail}\n\n(${tool} asks before changing files in your project. Set PW_MCP_CONFIRM_WRITES=off to stop asking.)`;
}

export interface ConfirmerOptions {
  tool: string;
  /** Retried-call answers (`ctx.mcpReq.inputResponses`). */
  inputResponses?: Record<string, unknown>;
  /** Per-request envelope (2026-07-28) or undefined on 2025 connections. */
  envelope?: Record<string, unknown>;
  /** Capabilities from the 2025 initialize handshake. */
  sessionCapabilities?: unknown;
  mode?: ConfirmMode;
}

/** Build the `confirmWrite` a tool call gets in its context. */
export function createConfirmWrite(options: ConfirmerOptions): ConfirmWrite {
  return async (request) => {
    const mode = options.mode ?? confirmMode();
    if (mode === 'off') return 'not-asked';
    const key = confirmationKey(options.tool, request);
    const answer = inputResponse(options.inputResponses, key);
    if (answer.kind === 'elicit') {
      return answer.action === 'accept' && answer.content?.confirm === true ? 'approved' : 'declined';
    }
    const capabilities = options.envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? options.sessionCapabilities;
    if (!supportsFormElicitation(capabilities)) {
      if (mode === 'always') {
        throw new PlaywrightMcpError(`Not written: ${request.title.replace(/\?$/, '')} needs your confirmation, and this client cannot ask`, 'INVALID_INPUT', {
          hint: 'PW_MCP_CONFIRM_WRITES=always refuses file changes in clients without elicitation. Use a client that supports it, or set PW_MCP_CONFIRM_WRITES=auto.',
        });
      }
      return 'not-asked';
    }
    throw new ConfirmationPending(
      inputRequired({
        inputRequests: {
          [key]: inputRequired.elicit({
            message: questionText(options.tool, request),
            requestedSchema: {
              type: 'object',
              properties: {
                confirm: {
                  type: 'boolean',
                  title: 'Make this change',
                  description: 'Yes writes the change. No leaves your files as they are.',
                  default: false,
                },
              },
              required: ['confirm'],
            },
          }),
        },
      }),
    );
  };
}

/** The line tools add to a result when the person was or was not asked. */
export function confirmationNote(outcome: ConfirmOutcome): string | undefined {
  if (outcome === 'approved') return '> ✅ You confirmed this change.';
  return undefined;
}
