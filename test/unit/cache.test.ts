import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Settings } from '../../src/config.ts';
import {
  cacheDir,
  loadIndex,
  MAX_INDEX_AGE_MS,
  readCompany,
  readIndex,
  readJson,
  readReach,
  recordReach,
  staleReason,
  writeCompany,
  writeJsonAtomic,
} from '../../src/index/cache.ts';
import { FIXTURE, NOW, tempDir } from '../helpers.ts';

const settings: Settings = {
  origin: 'https://erp.example.com',
  ini: 'tabula.ini',
  company: 'demo',
  user: 'u',
  password: 'p',
};

function source(version = '23.1') {
  const calls = { version: 0, metadata: 0 };
  return {
    calls,
    source: {
      fetchVersion: async () => {
        calls.version++;
        return version;
      },
      fetchMetadata: async () => {
        calls.metadata++;
        return { csdl: FIXTURE, bytes: 1000, ms: 5 };
      },
    },
  };
}

describe('cacheDir', () => {
  it('lives under XDG_CACHE_HOME and differs per company', () => {
    const a = cacheDir(settings, { XDG_CACHE_HOME: '/c' });
    assert.match(a, /^\/c\/priority-axi\/[0-9a-f]{32}$/);
    assert.equal(a, cacheDir(settings, { XDG_CACHE_HOME: '/c' }));
    assert.notEqual(
      a,
      cacheDir({ ...settings, company: 'other' }, { XDG_CACHE_HOME: '/c' }),
    );
  });
});

describe('atomic files', () => {
  it('writes, reads back and leaves no temporary file', () => {
    const dir = tempDir();
    writeJsonAtomic(join(dir, 'sub', 'x.json'), { a: 1 });
    assert.deepEqual(readJson(join(dir, 'sub', 'x.json')), { a: 1 });
    assert.deepEqual(readdirSync(join(dir, 'sub')), ['x.json']);
  });

  it('treats a damaged or missing file as missing', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'index.json'), '{"format":1,');
    assert.equal(readIndex(dir), undefined);
    assert.equal(readJson(join(dir, 'none.json')), undefined);
  });
});

describe('staleReason', () => {
  const fresh = {
    format: 1 as const,
    version: '23.1',
    builtAt: NOW.toISOString(),
    sets: {},
    types: {},
  };
  it('names why an index must be rebuilt', () => {
    assert.equal(staleReason(undefined, { now: NOW }), 'missing');
    assert.equal(staleReason(fresh, { now: NOW, refresh: true }), 'refresh');
    assert.equal(
      staleReason(fresh, { now: NOW, liveVersion: '24.0' }),
      'version',
    );
    const later = new Date(NOW.getTime() + MAX_INDEX_AGE_MS + 1);
    assert.equal(staleReason(fresh, { now: later }), 'age');
    assert.equal(
      staleReason(fresh, { now: NOW, liveVersion: '23.1' }),
      undefined,
    );
    assert.equal(staleReason(fresh, { now: NOW }), undefined);
  });
});

describe('loadIndex', () => {
  it('builds once, then stays offline while fresh', async () => {
    const dir = tempDir();
    const s = source();
    const first = await loadIndex(dir, s.source, { now: NOW });
    assert.equal(first.rebuilt?.reason, 'missing');
    assert.deepEqual(s.calls, { version: 1, metadata: 1 });
    const second = await loadIndex(dir, s.source, { now: NOW });
    assert.equal(second.rebuilt, undefined);
    assert.deepEqual(s.calls, { version: 1, metadata: 1 });
    assert.equal(Object.keys(second.index.sets).length, 8);
  });

  it('rebuilds for a new Priority version without asking for the version again', async () => {
    const dir = tempDir();
    await loadIndex(dir, source().source, { now: NOW });
    const s = source('24.0');
    const again = await loadIndex(dir, s.source, {
      now: NOW,
      liveVersion: '24.0',
    });
    assert.equal(again.rebuilt?.reason, 'version');
    assert.equal(again.index.version, '24.0');
    assert.deepEqual(s.calls, { version: 0, metadata: 1 });
  });

  it('rebuilds after seven days', async () => {
    const dir = tempDir();
    await loadIndex(dir, source().source, { now: NOW });
    const later = new Date(NOW.getTime() + MAX_INDEX_AGE_MS + 1);
    assert.equal(
      (await loadIndex(dir, source().source, { now: later })).rebuilt?.reason,
      'age',
    );
  });
});

describe('reach and company records', () => {
  it('records the last API answer per screen', () => {
    const dir = tempDir();
    recordReach(dir, 'ORDERS', 'no', NOW);
    recordReach(dir, 'CUSTOMERS', 'yes', NOW);
    recordReach(dir, 'ORDERS', 'yes', NOW);
    assert.deepEqual(readReach(dir), {
      ORDERS: { api: 'yes', at: NOW.toISOString() },
      CUSTOMERS: { api: 'yes', at: NOW.toISOString() },
    });
  });

  it('keeps a company check for seven days and only for that company', () => {
    const dir = tempDir();
    writeCompany(dir, {
      code: 'demo',
      title: 'Demo Ltd',
      checkedAt: NOW.toISOString(),
    });
    assert.equal(readCompany(dir, 'demo', NOW)?.title, 'Demo Ltd');
    assert.equal(readCompany(dir, 'other', NOW), undefined);
    assert.equal(
      readCompany(dir, 'demo', new Date(NOW.getTime() + MAX_INDEX_AGE_MS + 1)),
      undefined,
    );
  });
});
