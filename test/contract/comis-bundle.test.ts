// The Comis connector bundle (comis/) fits the AXI it ships with:
// - every route the AXI actually uses is in the Gate credential's match list,
//   reads stay reads, and every create is asked of the owner;
// - updates, deletes, $batch and writes to sensitive screens are refused;
// - the skills name only real commands, and the wrapper runs the built bin.
// The Gate matcher below follows Comis policy.py's rules as the design records
// them (§9): paths only, {name} matches [A-Za-z0-9._~-]+, {A|B} one literal.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { COMMANDS, main } from '../../src/cli/run.ts';
import { defaultDeps } from '../../src/http.ts';
import { startFake } from '../fake/priority-fake.ts';
import { tempDir } from '../helpers.ts';

interface Entry {
  credential: { secret: string; inject: string; match: string[] };
  writes: Array<{ match: string; decide: string }>;
  secret_responses: string[];
  variable: string;
  url_variable: string;
}

const read = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const entry = JSON.parse(read('comis/key-services/priority.json')) as Entry;
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

function segment(pattern: string, value: string): boolean {
  const m = /^\{([^}]*)\}$/.exec(pattern);
  if (!m) return pattern === value;
  const inner = m[1] ?? '';
  return inner.includes('|')
    ? inner.split('|').includes(value)
    : /^[A-Za-z0-9._~-]+$/.test(value);
}

function matches(rule: string, method: string, path: string): boolean {
  const [m = '', p = ''] = rule.split(' ');
  if (m !== '*' && m !== method) return false;
  if (p === '*') return true;
  const ps = p.split('/');
  const vs = path.split('/');
  return (
    ps.length === vs.length && ps.every((seg, i) => segment(seg, vs[i] ?? ''))
  );
}

function decide(method: string, path: string): 'read' | string {
  if (READS.has(method)) return 'read';
  return (
    entry.writes.find((w) => matches(w.match, method, path))?.decide ?? 'deny'
  );
}

const credentialed = (method: string, path: string) =>
  entry.credential.match.some((r) => matches(r, method, path));

let fake: Awaited<ReturnType<typeof startFake>>;
before(async () => {
  fake = await startFake();
});
after(() => fake.close());

