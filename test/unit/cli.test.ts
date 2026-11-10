import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseCommand } from '../../src/cli/parse.ts';
import { main } from '../../src/cli/run.ts';
import { type CommandSpec, usageLine } from '../../src/cli/table.ts';
import { AxiError } from '../../src/errors.ts';
import { cacheDir } from '../../src/index/cache.ts';
import { OUTPUT_LIMIT } from '../../src/output/toon.ts';
import { VERSION } from '../../src/version.ts';
import { json, makeIo, PASSWORD, standardRoutes } from '../helpers.ts';

const spec: CommandSpec = {
  name: 'get',
  args: [{ name: '<SCREEN>', required: true }],
  flags: {
    where: {
      type: 'string',
      multiple: true,
      value: '<F=V>',
      summary: 'filter',
    },
    limit: { type: 'string', value: '<n>', summary: 'rows' },
    full: { type: 'boolean', summary: 'all' },
  },
  summary: 'test',
  run: async () => '',
};

const usageError = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof AxiError);
    assert.equal(error.code, 'usage');
    return error.message;
  }
  assert.fail('expected a usage error');
};

describe('parseCommand', () => {
  it('parses flags, repeated flags and arguments', () => {
    const parsed = parseCommand(spec, [
      'ORDERS',
      '--where',
      'A=1',
      '--where=B=2',
      '--limit',
      '5',
      '--full',
    ]);
    assert.deepEqual(parsed.positionals, ['ORDERS']);
    assert.deepEqual(parsed.values.where, ['A=1', 'B=2']);
    assert.equal(parsed.values.limit, '5');
    assert.equal(parsed.values.full, true);
  });

  it('refuses an unknown flag by name, never by value', () => {
    const message = usageError(() =>
      parseCommand(spec, ['ORDERS', '--token=secret-123']),
    );
    assert.match(message, /Unknown flag --token/);
    assert.match(message, /Valid flags: --where, --limit, --full/);
    assert.ok(!message.includes('secret-123'));
  });

  it('refuses repeats, values on boolean flags and missing values', () => {
    assert.match(
      usageError(() =>
        parseCommand(spec, ['O', '--limit', '1', '--limit', '2']),
      ),
      /more than once/,
    );
    assert.match(
      usageError(() => parseCommand(spec, ['O', '--full=yes'])),
      /takes no value/,
    );
    assert.match(
      usageError(() => parseCommand(spec, ['O', '--limit'])),
      /needs a value/,
    );
  });

  it('refuses missing and extra arguments', () => {
    assert.match(
      usageError(() => parseCommand(spec, [])),
      /Missing <SCREEN>/,
    );
    assert.match(
      usageError(() => parseCommand(spec, ['A', 'B'])),
      /extra argument/,
    );
  });

  it('shows a required flag bare and leaves a hidden argument out of usage', () => {
    const line = usageLine({
      ...spec,
      args: [
        { name: '<SCREEN>', required: true },
        { name: '<F=V>', required: false, variadic: true, hidden: true },
      ],
      flags: {
        since: { type: 'string', required: true, value: '<t>', summary: 's' },
        line: {
          type: 'string',
          multiple: true,
          value: '<SUB> <F=V>...',
          summary: 'l',
        },
      },
    });
    assert.equal(
      line,
      'priority-axi get <SCREEN> --since <t> [--line <SUB> <F=V>...]...',
    );
  });

  it('treats everything after -- as arguments', () => {
    assert.deepEqual(parseCommand(spec, ['--', '--full']).positionals, [
      '--full',
    ]);
  });
});

