import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AxiError } from '../../src/errors.ts';
import { buildIndex } from '../../src/index/build.ts';
import { isTextForm, plainText } from '../../src/output/html.ts';
import {
  defaultColumns,
  formatValue,
  recordView,
  tableRow,
} from '../../src/output/shape.ts';
import { visible, visibleString, WITHHELD } from '../../src/output/text.ts';
import {
  bounded,
  cut,
  errorText,
  FULL_LIMIT,
  helpBlock,
  OUTPUT_LIMIT,
  render,
} from '../../src/output/toon.ts';
import { FIXTURE } from '../helpers.ts';

const cp = (n: number) => String.fromCodePoint(n);

describe('visible text', () => {
  it('keeps Hebrew and ordinary text', () => {
    assert.equal(visibleString('מס חוזה 15/01/25'), 'מס חוזה 15/01/25');
    assert.equal(
      visibleString('line one\nline two\tend'),
      'line one\nline two\tend',
    );
  });

  it('escapes bidirectional controls, zero-width and other invisible characters', () => {
    assert.equal(visibleString(`a${cp(0x202e)}b`), 'a\\u202eb');
    assert.equal(
      visibleString(`a${cp(0x200b)}b${cp(0x2066)}c`),
      'a\\u200bb\\u2066c',
    );
    assert.equal(visibleString(`a${cp(0x2800)}b`), 'a\\u2800b');
    assert.equal(visibleString(`a${cp(0)}b${cp(0x1b)}c`), 'a\\u0000b\\u001bc');
    assert.equal(visibleString(`a${cp(0x2028)}b`), 'a\\u2028b');
  });

  it('replaces unpaired surrogates', () => {
    assert.equal(
      visibleString(`a${String.fromCharCode(0xd800)}b`),
      `a${cp(0xfffd)}b`,
    );
    assert.equal(visibleString('😀'), '😀');
  });

  it('withholds values that look like credentials, even split by zero-width characters', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    assert.equal(visibleString(`note ${token}`), WITHHELD);
    assert.equal(
      visibleString(`note ${token.slice(0, 6)}${cp(0x200b)}${token.slice(6)}`),
      WITHHELD,
    );
    assert.equal(
      visibleString('Authorization: Bearer abcdefgh12345678'),
      WITHHELD,
    );
    assert.equal(
      visibleString('the Bearer of this letter'),
      'the Bearer of this letter',
    );
  });

  it('applies to keys and nested values and leaves numbers alone', () => {
    assert.deepEqual(
      visible({ [`k${cp(0x200b)}`]: [`v${cp(0x202e)}`, 5, null] }),
      { 'k\\u200b': ['v\\u202e', 5, null] },
    );
  });
});

describe('TOON rendering', () => {
  it('appends the help footer as AXI text', () => {
    assert.equal(helpBlock([]), '');
    assert.equal(
      render({ summary: '0 records' }, ['Run `priority-axi refresh`']),
      'summary: 0 records\nhelp[1]:\n  Run `priority-axi refresh`\n',
    );
  });

  it('renders rows as a TOON table', () => {
    assert.equal(
      render({
        records: [
          { A: 'x', B: null },
          { A: 'y,z', B: 2 },
        ],
      }),
      'records[2]{A,B}:\n  x,null\n  "y,z",2\n',
    );
  });

  it('cuts long text at 500 code points with the standard marker', () => {
    assert.equal(cut('short'), 'short');
    const long = '😀'.repeat(501);
    assert.equal(
      cut(long),
      `${'😀'.repeat(500)} … (truncated, 501 code points total; use --full to see all)`,
    );
    assert.equal(
      cut('abcdef', 3),
      'abc … (truncated, 6 code points total; use --full to see all)',
    );
  });

  it('prints errors as message, code, usage, then extra fields', () => {
    const text = errorText(
      new AxiError('held_for_approval', 'Do not retry.', { action: 'A-9' }),
      'priority-axi create <SCREEN>',
    );
    assert.equal(
      text,
      'message: Do not retry.\ncode: held_for_approval\nusage: priority-axi create <SCREEN>\naction: A-9\n',
    );
  });
});

describe('bounded', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({
    id: `R${i}`,
    text: 'x'.repeat(300),
  }));
  const view = {
    total: rows.length,
    narrower: 'priority-axi get X --limit 20',
    build: (shown: number, fieldLimit: number) =>
      render({
        summary: `${rows.length} records`,
        records: rows.slice(0, shown).map((r) => ({
          id: r.id,
          text: Number.isFinite(fieldLimit) ? cut(r.text, fieldLimit) : r.text,
        })),
        ...(shown < rows.length
          ? { omitted: `${rows.length - shown} records` }
          : {}),
      }),
  };

  it('drops trailing rows, keeping whole fields, when one row fits', () => {
    const text = bounded(view, false);
    assert.ok(text.length <= OUTPUT_LIMIT, String(text.length));
    assert.match(text, /omitted: \d+ records/);
    assert.doesNotMatch(text, /truncated/);
  });

  it('cuts long fields first when even one row does not fit', () => {
    const wide = Array.from({ length: 3 }, (_, i) => ({
      id: `R${i}`,
      text: 'y'.repeat(9000),
    }));
    const text = bounded(
      {
        total: wide.length,
        narrower: 'x',
        build: (shown, fieldLimit) =>
          render({
            records: wide
              .slice(0, shown)
              .map((r) => ({ id: r.id, text: cut(r.text, fieldLimit) })),
            ...(shown < wide.length
              ? { omitted: `${wide.length - shown} records` }
              : {}),
          }),
      },
      false,
    );
    assert.ok(text.length <= OUTPUT_LIMIT, String(text.length));
    assert.match(
      text,
      /truncated, 9000 code points total; use --full to see all/,
    );
  });

  it('returns small views unchanged', () => {
    const small = { ...view, total: 2 };
    assert.equal(bounded(small, false), small.build(2, 500));
  });

  it('allows --full up to the byte limit and refuses beyond it', () => {
    assert.ok(bounded(view, true).length > OUTPUT_LIMIT);
    const huge = { ...view, build: () => 'x'.repeat(FULL_LIMIT + 1) };
    assert.throws(
      () => bounded(huge, true),
      (e: unknown) => e instanceof AxiError && e.code === 'output_too_large',
    );
  });
});

