// Every command, in process, against the fake Priority over real HTTP.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { main } from '../../src/cli/run.ts';
import { defaultDeps } from '../../src/http.ts';
import { OUTPUT_LIMIT } from '../../src/output/toon.ts';
import { type FakeOptions, startFake } from '../fake/priority-fake.ts';
import { tempDir } from '../helpers.ts';

type Fake = Awaited<ReturnType<typeof startFake>>;
const NOW = new Date('2026-11-05T12:00:00.000Z');

function runner(fake: Fake, cache = tempDir()) {
  return async (args: string[], env: Record<string, string> = {}) => {
    const out: string[] = [];
    const code = await main(args, {
      stdout: (t) => {
        out.push(t);
      },
      env: {
        PRIORITY_URL: fake.root,
        PRIORITY_USER: 'API',
        PRIORITY_PASSWORD: 'secret-pass',
        XDG_CACHE_HOME: cache,
        ...env,
      },
      now: () => NOW,
      http: { fetch: defaultDeps.fetch, sleep: async () => {} },
    });
    return { code, out: out.join('') };
  };
}

async function withFake(
  options: FakeOptions,
  fn: (fake: Fake) => Promise<void>,
) {
  const fake = await startFake(options);
  try {
    await fn(fake);
  } finally {
    await fake.close();
  }
}

let fake: Fake;
let run: ReturnType<typeof runner>;
before(async () => {
  fake = await startFake();
  run = runner(fake);
});
after(() => fake.close());

describe('screens', () => {
  it('finds screens by name, sub-screen title and field description', async () => {
    const r = await run(['screens', 'order']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^summary: 4 screens match order\n/m);
    assert.match(
      r.out,
      /screens\[4\]\{name,key,api,match\}:\n {2}ORDERS,ORDNAME,unknown,name\n/,
    );
    const hebrew = await run(['screens', 'מס. לקוח']);
    assert.match(hebrew.out, /field CUSTNAME \(מס\. לקוח\)/);
  });

  it('caps the list and names the full read', async () => {
    const r = await run(['screens', '--limit', '2']);
    assert.match(r.out, /^summary: 8 screens \(2 shown\)\n/);
    assert.match(r.out, /Run `priority-axi screens --full` to list all 8/);
  });

  it('states an empty result', async () => {
    const r = await run(['screens', 'zzzz']);
    assert.equal(r.code, 0);
    assert.match(r.out, /^summary: 0 screens match zzzz\n/);
    assert.match(r.out, /Run `priority-axi screens` to list every screen/);
  });
});

describe('fields', () => {
  it('describes a screen within the output bound', async () => {
    const r = await run(['fields', 'ORDERS']);
    assert.equal(r.code, 0, r.out);
    assert.match(
      r.out,
      /^screen: ORDERS\nkey: ORDNAME\nsummary: 111 fields \(1 internal ID hidden; --all shows them\)\n/,
    );
    assert.match(r.out, /\n {2}ORDNAME,text\(16\),key,מס חוזה\n/);
    assert.match(r.out, /\n {2}POSITIONDES,text\(32\),read-only,/);
    assert.match(r.out, /subforms\[30\]: ORDERITEMS,/);
    assert.ok(r.out.length <= OUTPUT_LIMIT);
    assert.doesNotMatch(r.out, /\n {2}ORD,int/);
  });

  it('shows internal IDs with --all and every field with --full', async () => {
    const r = await run(['fields', 'ORDERS', '--all', '--full']);
    assert.match(r.out, /\n {2}ORD,int,read-only id,/);
    assert.doesNotMatch(r.out, /omitted:/);
  });

  it('describes sub-screens, including one that holds a single record', async () => {
    const lines = await run(['fields', 'ORDERS', '--sub', 'orderitems']);
    assert.match(
      lines.out,
      /^screen: ORDERS > ORDERITEMS\ntitle: פירוטי חוזה\nholds: lines\nkey: KLINE\n/,
    );
    const one = await run(['fields', 'ORDERS', '--sub', 'SHIPTO2']);
    assert.match(one.out, /holds: one record\nkey: null\n/);
  });

  it('suggests a near name for a typo, exit 2', async () => {
    const r = await run(['fields', 'ORDER']);
    assert.equal(r.code, 2);
    assert.match(r.out, /No screen named ORDER\. Did you mean ORDERS/);
  });
});