describe('main', () => {
  it('prints the version and the help', async () => {
    const v = makeIo();
    assert.equal(await main(['--version'], v.io), 0);
    assert.equal(v.output(), `${VERSION}\n`);
    const h = makeIo();
    assert.equal(await main(['--help'], h.io), 0);
    assert.match(h.output(), /commands\[13\]\{command,summary\}:/);
    assert.match(
      h.output(),
      /help\[1\]:\n {2}Run `priority-axi help <command>` for its flags\n$/,
    );
    assert.equal(h.calls.length, 0, 'help never calls Priority');
  });

  it('prints one command help with --help or help <command>', async () => {
    const a = makeIo();
    assert.equal(await main(['refresh', '--help'], a.io), 0);
    const b = makeIo();
    assert.equal(await main(['help', 'refresh'], b.io), 0);
    assert.equal(a.output(), b.output());
    assert.match(a.output(), /^command: priority-axi refresh\n/);
    assert.match(
      a.output(),
      /usage: "priority-axi refresh \[--company <code>\]/,
    );
  });

  it('refuses an unknown command with exit 2 and lists the commands', async () => {
    const r = makeIo();
    assert.equal(await main(['bogus'], r.io), 2);
    assert.match(
      r.output(),
      /^message: "Unknown command `bogus`\. Commands: screens, fields, get, show, changes, find, create, update, add-line, update-line, refresh, help\."\ncode: usage\nusage: /,
    );
  });

  it('has no update command', async () => {
    const r = makeIo();
    assert.equal(await main(['update'], r.io), 2);
    assert.equal(r.calls.length, 0);
  });

  it('reports not_connected on stdout with exit 1', async () => {
    const r = makeIo(standardRoutes(), { PRIORITY_URL: undefined });
    assert.equal(await main([], r.io), 1);
    assert.match(r.output(), /code: not_connected/);
    assert.equal(r.calls.length, 0);
  });

  it('shows the home view with live version and company', async () => {
    const r = makeIo();
    assert.equal(await main([], r.io), 0);
    const out = r.output();
    assert.match(
      out,
      /^priority: "https:\/\/erp\.example\.com · tabula\.ini · company demo"\n/,
    );
    assert.match(out, /\ncompany: Demo Ltd\n/);
    assert.match(out, /\nversion: "23\.1"\n/);
    assert.match(out, /\nlogin: user_a\n/);
    assert.match(out, /index: not built yet/);
    assert.match(out, /screens_read: none yet/);
    assert.match(
      out,
      /help\[2\]:\n {2}Run `priority-axi screens <text>` to find a screen\n {2}Run `priority-axi get <SCREEN> --limit 5` to read records\n$/,
    );
    assert.ok(out.length <= OUTPUT_LIMIT);
    assert.ok(!out.includes(PASSWORD));
    assert.deepEqual(
      r.calls.map((c) => c.path),
      ['GetPriorityVersion()', 'GETCOMPANIES'],
      'the home view never downloads the metadata',
    );
  });

  it('accepts connection flags before any command', async () => {
    const r = makeIo(standardRoutes(), {
      PRIORITY_URL: 'https://erp.example.com',
    });
    assert.equal(await main(['--company', 'demo'], r.io), 0);
    assert.match(r.output(), /company demo/);
  });

  it('refreshes the index, and the home view then reports it', async () => {
    const r = makeIo();
    assert.equal(await main(['refresh'], r.io), 0);
    assert.match(
      r.output(),
      /^index: rebuilt\nversion: "23\.1"\nscreens: 8\ntypes: 12\nfields: \d+\nmetadata: [\d.]+ MB in [\d.]+ s\n/,
    );
    const dir = cacheDir(
      {
        origin: 'https://erp.example.com',
        ini: 'tabula.ini',
        company: 'demo',
        user: 'user_a',
        password: PASSWORD,
      },
      r.io.env,
    );
    assert.ok(existsSync(join(dir, 'index.json')));
    assert.ok(
      !readFileSync(join(dir, 'index.json'), 'utf8').includes(PASSWORD),
    );
    const home = makeIo(standardRoutes(), {
      XDG_CACHE_HOME: r.io.env.XDG_CACHE_HOME,
    });
    assert.equal(await main([], home.io), 0);
    assert.match(home.output(), /index: "8 screens, built 2026-11-05"/);
    assert.doesNotMatch(home.output(), /priority-axi refresh/);
  });

  it('reports a company Priority does not list', async () => {
    const routes = {
      ...standardRoutes(),
      GETCOMPANIES: () =>
        json(200, { value: [{ NAME: 'other', TITLE: 'Other' }] }),
    };
    const r = makeIo(routes);
    assert.equal(await main([], r.io), 1);
    assert.match(r.output(), /code: company_not_found/);
    assert.match(r.output(), /Companies: other/);
  });

  it('reports a rejected login', async () => {
    const r = makeIo({
      'GetPriorityVersion()': () =>
        new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': 'Basic' },
        }),
    });
    assert.equal(await main([], r.io), 1);
    assert.match(r.output(), /code: auth_failed/);
  });

  it('turns an unexpected failure into internal_error without a stack trace', async () => {
    const r = makeIo();
    r.io.http.fetch = (async () => ({
      arrayBuffer: async () => new ArrayBuffer(0),
      get status(): number {
        throw new TypeError('not a response');
      },
    })) as unknown as typeof fetch;
    assert.equal(await main([], r.io), 1);
    assert.match(r.output(), /code: internal_error/);
    assert.ok(!/\n\s+at\s/.test(r.output()));
  });
});
