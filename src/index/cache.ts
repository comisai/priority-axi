// The cache is derived data. Every file is written to a temporary name and
// renamed, so a crash leaves the old file or the new one, never half of each.
// A file that cannot be read is treated as missing and rebuilt.

import { createHash, randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Settings } from '../config.ts';
import { buildIndex, INDEX_FORMAT, type ScreenIndex } from './build.ts';

export const MAX_INDEX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function cacheDir(settings: Settings, env: NodeJS.ProcessEnv): string {
  const base = env.XDG_CACHE_HOME || join(homedir(), '.cache');
  const id = createHash('sha256')
    .update(`${settings.origin}|${settings.ini}|${settings.company}`)
    .digest('hex')
    .slice(0, 32);
  return join(base, 'priority-axi', id);
}

export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function isIndex(value: unknown): value is ScreenIndex {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<ScreenIndex>;
  return (
    v.format === INDEX_FORMAT &&
    typeof v.version === 'string' &&
    typeof v.builtAt === 'string' &&
    !!v.sets &&
    typeof v.sets === 'object' &&
    !!v.types &&
    typeof v.types === 'object'
  );
}

export function readIndex(dir: string): ScreenIndex | undefined {
  const value = readJson(join(dir, 'index.json'));
  return isIndex(value) ? value : undefined;
}

export type StaleReason = 'missing' | 'refresh' | 'version' | 'age';

/** Why the cached index must be rebuilt, or undefined when it is fresh. */
export function staleReason(
  index: ScreenIndex | undefined,
  opts: { now: Date; refresh?: boolean; liveVersion?: string },
): StaleReason | undefined {
  if (!index) return 'missing';
  if (opts.refresh) return 'refresh';
  if (opts.liveVersion !== undefined && opts.liveVersion !== index.version)
    return 'version';
  const built = Date.parse(index.builtAt);
  if (!Number.isFinite(built) || opts.now.getTime() - built > MAX_INDEX_AGE_MS)
    return 'age';
  return undefined;
}

export interface IndexSource {
  fetchVersion: () => Promise<string>;
  fetchMetadata: () => Promise<{ csdl: unknown; bytes: number; ms: number }>;
}

export interface LoadedIndex {
  index: ScreenIndex;
  rebuilt?: { reason: StaleReason; bytes: number; ms: number };
}

/**
 * Return the cached index, rebuilding it when missing, older than seven days,
 * built for another Priority version (when the live version is known), or on
 * refresh. Commands that know no live version stay offline while the cache is fresh.
 */
export async function loadIndex(
  dir: string,
  source: IndexSource,
  opts: { now: Date; refresh?: boolean; liveVersion?: string },
): Promise<LoadedIndex> {
  const cached = readIndex(dir);
  const reason = staleReason(cached, opts);
  if (cached && !reason) return { index: cached };
  const version = opts.liveVersion ?? (await source.fetchVersion());
  const { csdl, bytes, ms } = await source.fetchMetadata();
  const index = buildIndex(csdl, { version, builtAt: opts.now.toISOString() });
  writeJsonAtomic(join(dir, 'index.json'), index);
  return { index, rebuilt: { reason: reason ?? 'missing', bytes, ms } };
}

// ---------- what the AXI has seen per screen ----------

export type Reach = 'yes' | 'no';
export type ReachRecord = Record<string, { api: Reach; at: string }>;

export function readReach(dir: string): ReachRecord {
  const value = readJson(join(dir, 'reach.json'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: ReachRecord = {};
  for (const [screen, entry] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const e = entry as { api?: unknown; at?: unknown } | null;
    if (e && (e.api === 'yes' || e.api === 'no') && typeof e.at === 'string') {
      out[screen] = { api: e.api, at: e.at };
    }
  }
  return out;
}

/** Record the last API answer seen for a screen. Never fails the command. */
export function recordReach(
  dir: string,
  screen: string,
  api: Reach,
  now: Date,
): void {
  try {
    const reach = readReach(dir);
    if (reach[screen]?.api === api) return;
    reach[screen] = { api, at: now.toISOString() };
    writeJsonAtomic(join(dir, 'reach.json'), reach);
  } catch {
    // The record is a convenience; losing it costs nothing.
  }
}

// ---------- the company check (function calls accept any company) ----------

export interface CompanyCheck {
  code: string;
  title: string;
  checkedAt: string;
}

export function readCompany(
  dir: string,
  code: string,
  now: Date,
): CompanyCheck | undefined {
  const value = readJson(join(dir, 'company.json')) as
    | Partial<CompanyCheck>
    | undefined;
  if (
    !value ||
    value.code !== code ||
    typeof value.title !== 'string' ||
    typeof value.checkedAt !== 'string'
  ) {
    return undefined;
  }
  const at = Date.parse(value.checkedAt);
  if (!Number.isFinite(at) || now.getTime() - at > MAX_INDEX_AGE_MS)
    return undefined;
  return { code: value.code, title: value.title, checkedAt: value.checkedAt };
}

export function writeCompany(dir: string, check: CompanyCheck): void {
  try {
    writeJsonAtomic(join(dir, 'company.json'), check);
  } catch {
    // Derived; the next command checks again.
  }
}