describe('row shape', () => {
  const index = buildIndex(FIXTURE, { version: '23.1', builtAt: 'x' });
  const orders = index.types.ORDERS;
  assert.ok(orders);
  const rows = [
    {
      ORDNAME: 'SO1',
      ORD: 10,
      CUSTNAME: 'C1',
      CDES: '',
      NAME: null,
      POSITIONDES: 'Buyer',
      CURDATE: '2026-10-03T00:00:00+03:00',
    },
    {
      ORDNAME: 'SO2',
      ORD: 11,
      CUSTNAME: 'C2',
      CDES: 'Example',
      NAME: null,
      POSITIONDES: '',
      CURDATE: null,
    },
  ];

  it('picks the key, then non-empty fields in form order, skipping internal IDs, four in all', () => {
    assert.deepEqual(defaultColumns(orders, rows), [
      'ORDNAME',
      'CUSTNAME',
      'CDES',
      'POSITIONDES',
    ]);
  });

  it('keeps every key field of a multi-key screen', () => {
    const absent = index.types.ABSENTCHART;
    assert.ok(absent);
    assert.deepEqual(defaultColumns(absent, [], 1), ['TODATE', 'USER']);
  });

  it('shows Date fields as YYYY-MM-DD and empty values as null in tables', () => {
    const curdate = orders.fields.find((f) => f.name === 'CURDATE');
    assert.equal(
      formatValue(curdate, '2026-10-03T00:00:00+03:00', 500),
      '2026-10-03',
    );
    assert.deepEqual(
      tableRow(
        orders,
        rows[1] ?? {},
        ['ORDNAME', 'CDES', 'POSITIONDES', 'CURDATE'],
        500,
      ),
      {
        ORDNAME: 'SO2',
        CDES: 'Example',
        POSITIONDES: null,
        CURDATE: null,
      },
    );
  });

  it('drops empty fields and internal IDs from a single record', () => {
    const view = recordView(orders, rows[0] ?? {}, 500);
    assert.deepEqual(view, {
      CUSTNAME: 'C1',
      POSITIONDES: 'Buyer',
      CURDATE: '2026-10-03',
      ORDNAME: 'SO1',
    });
    assert.equal(recordView(orders, rows[0] ?? {}, 500, true).ORD, 10);
  });
});

describe('Priority HTML text', () => {
  const qa =
    "<style> p,div,li {margin:0cm;font-size:10.0pt;font-family:'Arial';}li > font > p {display: inline-block;}</style><p dir=rtl><p dir=rtl>תזמין צינור 4״ pvc כתום | הזמנת בדיקה</p> </p> ";

  it('reads the text QA stores for an order remark', () => {
    assert.equal(plainText(qa), 'תזמין צינור 4״ pvc כתום | הזמנת בדיקה');
  });

  it('makes paragraphs and line breaks into lines, keeping one blank line', () => {
    assert.equal(
      plainText('<p>one</p><p>two<br>three</p><p>&nbsp;</p><p></p><p>four</p>'),
      'one\ntwo\nthree\n\nfour',
    );
  });

  it('decodes character references and keeps text that has no tags', () => {
    assert.equal(
      plainText(
        '<p>a &lt;b&gt; &amp; &quot;c&quot; &#1513; &#x5E9; &bogus; &#0;</p>',
      ),
      'a <b> & "c" ש ש &bogus; &#0;',
    );
    assert.equal(plainText('קוטר < 110 & > 50'), 'קוטר < 110 & > 50');
  });

  it('decoded invisible characters are still shown escaped', () => {
    assert.equal(visibleString(plainText('<p>a&#x202E;b</p>')), 'a\\u202eb');
  });

  it('applies to TEXT of a remarks sub-screen only', () => {
    const index = buildIndex(FIXTURE, { version: '23.1', builtAt: 'x' });
    const remarks = index.types.ORDERSTEXT;
    assert.ok(remarks && isTextForm(remarks));
    assert.deepEqual(recordView(remarks, { TEXT: qa }, 500), {
      TEXT: 'תזמין צינור 4״ pvc כתום | הזמנת בדיקה',
    });
    assert.deepEqual(recordView(remarks, { TEXT: '<p> </p>' }, 500), {});
    const lines = {
      key: ['NUM'],
      fields: [
        { name: 'NUM', type: 'Int64' },
        { name: 'TEXT', type: 'String', max: 68 },
      ],
      subs: [],
    };
    assert.equal(isTextForm(lines), false);
    assert.equal(
      recordView(lines, { NUM: 1, TEXT: '<b>x</b>' }, 500).TEXT,
      '<b>x</b>',
    );
  });
});
