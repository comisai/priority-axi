// Shared steps for commands that talk to Priority.

import type { CommandInput, Token, Values } from '../cli/table.ts';
import { readSettings, type Settings } from '../config.ts';
import { AxiError, usage } from '../errors.ts';
import { type Answer, rowsOf, send, stringValue } from '../http.ts';
import {
  type CompanyCheck,
  cacheDir,
  type IndexSource,
  type LoadedIndex,
  loadIndex,
  readCompany,
  readIndex,
  recordReach,
  staleReason,
  writeCompany,
} from '../index/cache.ts';
import { screenSegment, utc } from '../odata.ts';

export interface Session {
  settings: Settings;
  dir: string;
  input: CommandInput;
}

const text = (v: unknown) => (typeof v === 'string' ? v : undefined);

export function open(input: CommandInput): Session {
  const settings = readSettings(input.io.env, {
    company: text(input.values.company),
    user: text(input.values.user),
    ini: text(input.values.ini),
  });
  return { settings, dir: cacheDir(settings, input.io.env), input };
}

export async function priorityVersion(s: Session): Promise<string> {
  const answer = await send(
    s.settings,
    { method: 'GET', path: 'GetPriorityVersion()' },
    s.input.io.http,
  );
  return stringValue(answer, 'version');
}

/**
 * Prove the company exists. Function calls such as GetPriorityVersion()
 * accept any company code, so only GETCOMPANIES can tell. The answer is
 * cached for seven days; `live` always asks Priority.
 */
export async function checkCompany(
  s: Session,
  live: boolean,
): Promise<CompanyCheck> {
  const now = s.input.io.now();
  if (!live) {
    const cached = readCompany(s.dir, s.settings.company, now);
    if (cached) return cached;
  }
  const answer = await send(
    s.settings,
    { method: 'GET', path: 'GETCOMPANIES' },
    s.input.io.http,
  );
  const rows = rowsOf(answer);
  const row = rows.find((r) => r.NAME === s.settings.company);
  if (!row) {
    const known = rows
      .map((r) => r.NAME)
      .filter((n): n is string => typeof n === 'string');
    throw new AxiError(
      'company_not_found',
      `Priority does not list company ${s.settings.company} for this user.${known.length ? ` Companies: ${known.slice(0, 20).join(', ')}.` : ''} Check the code with the owner.`,
    );
  }
  const check = {
    code: s.settings.company,
    title: typeof row.TITLE === 'string' ? row.TITLE : '',
    checkedAt: now.toISOString(),
  };
  writeCompany(s.dir, check);
  return check;
}

export function indexSource(s: Session): IndexSource {
  return {
    fetchVersion: () => priorityVersion(s),
    fetchMetadata: async () => {
      const answer = await send(
        s.settings,
        { method: 'GET', path: '$metadata', query: '?$format=json' },
        s.input.io.http,
      );
      if (!answer.json)
        throw new AxiError(
          'priority_error',
          'Priority returned metadata that is not JSON.',
        );
      return { csdl: answer.json, bytes: answer.bytes, ms: answer.ms };
    },
  };
}

/**
 * The screen index, offline while the cache is fresh. Before downloading the
 * metadata, the company is checked, so a typo never builds a cache.
 */
export async function screenIndex(s: Session): Promise<LoadedIndex> {
  const now = s.input.io.now();
  const cached = readIndex(s.dir);
  if (cached && !staleReason(cached, { now })) return { index: cached };
  await checkCompany(s, false);
  return loadIndex(s.dir, indexSource(s), { now });
}

/** A note for output when this command had to build the index first. */
export function builtNote(loaded: LoadedIndex): Record<string, string> {
  if (!loaded.rebuilt) return {};
  const mb = (loaded.rebuilt.bytes / 2 ** 20).toFixed(1);
  return { index: `built now from Priority's metadata (${mb} MB)` };
}

/** Send a read for a screen, recording whether Priority allowed API access to it. */
export async function readScreen(
  s: Session,
  screen: string,
  query: string,
): Promise<Answer> {
  const now = s.input.io.now();
  try {
    const answer = await send(
      s.settings,
      {
        method: 'GET',
        path: screenSegment(screen),
        query,
        context: { screen },
      },
      s.input.io.http,
    );
    recordReach(s.dir, screen, 'yes', now);
    return answer;
  } catch (error) {
    if (error instanceof AxiError && error.code === 'screen_not_enabled') {
      recordReach(s.dir, screen, 'no', now);
    }
    throw error;
  }
}

// ---------- flag helpers ----------

export const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;

export const strings = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string')
    : typeof v === 'string'
      ? [v]
      : [];

export function intFlag(
  v: unknown,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (v === undefined) return fallback;
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw usage(`--${name} takes a whole number from ${min} to ${max}.`);
  }
  return n;
}

/** --since as a date, a full time, or a relative 7d or 24h. */
export function sinceFlag(v: unknown, now: Date): string {
  if (typeof v !== 'string' || !v) {
    throw usage(
      'changes needs --since <time>, such as --since 7d, --since 24h or --since 2026-11-01.',
    );
  }
  const rel = /^(\d{1,4})([dh])$/.exec(v);
  if (rel) {
    const hours = Number(rel[1]) * (rel[2] === 'd' ? 24 : 1);
    return new Date(now.getTime() - hours * 3600_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
  }
  return utc(v, '--since');
}

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** A shell word: bare when safe, otherwise single-quoted. */
export function shellWord(word: string): string {
  return SAFE_WORD.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Rebuild a command line for a help hint, with some flags replaced or removed. */
export function commandLine(
  name: string,
  positionals: string[],
  values: Values,
  change: Record<string, string | null> = {},
): string {
  const parts = [`priority-axi ${name}`, ...positionals.map(shellWord)];
  const seen = new Set<string>();
  const emit = (flag: string, value: unknown) => {
    if (value === true) parts.push(`--${flag}`);
    else if (typeof value === 'string')
      parts.push(`--${flag}`, shellWord(value));
  };
  for (const [flag, value] of Object.entries(values)) {
    if (value === undefined || flag in change) continue;
    seen.add(flag);
    if (Array.isArray(value)) for (const item of value) emit(flag, item);
    else emit(flag, value);
  }
  for (const [flag, value] of Object.entries(change)) {
    if (value !== null && !seen.has(flag))
      emit(flag, value === '' ? true : value);
  }
  return parts.join(' ');
}

/** Rebuild a command in the order given, for commands where order carries meaning (create). */
export function tokenLine(
  name: string,
  tokens: readonly Token[],
  drop: readonly string[] = [],
): string {
  const parts = [`priority-axi ${name}`];
  for (const token of tokens) {
    if (token.kind === 'positional') parts.push(shellWord(token.value));
    else if (!drop.includes(token.name)) {
      parts.push(`--${token.name}`);
      if (token.value !== undefined) parts.push(shellWord(token.value));
    }
  }
  return parts.join(' ');
}
