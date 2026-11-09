// T15: the ten AXI principles (axi.md; Comis D240, D380), checked against the
// real binary as a separate process, the way Comis checks its own AXI fixture.
// Set PRIORITY_AXI_BIN=dist to check the built package instead of the source.

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
const run = (...args: string[]) => runBinary(args, env());

before(async () => {
  fake = await startFake();
  await run('refresh');
});
after(() => fake.close());

/** The encoded TOON body, without the AXI help footer. */
function body(text: string): Record<string, unknown> {
  const [encoded = ''] = text.split(/^help\[\d+\]:\n/m);
  return decode(encoded) as Record<string, unknown>;
}

function helpLines(text: string): string[] {
  const m = /^help\[(\d+)\]:\n((?: {2}.*\n)*)$/m.exec(text);
  if (!m) return [];
  const lines = (m[2] ?? '').split('\n').filter(Boolean);
  assert.equal(lines.length, Number(m[1]), 'help[n] counts its lines');
  return lines;
}

const LISTS: string[][] = [
  ['screens', 'order'],
  ['screens'],
  ['get', 'ORDERS'],
  ['get', 'CUSTOMERS', '--limit', '30'],
  ['changes', 'ORDERS', '--since', '30d'],
  ['find', 'CUSTOMERS', 'לקוח'],
  ['fields', 'ORDERS'],
];
const DETAILS: string[][] = [
  ['show', 'ORDERS', 'SO26000101'],
  ['show', 'CUSTOMERS', 'C1002'],
];

describe('AXI principles', () => {
  it('1. output is TOON from the official encoder, on stdout only', async () => {
    for (const args of [[], ...LISTS, ...DETAILS]) {
      const r = await run(...args);
      assert.equal(r.code, 0, `${args.join(' ')}: ${r.stdout}`);
      assert.equal(r.stderr, '', args.join(' '));
      assert.doesNotThrow(() => body(r.stdout), args.join(' '));
    }
  });

  it('2. list rows carry three or four fields by default', async () => {
    for (const args of [
      ['screens', 'order'],
      ['get', 'ORDERS'],
      ['get', 'CUSTOMERS'],
    ]) {
      const r = await run(...args);
      const doc = body(r.stdout);
      const rows = (doc.screens ?? doc.records) as Record<string, unknown>[];
      assert.ok(rows.length > 0, args.join(' '));
      for (const row of rows) {
        const n = Object.keys(row).length;
        assert.ok(n >= 3 && n <= 4, `${args.join(' ')}: ${n} fields`);
      }
    }
  });

  it('3. long text is cut with its size and a --full hint', async () => {
    const r = await run('show', 'CUSTOMERS', 'C1002');
    assert.match(
      r.stdout,
      / … \(truncated, \d+ code points total; use --full to see all\)/,
    );
    const full = await run('show', 'CUSTOMERS', 'C1002', '--full');
    assert.doesNotMatch(full.stdout, /truncated/);
  });

  it('4. every list states its count in summary, and partial answers say so', async () => {
    for (const args of LISTS) {
      if (args[0] === 'fields') continue;
      const doc = body((await run(...args)).stdout);
      assert.match(
        String(doc.summary),
        /^(0|[1-9][0-9]*) [a-z]/,
        args.join(' '),
      );
    }
    const partial = body((await run('get', 'ORDERS', '--limit', '2')).stdout);
    assert.match(String(partial.summary), /more exist$/);
  });

  it('5. an empty answer is stated, not blank', async () => {
    const r = await run('get', 'ORDERS', '--where', 'CUSTNAME=NOBODY');
    assert.equal(r.code, 0);
    assert.equal(body(r.stdout).summary, '0 records from ORDERS');
    const s = await run('screens', 'qqqq');
    assert.equal(body(s.stdout).summary, '0 screens match qqqq');
  });

  it('6. errors are structured records on stdout: message, code, usage', async () => {
    for (const args of [
      ['get', 'LOGPART'],
      ['get', 'NOSCREEN'],
      ['get'],
      ['get', 'ORDERS', '--bogus'],
    ]) {
      const r = await run(...args);
      assert.equal(r.stderr, '', args.join(' '));
      const doc = body(r.stdout);
      assert.deepEqual(
        Object.keys(doc).slice(0, 3),
        ['message', 'code', 'usage'],
        args.join(' '),
      );
      assert.match(String(doc.code), /^[a-z][a-z_]*$/);
      assert.doesNotMatch(r.stdout, /\n\s+at\s|ECONN|secret-pass/);
    }
  });

  it('7. exit codes are 0, 1 and 2', async () => {
    assert.equal((await run('get', 'ORDERS')).code, 0);
    assert.equal((await run('get', 'LOGPART')).code, 1);
    assert.equal((await run('get', 'ORDERS', '--limit', 'x')).code, 2);
    assert.equal((await run('frobnicate')).code, 2);
  });

  it('8. the home view shows live data with no arguments', async () => {
    const doc = body((await run()).stdout);
    assert.equal(doc.version, '23.1');
    assert.equal(doc.company, 'חברת בדיקות 15/01/25');
  });

  it('9. lists end with one to three runnable next steps; detail views with none', async () => {
    for (const args of [[], ...LISTS]) {
      const lines = helpLines((await run(...args)).stdout);
      assert.ok(
        lines.length >= 1 && lines.length <= 3,
        `${args.join(' ')}: ${lines.length}`,
      );
      for (const line of lines)
        assert.match(line, /^ {2}Run `priority-axi [a-z<][^`]*`/, line);
    }
    for (const args of DETAILS) {
      assert.deepEqual(
        helpLines((await run(...args)).stdout),
        [],
        args.join(' '),
      );
    }
  });

  it('10. every command has a short --help from the one command table', async () => {
    for (const spec of COMMANDS) {
      const r = await runBinary([...(spec.name ? [spec.name] : []), '--help'], {
        PRIORITY_URL: '',
      });
      assert.equal(r.code, 0, spec.name);
      assert.ok(r.stdout.length < 2000, `${spec.name}: ${r.stdout.length}`);
      assert.match(r.stdout, /^(command|description): /);
    }
  });

  it('refuses unknown flags by name and never echoes their values', async () => {
    const r = await run('get', 'ORDERS', '--password=hunter2');
    assert.equal(r.code, 2);
    assert.match(r.stdout, /Unknown flag --password/);
    assert.doesNotMatch(r.stdout, /hunter2/);
  });

  it('fits default output in 4,000 UTF-16 units', async () => {
    for (const args of [
      [],
      ...LISTS,
      ...DETAILS,
      ['get', 'CUSTOMERS', '--limit', '500'],
    ]) {
      const r = await run(...args);
      assert.ok(
        r.stdout.length <= 4000,
        `${args.join(' ')}: ${r.stdout.length}`,
      );
    }
  });

  it('never prompts: commands finish with stdin closed', async () => {
    const r = await run(
      'create',
      'CURRENCIES',
      '--set',
      'CODE=XYZ',
      '--dry-run',
    );
    assert.equal(r.code, 0, r.stdout);
  });
});
