// The real binary, as a separate process, against the fake Priority.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startFake } from '../fake/priority-fake.ts';
import { runBinary, tempDir } from '../helpers.ts';

let fake: Awaited<ReturnType<typeof startFake>>;
before(async () => {
  fake = await startFake();
});
after(() => fake.close());

describe('priority-axi binary', () => {
  const cache = tempDir();
  const env = () => ({
    PRIORITY_URL: fake.root,
    PRIORITY_USER: 'API',
    PRIORITY_PASSWORD: 'secret-pass',
    XDG_CACHE_HOME: cache,
  });

  it('shows the home view, refreshes, then shows the built index', async () => {
    const first = await runBinary([], env());
    assert.equal(first.code, 0, first.stdout);
    assert.match(first.stdout, /version: "23\.1"/);
    assert.match(first.stdout, /company: חברת בדיקות/);
    assert.equal(first.stderr, '');

    const refresh = await runBinary(['refresh'], env());
    assert.equal(refresh.code, 0, refresh.stdout);
    assert.match(refresh.stdout, /screens: 8/);

    const again = await runBinary([], env());
    assert.match(again.stdout, /index: "8 screens, built \d{4}-\d{2}-\d{2}"/);
  });

  it('reads records end to end', async () => {
    const got = await runBinary(['get', 'ORDERS', '--limit', '2'], env());
    assert.equal(got.code, 0, got.stdout);
    assert.match(got.stdout, /^summary: "2 records from ORDERS, more exist"\n/);
  });

  it('prints errors on stdout with exit 1, and usage errors with exit 2', async () => {
    const auth = await runBinary([], { ...env(), PRIORITY_PASSWORD: 'wrong' });
    assert.equal(auth.code, 1);
    assert.match(auth.stdout, /code: auth_failed/);
    assert.equal(auth.stderr, '');

    const company = await runBinary(['--company', 'nosuch'], env());
    assert.equal(company.code, 1);
    assert.match(company.stdout, /code: company_not_found/);

    const usage = await runBinary(['bogus'], env());
    assert.equal(usage.code, 2);
    assert.match(usage.stdout, /code: usage/);
  });

  it('answers --version without settings or network', async () => {
    const v = await runBinary(['--version'], { PRIORITY_URL: '' });
    assert.equal(v.code, 0);
    assert.match(v.stdout, /^\d+\.\d+\.\d+\n$/);
  });
});
