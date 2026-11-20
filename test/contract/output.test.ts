// Whole stdout must be one document, including next-step hints. No real account.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { decode } from '@toon-format/toon';
import { COMMANDS } from '../../src/cli/run.ts';
import { startFake } from '../fake/priority-fake.ts';
import { runBinary, tempDir } from '../helpers.ts';

let fake: Awaited<ReturnType<typeof startFake>>;
const cache = tempDir();
const env = () => ({
  PRIORITY_URL: fake.root,
  PRIORITY_USER: 'API',
  PRIORITY_PASSWORD: 'secret-pass',
  XDG_CACHE_HOME: cache,
});
before(async () => {
  fake = await startFake();
});
after(() => fake.close());

// Every command, including all four write previews, uses only the fake server.
const cases: string[][] = [
  [],
  ['screens'],
  ['fields', 'ORDERS'],
  ['get', 'ORDERS'],
  ['show', 'ORDERS', 'SO26000101'],
  ['changes', 'ORDERS', '--since', '30d'],
  ['find', 'CUSTOMERS', 'לקוח'],
  ['create', 'CURRENCIES', '--set', 'CODE=XYZ', '--dry-run'],
  [
    'update',
    'ORDERS',
    'SO26000101',
    '--set',
    'ORDSTATUSDES=מבוטלת',
    '--dry-run',
  ],
  [
    'add-line',
    'ORDERS',
    'SO26000101',
    'ORDERITEMS',
    'PARTNAME=P-100',
    '--dry-run',
  ],
  [
    'update-line',
    'ORDERS',
    'SO26000101',
    'ORDERITEMS',
    '1',
    '--set',
    'TQUANT=2',
    '--dry-run',
  ],
  ['refresh'],
  ['help'],
  ['help', 'update'],
  ['--help'],
];

describe('whole stdout format contract', () => {
  for (const args of cases) {
    it(`decodes ${args.join(' ') || 'home'} including its hints`, async () => {
      const result = await runBinary(args, env());
      assert.equal(result.code, 0, result.stdout);
      assert.equal(result.stderr, '');
      const doc = decode(result.stdout) as Record<string, unknown>;
      if (doc.help !== undefined) {
        assert.ok(Array.isArray(doc.help));
        for (const hint of doc.help)
          assert.match(hint, /^Run `priority-axi[ `]/);
      }
    });
    it(`prints only JSON for ${args.join(' ') || 'home'}`, async () => {
      const result = await runBinary([...args, '--json'], env());
      assert.equal(result.code, 0, result.stdout);
      assert.equal(result.stderr, '');
      const doc = JSON.parse(result.stdout);
      assert.equal(typeof doc, 'object');
      if (args.includes('--dry-run')) assert.equal(doc.dry_run, true);
      assert.ok(result.stdout.length <= 4000);
    });
  }

  it('documents JSON for every command and supports help without a connection', async () => {
    for (const spec of COMMANDS) {
      const result = await runBinary(
        [...(spec.name ? [spec.name] : []), '--help', '--json'],
        {},
      );
      assert.equal(result.code, 0, result.stdout);
      const doc = JSON.parse(result.stdout);
      assert.ok(
        doc.flags.some((flag: { flag: string }) => flag.flag === '--json'),
      );
    }
  });

  it('prints JSON version, runtime errors and usage errors with their exit codes', async () => {
    const version = await runBinary(['--json', '--version'], {});
    assert.equal(version.code, 0, version.stdout);
    assert.match(JSON.parse(version.stdout).version, /^\d+\.\d+\.\d+$/);
    for (const [args, code, error] of [
      [[], 1, 'not_connected'],
      [['get'], 2, 'usage'],
      [['bogus'], 2, 'usage'],
      [['get', 'ORDERS', '--bogus'], 2, 'usage'],
      [['--json'], 2, 'usage'],
      [['--json=true'], 2, 'usage'],
    ] as const) {
      const result = await runBinary([...args, '--json'], {});
      assert.equal(result.code, code, result.stdout);
      assert.equal(JSON.parse(result.stdout).code, error);
      assert.equal(result.stderr, '');
    }
  });

  it('keeps --json as data after -- or when consumed by a string flag', async () => {
    for (const args of [
      ['get', 'ORDERS', '--', '--json'],
      ['get', 'ORDERS', '--fields', '--json'],
    ]) {
      const result = await runBinary(args, env());
      assert.notEqual(result.code, 0);
      assert.equal(
        (decode(result.stdout) as Record<string, unknown>).code,
        'usage',
      );
    }
  });

  it('accepts --json before a command and measures JSON output bounds', async () => {
    const result = await runBinary(
      ['--json', 'get', 'CUSTOMERS', '--limit', '500'],
      env(),
    );
    assert.equal(result.code, 0, result.stdout);
    assert.ok(result.stdout.length <= 4000);
    assert.ok(JSON.parse(result.stdout).records.length > 0);
    const detail = await runBinary(
      ['show', 'CUSTOMERS', 'C1002', '--full', '--json'],
      env(),
    );
    assert.equal(detail.code, 0, detail.stdout);
    assert.doesNotMatch(detail.stdout, /truncated/);
    assert.doesNotThrow(() => JSON.parse(detail.stdout));
  });

  it('never sends a write for previews', () => {
    assert.equal(
      fake.state.requests.filter((request) => request.method !== 'GET').length,
      0,
    );
  });
});
