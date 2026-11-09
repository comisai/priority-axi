// find against the fake Priority over real HTTP: the catalog pull, the local
// Hebrew search, inactive records, sub-screens, and the cache.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { main } from '../../src/cli/run.ts';
import { defaultDeps } from '../../src/http.ts';
import { type FakeOptions, startFake } from '../fake/priority-fake.ts';
import { tempDir } from '../helpers.ts';

type Fake = Awaited<ReturnType<typeof startFake>>;
const NOW = new Date('2026-11-05T12:00:00.000Z');
const GERSHAYIM = String.fromCodePoint(0x05f4);
const ENABLED = ['CUSTOMERS', 'ORDERS', 'CURRENCIES', 'LOGPART', 'DOCUMENTS_p'];

function runner(fake: Fake, cache = tempDir(), now = NOW) {
  return async (args: string[]) => {
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
      },
      now: () => now,
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
  fake = await startFake({ enabled: ENABLED });
  run = runner(fake);
});
after(() => fake.close());

describe('find', () => {
  it('pulls the catalog once and finds parts by Hebrew words and sizes', async () => {
    const r = await run(['find', 'LOGPART', 'צינור', 'כתום', '110']);
    assert.equal(r.code, 0, r.out);
    assert.match(
      r.out,
      /^summary: 2 records from LOGPART match צינור כתום 110\n/,
    );
    assert.match(
      r.out,
      /\ncatalog: "built now: 11 records from Priority in \d+ s; 10 active of 11 records, built 2026-11-05 12:00 UTC/,
    );
    assert.match(
      r.out,
      /records\[2\]\{PARTNAME,PARTDES,PUNITNAME,FAMILYDES\}:\n {2}"1047505",[^\n]*1000[^\n]*\n {2}"1047510",[^\n]*4000/,
    );
    assert.match(
      r.out,
      /Run `priority-axi show LOGPART <PARTNAME>` for one record/,
    );

    const gets = fake.state.gets;
    const again = await run(['find', 'LOGPART', 'שרוול']);
    assert.match(again.out, /^summary: 1 record from LOGPART match שרוול\n/);
    assert.doesNotMatch(again.out, /built now/);
    assert.equal(fake.state.gets, gets, 'the second search reads no records');
  });

  it('shows the closest parts and what they lack when no part has every word', async () => {
    const r = await run(['find', 'LOGPART', `צינור 4${GERSHAYIM} כתום`]);
    assert.equal(r.code, 0, r.out);
    assert.match(
      r.out,
      /^summary: "0 records from LOGPART match all of: צינור 4״ כתום"\n/,
    );
    assert.match(r.out, /\nclosest: 4 records match 2 of 3 words\n/);
    assert.match(r.out, /\{PARTNAME,PARTDES,PUNITNAME,FAMILYDES,lacking\}:/);
    assert.match(r.out, /"1047510",[^\n]*,"4"\n/);
    assert.match(r.out, /with fewer or different words/);
  });

  it('leaves out inactive records unless --all, which adds the status', async () => {
    const r = await run(['find', 'LOGPART', 'צבוע', 'לבן']);
    assert.match(r.out, /^summary: 1 record from LOGPART match צבוע לבן\n/);
    assert.match(r.out, /"1002189",[^\n]*,מטר,/);
    const all = await run(['find', 'LOGPART', 'צבוע', 'לבן', '--all']);
    assert.match(all.out, /^summary: 2 records from LOGPART match צבוע לבן\n/);
    assert.match(all.out, /\{PARTNAME,PARTDES,PUNITNAME,FAMILYDES,STATDES\}:/);
    assert.match(all.out, /"1002188",[^\n]*,לא פעיל\n/);
  });

  it('searches sub-screen lines with their parent, leaving out inactive parents', async () => {
    const r = await run(['find', 'CUSTOMERS', '--sub', 'CUSTPROJECTS', 'אלפא']);
    assert.equal(r.code, 0, r.out);
    assert.match(
      r.out,
      /^summary: 2 lines from CUSTOMERS > CUSTPROJECTS match אלפא\n/,
    );
    assert.match(
      r.out,
      /lines\[2\]\{DOCNO,TYPE,PROJDES,CUSTNAME,CUSTDES,matched\}:\n {2}PR26000001,p,[^\n]*,C1001,[^\n]*,own\n/,
    );
    assert.doesNotMatch(r.out, /PR26000003/, 'C1005 is inactive');
    assert.match(
      r.out,
      /Run `priority-axi show CUSTOMERS <CUSTNAME> --with CUSTPROJECTS` for the record/,
    );
    const all = await run([
      'find',
      'CUSTOMERS',
      '--sub',
      'CUSTPROJECTS',
      'אלפא',
      'יפו',
      '--all',
    ]);
    assert.match(
      all.out,
      /^summary: 1 line from CUSTOMERS > CUSTPROJECTS match אלפא יפו\n/,
    );
    assert.match(all.out, /PR26000003/);
  });

  it('searches the projects screen by project name and customer name, leaving out closed projects', async () => {
    const r = await run(['find', 'DOCUMENTS_p', 'אלפא']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^summary: 2 records from DOCUMENTS_p match אלפא\n/);
    assert.match(r.out, /2 active of 4 records/);
    assert.match(
      r.out,
      /records\[2\]\{DOCNO,TYPE,PROJDES,CUSTNAME,CUSTDES,STATDES,matched\}:\n {2}PR26000001,p,[^\n]*,C1001,[^\n]*,בעבודה,own\n {2}PR26000002,/,
    );
    const byCustomer = await run(['find', 'DOCUMENTS_p', 'לקוח', '1']);
    assert.match(
      byCustomer.out,
      /^summary: 2 records from DOCUMENTS_p match לקוח 1\n/,
    );
    assert.match(byCustomer.out, /,customer\n/);
    const closed = await run(['find', 'DOCUMENTS_p', 'יפו']);
    assert.equal(closed.code, 0);
    assert.match(
      closed.out,
      /^summary: 0 records from DOCUMENTS_p match יפו\n/,
    );
    assert.match(
      closed.out,
      /\nnot_in_use: "2 records not in use \(inactive, cancelled, finished or closed\) match every word; --all shows them with their status"\n/,
    );
    assert.doesNotMatch(closed.out, /closest|records\[/);
    assert.match(
      closed.out,
      /--all` to see the 2 not in use, then ask before using one/,
    );
    const all = await run(['find', 'DOCUMENTS_p', 'יפו', '--all']);
    assert.match(all.out, /^summary: 2 records from DOCUMENTS_p match יפו\n/);
    assert.match(all.out, /,מבוטלת,own\n/);
    assert.match(all.out, /,הסתיים,own\n/);
  });

  it('finds a customer by its parent name through its projects', async () => {
    const r = await run([
      'find',
      'CUSTOMERS',
      '--sub',
      'CUSTPROJECTS',
      'לקוח',
      '1',
      'אונו',
    ]);
    assert.match(
      r.out,
      /^summary: 1 line from CUSTOMERS > CUSTPROJECTS match לקוח 1 אונו\n/,
    );
    assert.match(r.out, /,parent\n/, 'לקוח 1 is only in the customer name');
  });

  it('says plainly when nothing matches, and offers --all when records were left out', async () => {
    const r = await run(['find', 'CUSTOMERS', 'zzz-nothing']);
    assert.equal(r.code, 0);
    assert.match(
      r.out,
      /^summary: 0 records from CUSTOMERS match zzz-nothing\n/,
    );
    assert.match(r.out, /--all` to include records not in use/);
    assert.doesNotMatch(r.out, /records\[/);
  });

  it('pages the matches', async () => {
    const r = await run(['find', 'LOGPART', 'צינור', '--limit', '2']);
    assert.match(
      r.out,
      /^summary: 5 records from LOGPART match צינור \(showing 1-2\)\n/,
    );
    assert.match(
      r.out,
      /Run `priority-axi find LOGPART 'צינור' --limit 2 --page 2` for the next 2/,
    );
    const p3 = await run([
      'find',
      'LOGPART',
      'צינור',
      '--limit',
      '2',
      '--page',
      '3',
    ]);
    assert.match(p3.out, /\(showing 5-5\)/);
    assert.doesNotMatch(p3.out, /--page 4/);
  });

  it('refuses a query without words, and a screen without a description', async () => {
    const none = await run(['find', 'LOGPART', 'ת']);
    assert.equal(none.code, 2);
    assert.match(none.out, /find needs words to look for/);
    const missing = await run(['find', 'LOGPART']);
    assert.equal(missing.code, 2);
    assert.match(missing.out, /Missing <words>/);
    const currencies = await run(['find', 'CURRENCIES', 'דולר']);
    assert.equal(currencies.code, 2);
    assert.match(
      currencies.out,
      /CURRENCIES has no description field for find to search/,
    );
  });

  it('reports a screen that is not enabled', async () => {
    await withFake({}, async (f) => {
      const r = await runner(f)(['find', 'LOGPART', 'צינור']);
      assert.equal(r.code, 1);
      assert.match(r.out, /code: screen_not_enabled/);
    });
  });

  it('pulls a large catalog page by page, then several pages at once', async () => {
    await withFake({ enabled: ENABLED, parts: 2500 }, async (f) => {
      const r = await runner(f)(['find', 'LOGPART', 'בדיקה', '2499']);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /^summary: 1 record from LOGPART match בדיקה 2499\n/);
      assert.match(r.out, /built now: 2511 records/);
      assert.match(r.out, /X002499/);
      // One page alone, then four at once; the third answers short.
      assert.equal(
        f.state.requests.filter((q) => q.path.endsWith('/LOGPART')).length,
        5,
      );
    });
  });

  it('rebuilds the catalog after a day, or with --refresh', async () => {
    await withFake({ enabled: ENABLED }, async (f) => {
      const cache = tempDir();
      await runner(f, cache)(['find', 'CUSTOMERS', 'לקוח']);
      const count = () =>
        f.state.requests.filter((q) => q.path.endsWith('/CUSTOMERS')).length;
      const first = count();
      await runner(f, cache)(['find', 'CUSTOMERS', 'לקוח']);
      assert.equal(count(), first);
      await runner(f, cache)(['find', 'CUSTOMERS', 'לקוח', '--refresh']);
      assert.equal(count(), first + 1);
      const later = new Date(NOW.getTime() + 25 * 3600_000);
      const r = await runner(f, cache, later)(['find', 'CUSTOMERS', 'לקוח']);
      assert.equal(count(), first + 2);
      assert.match(r.out, /built now/);
    });
  });
});

describe('create with a remark and a required field', () => {
  it('puts the original message in a one-record text sub-screen', async () => {
    const r = await run([
      'create',
      'ORDERS',
      '--set',
      'CUSTNAME=C1001',
      '--set',
      'DETAILS=אינסטלטור: דני',
      '--line',
      'ORDERITEMS',
      'PARTNAME=1047510',
      'TQUANT=6',
      '--line',
      'ORDERSTEXT',
      'TEXT=תזמין צינור 4 כתום',
      '--dry-run',
    ]);
    assert.equal(r.code, 0, r.out);
    assert.match(
      r.out,
      /\n {2}ORDERSTEXT_SUBFORM:\n {4}TEXT: תזמין צינור 4 כתום\ntransactions: 3\n/,
    );
  });

  it("shows Priority's form error when a required field is missing", async () => {
    const r = await run(['create', 'CUSTOMERS', '--set', 'CUSTDES=New Ltd']);
    assert.equal(r.code, 1);
    assert.match(
      r.out,
      /^message: שורה 1- - חסר מס' חברה\ncode: priority_rejected\n/,
    );
  });
});