describe('get', () => {
  it('reads with default columns, more exist and a next-page hint', async () => {
    const r = await run(['get', 'ORDERS', '--limit', '3']);
    assert.equal(r.code, 0, r.out);
    assert.match(
      r.out,
      /^summary: "3 records from ORDERS, more exist"\nrecords\[3\]\{ORDNAME,CUSTNAME,CDES,CURDATE\}:\n {2}SO26000101,C1001,/,
    );
    assert.match(
      r.out,
      /Run `priority-axi get ORDERS --limit 3 --page 2` for the next 3/,
    );
    const page2 = await run(['get', 'ORDERS', '--limit', '3', '--page', '2']);
    assert.match(
      page2.out,
      /^summary: "3 records from ORDERS \(page 2\), more exist"\n/,
    );
    assert.match(page2.out, /\n {2}SO26000104,/);
    const last = await run(['get', 'ORDERS', '--limit', '3', '--page', '3']);
    assert.match(last.out, /^summary: 2 records from ORDERS \(page 3\)\n/);
    assert.doesNotMatch(last.out, /--page 4/);
  });

  it('filters with typed --where terms and sorts', async () => {
    const r = await run([
      'get',
      'ORDERS',
      '--where',
      'custname=C1002',
      '--where',
      'CURDATE>=2026-10-05',
      '--sort',
      'CURDATE:desc',
    ]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^summary: 2 records from ORDERS\n/);
    assert.match(
      r.out,
      /records\[2\]\{[^}]*\}:\n {2}SO26000108,C1002,[^\n]*\n {2}SO26000105,C1002,/,
    );
    assert.match(
      fake.state.lastQuery ?? '',
      /\$filter=CUSTNAME%20eq%20%27C1002%27%20and%20CURDATE%20ge%202026-10-05T00%3A00%3A00Z/,
    );
  });

  it('states an empty result with exit 0', async () => {
    const r = await run(['get', 'ORDERS', '--where', 'CUSTNAME=NOPE']);
    assert.equal(r.code, 0);
    assert.match(r.out, /^summary: 0 records from ORDERS\n/);
  });

  it('chooses columns with --fields and includes sub-screen lines with --with', async () => {
    const r = await run([
      'get',
      'ORDERS',
      '--fields',
      'CURDATE',
      '--with',
      'ORDERITEMS',
      '--limit',
      '1',
    ]);
    assert.match(
      r.out,
      /ORDNAME: SO26000101\n {4}CURDATE: 2026-10-03\n {4}ORDERITEMS\[1\]\{KLINE,PARTNAME,PDES,TQUANT\}:\n {6}1,P-100,Part 100,1\n/,
    );
    // Lines are narrowed and capped on the server: 5 shown, one more to see whether more exist.
    assert.match(
      decodeURIComponent(fake.state.lastQuery ?? ''),
      /\$expand=ORDERITEMS_SUBFORM\(\$select=KLINE,[A-Z0-9_,]+;\$top=6\)(&|$)/,
    );
  });

  it('always selects the whole key, which QA needs to finish an $expand answer', async () => {
    // The fake cuts the answer off as QA does when the key is missing...
    const auth = `Basic ${Buffer.from('API:secret-pass').toString('base64')}`;
    const cut = await fetch(
      `${fake.root}/ORDERS?$select=CURDATE&$top=1&$expand=ORDERITEMS_SUBFORM`,
      { headers: { authorization: auth } },
    );
    assert.equal(cut.status, 200);
    const body = await cut.text();
    assert.match(body, /^\{"@odata\.context":[^\n]*"value":\[\{"CURDATE":/);
    assert.throws(() => JSON.parse(body));
    // ...and --fields without the key still reads, because the key is added.
    const r = await run([
      'get',
      'ORDERS',
      '--fields',
      'CURDATE',
      '--with',
      'ORDERITEMS',
      '--limit',
      '2',
    ]);
    assert.equal(r.code, 0, r.out);
    assert.match(
      decodeURIComponent(fake.state.lastQuery ?? ''),
      /\$select=ORDNAME,CURDATE&/,
    );
  });

  it('asks for every line of a sub-screen with --full', async () => {
    const r = await run([
      'get',
      'ORDERS',
      '--with',
      'ORDERITEMS',
      '--limit',
      '1',
      '--full',
    ]);
    assert.equal(r.code, 0, r.out);
    assert.match(
      decodeURIComponent(fake.state.lastQuery ?? ''),
      /\$expand=ORDERITEMS_SUBFORM(&|$)/,
    );
  });

  it('refuses contains (~) before sending, and maps a raw contains to unsupported_query', async () => {
    const before = fake.state.gets;
    const r = await run(['get', 'ORDERS', '--where', 'CDES~Ltd']);
    assert.equal(r.code, 2);
    assert.match(r.out, /code: usage/);
    assert.equal(fake.state.gets, before);
    const raw = await run([
      'get',
      'ORDERS',
      '--filter',
      "contains(CDES,'Ltd')",
    ]);
    assert.equal(raw.code, 1);
    assert.match(raw.out, /code: unsupported_query/);
  });

  it('records a refused screen and shows it on the home view', async () => {
    const cache = tempDir();
    const local = runner(fake, cache);
    const r = await local(['get', 'LOGPART']);
    assert.equal(r.code, 1);
    assert.match(r.out, /code: screen_not_enabled\n/);
    assert.match(r.out, /add LOGPART to Limited Access\/API Forms/);
    await local(['get', 'CURRENCIES']);
    const home = await local([]);
    assert.match(
      home.out,
      /screens_read\[1\]: CURRENCIES\nnot_enabled\[1\]: LOGPART\n/,
    );
  });

  it('shows hostile text as visible data', async () => {
    const r = await run(['get', 'CUSTOMERS', '--where', 'CUSTNAME=C1002']);
    assert.match(r.out, /Hostile\\\\u202etxt\.exe Ltd/);
    assert.doesNotMatch(r.out, /\u202e/);
  });

  it('refuses bad flag values before calling Priority', async () => {
    const before = fake.state.gets;
    for (const args of [
      ['get', 'ORDERS', '--limit', '0'],
      ['get', 'ORDERS', '--limit', '501'],
      ['get', 'ORDERS', '--where', 'NOPE=1'],
      ['get', 'ORDERS', '--sort', 'CURDATE:up'],
      ['get', 'ORDERS', '--with', 'NOPE'],
    ]) {
      const r = await run(args);
      assert.equal(r.code, 2, args.join(' '));
    }
    assert.equal(fake.state.gets, before);
  });

  it('retries a read once after a short 429', async () => {
    await withFake({ throttleOnce: true }, async (f) => {
      const r = await runner(f)(['get', 'CURRENCIES']);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /^summary: 5 records from CURRENCIES\n/);
    });
  });
});

describe('show', () => {
  it('reads one record with key fields first, no help', async () => {
    const r = await run([
      'show',
      'ORDERS',
      'SO26000102',
      '--with',
      'ORDERITEMS',
      '--with',
      'SHIPTO2',
    ]);
    assert.equal(r.code, 0, r.out);
    assert.match(
      r.out,
      /^screen: ORDERS\nrecord:\n {2}ORDNAME: SO26000102\n {2}CUSTNAME: C1002\n/,
    );
    assert.match(r.out, /\nORDERITEMS\[2\]\{KLINE,PARTNAME,PDES,TQUANT\}:\n/);
    assert.match(r.out, /\nSHIPTO2:\n {2}CUSTDES: Warehouse 7\n/);
    assert.doesNotMatch(r.out, /help\[/);
  });

  it('shows a remarks sub-screen as plain text, not Priority HTML', async () => {
    const r = await run([
      'show',
      'ORDERS',
      'SO26000102',
      '--with',
      'ORDERSTEXT',
    ]);
    assert.equal(r.code, 0, r.out);
    assert.match(
      r.out,
      /\nORDERSTEXT:\n {2}TEXT: "תזמין צינור 110 כתום & ברך\\n\| הבהרה: אתר אונו"\n/,
    );
    assert.doesNotMatch(r.out, /<style|<p|&amp;/);
    const list = await run([
      'get',
      'ORDERS',
      '--where',
      'ORDNAME=SO26000102',
      '--with',
      'ORDERSTEXT',
      '--full',
    ]);
    assert.equal(list.code, 0, list.out);
    assert.match(
      list.out,
      /,ORDERSTEXT\{TEXT\}\}:\n.*,"תזמין צינור 110 כתום & ברך\\n\| הבהרה: אתר אונו"\n/,
    );
    assert.doesNotMatch(list.out, /<style|<p/);
  });

  it('cuts long text with its size and the --full read', async () => {
    const r = await run(['show', 'CUSTOMERS', 'C1002']);
    assert.match(
      r.out,
      /… \(truncated, 653 code points total; use --full to see all\)/,
    );
    const full = await run(['show', 'CUSTOMERS', 'C1002', '--full']);
    assert.doesNotMatch(full.out, /truncated/);
  });

  it('answers not_found for a missing key', async () => {
    const r = await run(['show', 'ORDERS', 'SO-NONE']);
    assert.equal(r.code, 1);
    assert.match(r.out, /^message: No ORDERS record has ORDNAME SO-NONE\./);
    assert.match(r.out, /code: not_found/);
  });

  it('asks for --key on a compound key', async () => {
    const r = await run(['show', 'DOCUMENTS_e', 'X']);
    assert.equal(r.code, 2);
    assert.match(
      r.out,
      /compound key \(DOCNO, TYPE\)\. Use --key DOCNO=<value> --key TYPE=<value>/,
    );
  });
});

describe('changes', () => {
  it('reads records changed since a date or a relative time', async () => {
    const r = await run(['changes', 'ORDERS', '--since', '2026-10-08']);
    assert.equal(r.code, 0, r.out);
    assert.match(
      r.out,
      /^summary: "3 records from ORDERS changed since 2026-10-08T00:00:00Z"\n/,
    );
    const rel = await run(['changes', 'ORDERS', '--since', '7d']);
    assert.match(rel.out, /changed since 2026-10-29T12:00:00Z/);
    assert.match(
      fake.state.lastQuery ?? '',
      /\$since=2026-10-29T12%3A00%3A00Z/,
    );
  });

  it('explains that a screen without a BPM status workflow has no change tracking', async () => {
    const r = await run(['changes', 'CURRENCIES', '--since', '7d']);
    assert.equal(r.code, 1);
    assert.match(r.out, /\ncode: unsupported_query\n/);
    assert.match(r.out, /CURRENCIES has no status workflow \(BPM\)/);
    assert.match(r.out, /priority-axi get CURRENCIES/);
  });

  it('needs --since', async () => {
    const r = await run(['changes', 'ORDERS']);
    assert.equal(r.code, 2);
    assert.match(r.out, /changes needs --since/);
  });
});

describe('create', () => {
  it('shows a dry run without sending anything', async () => {
    const posts = fake.state.posts;
    const r = await run([
      'create',
      'ORDERS',
      '--set',
      'CUSTNAME=C1001',
      '--line',
      'ORDERITEMS',
      'PARTNAME=P-100',
      'TQUANT=5',
      '--dry-run',
    ]);
    assert.equal(r.code, 0, r.out);
    assert.match(
      r.out,
      /^dry_run: true\nrequest: POST \/odata\/Priority\/tabula\.ini\/a150125\/ORDERS\nbody:\n {2}CUSTNAME: C1001\n {2}ORDERITEMS_SUBFORM\[1\]\{PARTNAME,TQUANT\}:\n {4}P-100,5\ntransactions: 2\n/,
    );
    assert.match(
      r.out,
      /Run `priority-axi create ORDERS --set CUSTNAME=C1001 --line ORDERITEMS PARTNAME=P-100 TQUANT=5` to send it/,
    );
    assert.equal(fake.state.posts, posts);
  });

  it('creates once with lines and names the read command', async () => {
    const posts = fake.state.posts;
    const r = await run([
      'create',
      'ORDERS',
      '--set',
      'CUSTNAME=C1003',
      '--line',
      'ORDERITEMS',
      'PARTNAME=P-9',
      'TQUANT=2',
      'PRICE=10.5',
    ]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^created: ORDERS\nkey: SO26000\d+\ntransactions: 2\n/);
    assert.match(r.out, /Run `priority-axi show ORDERS SO26000\d+` to read it/);
    assert.equal(fake.state.posts, posts + 1);
    const created = fake.state.rows.ORDERS?.at(-1);
    assert.deepEqual(created?.ORDERITEMS_SUBFORM, [
      { PARTNAME: 'P-9', TQUANT: 2, PRICE: 10.5 },
    ]);
  });

  it('sends a duplicate once and reports already_exists', async () => {
    const posts = fake.state.posts;
    const r = await run([
      'create',
      'ORDERS',
      '--set',
      'ORDNAME=SO26000101',
      '--set',
      'CUSTNAME=C1001',
    ]);
    assert.equal(r.code, 1);
    assert.match(r.out, /code: already_exists/);
    assert.equal(fake.state.posts, posts + 1);
  });

  it('passes Priority required-field messages through', async () => {
    const r = await run(['create', 'ORDERS', '--set', 'CDES=x']);
    assert.equal(r.code, 1);
    assert.match(
      r.out,
      /^message: יש למלא ערך בשדה מס\. לקוח\ncode: priority_rejected\n/,
    );
  });

  it('refuses bad bodies before sending', async () => {
    const posts = fake.state.posts;
    for (const [args, pattern] of [
      [['create', 'ORDERS', '--set', 'POSITIONDES=x'], /read-only/],
      [['create', 'ORDERS', '--set', 'ORD=5'], /internal ID|read-only/],
      [
        ['create', 'ORDERS', '--set', 'CUSTNAME=12345678901234567'],
        /at most 16 characters/,
      ],
      [
        ['create', 'ORDERS', '--line', 'ORDERITEMS', 'TQUANT=1,5'],
        /with a point/,
      ],
      [
        ['create', 'ORDERS', '--set', 'CUSTNAME=C1', 'PARTNAME=P'],
        /belongs to a --line/,
      ],
      [
        ['create', 'ORDERS', '--set', 'CUSTNAME=C1', '--set', 'custname=C2'],
        /more than once/,
      ],
      [
        [
          'create',
          'ORDERS',
          '--line',
          'SHIPTO2',
          'ADDRESS=a',
          '--line',
          'SHIPTO2',
          'ADDRESS=b',
        ],
        /holds one record/,
      ],
      [['create', 'ORDERS'], /Nothing to create/],
    ] as const) {
      const r = await run([...args]);
      assert.equal(r.code, 2, `${args.join(' ')}\n${r.out}`);
      assert.match(r.out, pattern);
    }
    assert.equal(fake.state.posts, posts);
  });

  it('takes the same record from --json-file', async () => {
    const path = join(tempDir(), 'order.json');
    writeFileSync(
      path,
      JSON.stringify({
        CUSTNAME: 'C1002',
        ORDERITEMS: [{ PARTNAME: 'P-1', TQUANT: 3 }],
        SHIPTO2_SUBFORM: { ADDRESS: 'Dock 2' },
      }),
    );
    const r = await run(['create', 'ORDERS', '--json-file', path, '--dry-run']);
    assert.equal(r.code, 0, r.out);
    assert.match(
      r.out,
      /ORDERITEMS_SUBFORM\[1\]\{PARTNAME,TQUANT\}:\n {4}P-1,3\n {2}SHIPTO2_SUBFORM:\n {4}ADDRESS: Dock 2\ntransactions: 3\n/,
    );
    const both = await run([
      'create',
      'ORDERS',
      '--json-file',
      path,
      '--set',
      'CDES=x',
    ]);
    assert.equal(both.code, 2);
  });

  it('reports a Gate hold with the action id and sends exactly once', async () => {
    await withFake({ gate: 'hold' }, async (f) => {
      const r = await runner(f)([
        'create',
        'CUSTOMERS',
        '--set',
        'CUSTDES=New Customer Ltd',
      ]);
      assert.equal(r.code, 1);
      assert.match(
        r.out,
        /^message: The owner has an approval card for this request\. Do not retry\. Run `comis action wait A-1`\.\ncode: held_for_approval\n/,
      );
      assert.match(r.out, /\naction: A-1\n/);
      assert.equal(f.state.posts, 1);
    });
  });

  it('reports the Gate reconnect refusal', async () => {
    await withFake({ gate: 'reconnect' }, async (f) => {
      const r = await runner(f)(['get', 'CUSTOMERS']);
      assert.equal(r.code, 1);
      assert.match(r.out, /code: reconnect_needed/);
    });
  });
});
