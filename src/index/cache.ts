// The cache is derived data. Every file is written to a temporary name and
// renamed, so a crash leaves the old file or the new one, never half of each.
// A file that cannot be read is treated as missing and rebuilt.

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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

// ---------- an advisory lock around slow builds ----------

/** A lock older than this is from a run that died; it is taken over. */
export const LOCK_STALE_MS = 5 * 60 * 1000;
/** How long to wait for another run's build before building anyway. */
export const LOCK_WAIT_MS = 90_000;
const LOCK_POLL_MS = 250;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function stale(path: string, now: number): boolean {
  try {
    const pid = Number(readFileSync(path, 'utf8').split(' ')[0]);
    if (Number.isSafeInteger(pid) && pid > 0 && !alive(pid)) return true;
    return now - statSync(path).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Run a build while holding an advisory lock file, so that concurrent cold
 * runs on one cache wait for one download instead of each pulling the same
 * metadata or catalog. `ready` is checked after waiting: when another run
 * built it meanwhile, its result is used. The lock is only a courtesy: when it
 * cannot be taken within `waitMs`, or the cache cannot be written, the build
 * runs anyway.
 */
export async function withBuildLock<T>(
  path: string,
  ready: () => T | undefined,
  build: () => Promise<T>,
  waitMs: number = LOCK_WAIT_MS,
): Promise<T> {
  const until = Date.now() + Math.max(0, waitMs);
  let held = false;
  let waited = false;
  for (;;) {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, `${process.pid} ${new Date().toISOString()}`);
      closeSync(fd);
      held = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') break;
      if (stale(path, Date.now())) {
        rmSync(path, { force: true });
        continue;
      }
      if (Date.now() >= until) break;
      waited = true;
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
  try {
    if (waited || held) {
      const done = ready();
      if (done !== undefined) return done;
    }
    return await build();
  } finally {
    if (held) rmSync(path, { force: true });
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
  opts: {
    now: Date;
    refresh?: boolean;
    liveVersion?: string;
    lockWaitMs?: number;
  },
): Promise<LoadedIndex> {
  const cached = readIndex(dir);
  const reason = staleReason(cached, opts);
  if (cached && !reason) return { index: cached };
  return withBuildLock(
    join(dir, 'index.lock'),
    () => {
      // Another run built it while this one waited. A refresh still rebuilds.
      const built = readIndex(dir);
      if (
        !built ||
        opts.refresh ||
        built.builtAt === cached?.builtAt ||
        staleReason(built, { ...opts, refresh: false })
      )
        return undefined;
      return { index: built };
    },
    async () => {
      const version = opts.liveVersion ?? (await source.fetchVersion());
      const { csdl, bytes, ms } = await source.fetchMetadata();
      const index = buildIndex(csdl, {
        version,
        builtAt: opts.now.toISOString(),
      });
      writeJsonAtomic(join(dir, 'index.json'), index);
      return { index, rebuilt: { reason: reason ?? 'missing', bytes, ms } };
    },
    opts.lockWaitMs,
  );
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