describe('Gate entry against the routes priority-axi really uses', () => {
  it('covers every request of every command, and asks the owner for each create', async () => {
    const cache = tempDir();
    const run = (args: string[]) =>
      main(args, {
        stdout: () => {},
        env: {
          PRIORITY_URL: fake.root,
          PRIORITY_USER: 'API',
          PRIORITY_PASSWORD: 'secret-pass',
          XDG_CACHE_HOME: cache,
        },
        now: () => new Date(),
        http: defaultDeps,
      });
    for (const args of [
      [],
      ['refresh'],
      ['screens', 'order'],
      ['fields', 'ORDERS'],
      ['get', 'ORDERS', '--with', 'ORDERITEMS', '--where', 'CUSTNAME=C1001'],
      ['show', 'ORDERS', 'SO26000101', '--with', 'SHIPTO2'],
      ['changes', 'ORDERS', '--since', '30d'],
      ['find', 'CUSTOMERS', 'לקוח'],
      ['find', 'CUSTOMERS', '--sub', 'CUSTPROJECTS', 'אלפא'],
      ['find', 'DOCUMENTS_p', 'אלפא'],
      ['get', 'LOGPART'],
      [
        'create',
        'ORDERS',
        '--set',
        'CUSTNAME=C1002',
        '--line',
        'ORDERITEMS',
        'PARTNAME=P-1',
        'TQUANT=1',
      ],
    ]) {
      await run(args);
    }
    const seen = new Map(
      fake.state.requests.map((r) => [`${r.method} ${r.path}`, r]),
    );
    assert.ok(seen.size >= 6, [...seen.keys()].join('\n'));
    for (const { method, path } of seen.values()) {
      assert.ok(
        credentialed(method, path),
        `not in credential.match: ${method} ${path}`,
      );
      assert.equal(
        decide(method, path),
        method === 'POST' ? 'ask' : 'read',
        `${method} ${path}`,
      );
      assert.doesNotMatch(path, /%/, 'no percent-encoded path');
    }
    assert.ok(
      [...seen.keys()].some((k) => k.startsWith('POST ')),
      'the create reached the fake',
    );
  });

  it('refuses updates, deletes, $batch and writes to sensitive screens', () => {
    const root = '/odata/Priority/tabula.ini/a150125';
    for (const [method, path] of [
      ['DELETE', `${root}/ORDERS`],
      ['PATCH', `${root}/ORDERS`],
      ['PUT', `${root}/ORDERS`],
      ['POST', `${root}/$batch`],
      ['POST', `${root}/USERS`],
      ['POST', `${root}/PATOKENS`],
      ['POST', `${root}/SYSCONST`],
      ['PATCH', `${root}/ORDERS('SO1')`],
      ['POST', `${root}/ClearEntityMetadata`],
    ]) {
      assert.equal(
        decide(method ?? '', path ?? ''),
        method === 'POST' && path?.endsWith('ClearEntityMetadata')
          ? 'ask'
          : 'deny',
        `${method} ${path}`,
      );
    }
  });

  it('never sends the password outside the Priority REST routes', () => {
    for (const [method, path] of [
      ['GET', '/webui/login'],
      ['GET', '/mcp/erp/a150125'],
      ['GET', '/odata/Priority/tabula.ini,3/a150125/ORDERS'],
      ['GET', '/odata/Priority/tabula.ini/a150125/ORDERS/extra'],
      ['GET', "/odata/Priority/tabula.ini/a150125/ORDERS('SO1')"],
      ['DELETE', '/odata/Priority/tabula.ini/a150125/ORDERS'],
    ]) {
      assert.equal(
        credentialed(method ?? '', path ?? ''),
        false,
        `${method} ${path}`,
      );
    }
  });

  it('withholds answers from credential-bearing screens', () => {
    for (const screen of ['PATOKENS', 'OAUTH2CONFIG', 'MAILSERVERS']) {
      assert.ok(
        entry.secret_responses.some((r) =>
          matches(r, 'GET', `/odata/Priority/tabula.ini/demo/${screen}`),
        ),
      );
    }
  });

  it('keeps the manual C5a template generated from the entry', () => {
    execFileSync(process.execPath, ['scripts/comis-template.mjs', '--check'], {
      cwd: new URL('../..', import.meta.url).pathname,
    });
    assert.equal(entry.variable, 'PRIORITY_PASSWORD');
    assert.equal(entry.url_variable, 'PRIORITY_URL');
    assert.equal(entry.credential.inject, 'basic');
  });
});

describe('skills and wrapper', () => {
  const commands = new Set(COMMANDS.map((c) => c.name).filter(Boolean));

  for (const [name, roles] of [
    ['priority', 'main reader'],
    ['priority-write', 'main'],
  ] as const) {
    it(`${name}: flat string metadata and real commands only`, () => {
      const text = read(`comis/skills/${name}/SKILL.md`);
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
      assert.match(front, new RegExp(`^name: ${name}$`, 'm'));
      assert.match(front, new RegExp(`^ {2}comis\\.roles: "${roles}"$`, 'm'));
      assert.match(front, /^ {2}comis\.pack: "apps"$/m);
      assert.match(front, /^ {2}comis\.requires\.bins: "priority-axi"$/m);
      assert.match(
        front,
        /^ {2}comis\.requires\.env: "PRIORITY_URL PRIORITY_PASSWORD"$/m,
      );
      assert.match(front, /^ {2}comis\.requires\.services: "priority"$/m);
      for (const line of front
        .split('\n')
        .filter((l) => l.startsWith('  comis.'))) {
        assert.match(line, /: "[^"]*"$/, `metadata must be a string: ${line}`);
      }
      for (const m of text.matchAll(/`priority-axi ([a-z][a-z-]*)/g)) {
        assert.ok(
          commands.has(m[1] ?? ''),
          `unknown command in ${name}: ${m[1]}`,
        );
      }
    });
  }

  it('the reader skill never mentions create', () => {
    assert.doesNotMatch(
      read('comis/skills/priority/SKILL.md'),
      /priority-axi create/,
    );
  });

  it('the wrapper turns on the proxy and runs the built bin', () => {
    const wrapper = read('comis/bin/priority-axi');
    const pkg = JSON.parse(read('package.json')) as {
      bin: Record<string, string>;
    };
    assert.match(wrapper, /^#!\/bin\/sh\nset -eu\n/);
    assert.match(wrapper, /^export NODE_USE_ENV_PROXY=1$/m);
    assert.ok(
      wrapper.includes(`node_modules/priority-axi/${pkg.bin['priority-axi']}`),
    );
  });
});
