import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AxiError } from '../../src/errors.ts';
import {
  buildIndex,
  type Field,
  type ScreenType,
} from '../../src/index/build.ts';
import {
  combineFilters,
  literal,
  orderBy,
  parseWhere,
  queryString,
  recordSegment,
  screenSegment,
  utc,
  whereToFilter,
} from '../../src/odata.ts';
import { FIXTURE } from '../helpers.ts';

const index = buildIndex(FIXTURE, { version: '23.1', builtAt: 'x' });
const orders = index.types.ORDERS;
assert.ok(orders);
const field = (type: string): Field => ({ name: 'F', type });
const isUsage = (e: unknown) => e instanceof AxiError && e.code === 'usage';

describe('parseWhere', () => {
  it('reads every operator, longest first', () => {
    assert.deepEqual(parseWhere('A=1'), { field: 'A', op: '=', value: '1' });
    assert.deepEqual(parseWhere('A!=1'), { field: 'A', op: '!=', value: '1' });
    assert.deepEqual(parseWhere('A>=2026-10-01'), {
      field: 'A',
      op: '>=',
      value: '2026-10-01',
    });
    assert.deepEqual(parseWhere('A<=1'), { field: 'A', op: '<=', value: '1' });
    assert.deepEqual(parseWhere('A>1'), { field: 'A', op: '>', value: '1' });
    assert.deepEqual(parseWhere('A<1'), { field: 'A', op: '<', value: '1' });
    assert.deepEqual(parseWhere('A~x=y'), {
      field: 'A',
      op: '~',
      value: 'x=y',
    });
    assert.deepEqual(parseWhere('A='), { field: 'A', op: '=', value: '' });
  });

  it('refuses expressions without a field and an operator, without echoing them', () => {
    assert.throws(() => parseWhere('=1'), isUsage);
    assert.throws(
      () => parseWhere('secret-text'),
      (e: unknown) =>
        isUsage(e) && !(e as Error).message.includes('secret-text'),
    );
  });
});

describe('literal', () => {
  it('quotes strings and doubles single quotes', () => {
    assert.equal(literal(field('String'), "O'Brien"), "'O''Brien'");
    assert.equal(literal(field('String'), 'מס חוזה'), "'מס חוזה'");
  });

  it('checks numbers and booleans', () => {
    assert.equal(literal(field('Int64'), '-42'), '-42');
    assert.throws(() => literal(field('Int64'), '4.2'), isUsage);
    assert.equal(literal(field('Decimal'), '12.50'), '12.50');
    assert.throws(() => literal(field('Decimal'), '12,50'), isUsage);
    assert.equal(literal(field('Boolean'), 'true'), 'true');
    assert.throws(() => literal(field('Boolean'), 'Y'), isUsage);
  });

  it('writes dates as UTC with Z', () => {
    assert.equal(
      literal(field('DateTimeOffset'), '2026-10-01'),
      '2026-10-01T00:00:00Z',
    );
    assert.equal(utc('2026-10-01T08:00:00+03:00', 'x'), '2026-10-01T05:00:00Z');
    assert.equal(utc('2026-10-01T08:00Z', 'x'), '2026-10-01T08:00:00Z');
    assert.throws(() => utc('2026-02-30', 'x'), isUsage);
    assert.throws(() => utc('01/10/2026', 'x'), isUsage);
  });

  it('refuses types --where cannot filter', () => {
    assert.throws(() => literal(field('Binary'), 'x'), isUsage);
  });
});

describe('whereToFilter', () => {
  it('builds a typed filter joined with and', () => {
    assert.equal(
      whereToFilter(
        ['custname=C1001', 'CURDATE>=2026-10-01'],
        orders,
        'ORDERS',
      ),
      "CUSTNAME eq 'C1001' and CURDATE ge 2026-10-01T00:00:00Z",
    );
    assert.equal(whereToFilter([], orders, 'ORDERS'), undefined);
  });

  it('refuses ~ (contains), which Priority answers with 501, and offers a range', () => {
    assert.throws(
      () => whereToFilter(['CDES~Ltd'], orders, 'ORDERS'),
      (e: unknown) =>
        isUsage(e) &&
        /--where 'CDES>=ABC' --where 'CDES<ABD'/.test((e as Error).message) &&
        !/Ltd/.test((e as Error).message),
    );
  });

  it('refuses unknown fields with a suggestion', () => {
    assert.throws(
      () => whereToFilter(['CUSTNAM=1'], orders, 'ORDERS'),
      (e: unknown) => isUsage(e) && /CUSTNAME/.test((e as Error).message),
    );
  });
});

describe('query parts', () => {
  it('combines --where with raw --filter', () => {
    assert.equal(
      combineFilters('A eq 1', 'B eq 2 or C eq 3'),
      'A eq 1 and (B eq 2 or C eq 3)',
    );
    assert.equal(combineFilters(undefined, 'B eq 2'), 'B eq 2');
    assert.equal(combineFilters('A eq 1', undefined), 'A eq 1');
    assert.throws(() => combineFilters(undefined, ' '), isUsage);
  });

  it('builds $orderby from --sort', () => {
    assert.equal(orderBy('curdate:desc', orders, 'ORDERS'), 'CURDATE desc');
    assert.equal(orderBy('ORDNAME', orders, 'ORDERS'), 'ORDNAME');
    assert.throws(() => orderBy('ORDNAME:up', orders, 'ORDERS'), isUsage);
  });

  it('encodes values and keeps option names literal', () => {
    assert.equal(
      queryString({
        $top: 6,
        $filter: "CUSTNAME eq 'C 1'",
        $select: undefined,
      }),
      "?$top=6&$filter=CUSTNAME%20eq%20'C%201'",
    );
    assert.equal(queryString({}), '');
  });

  it('builds path segments only from checked names', () => {
    assert.equal(screenSegment('DOCUMENTS_e'), 'DOCUMENTS_e');
    assert.throws(
      () => screenSegment('ORDERS%2F..'),
      (e: unknown) => e instanceof AxiError && e.code === 'internal_error',
    );
    assert.throws(() => screenSegment("ORDERS('SO1')"), AxiError);
  });
});

describe('recordSegment', () => {
  const type = (key: string[], fields: Field[]): ScreenType => ({
    key,
    fields,
    subs: [],
  });
  const text = (name: string, max = 20): Field => ({
    name,
    type: 'String',
    max,
  });
  const int = (name: string): Field => ({ name, type: 'Int64' });

  it('quotes a text key and doubles a quote inside it', () => {
    assert.equal(
      recordSegment(
        'CUSTOMERS',
        type(['CUSTNAME'], [text('CUSTNAME')]),
        "O'Brien",
      ),
      "CUSTOMERS('O''Brien')",
    );
    assert.equal(
      recordSegment('ORDERS', type(['ORDNAME'], [text('ORDNAME')]), 'A(1)'),
      "ORDERS('A(1)')",
    );
  });

  it('writes a number key bare, or named for a line', () => {
    const lines = type(['KLINE'], [int('KLINE')]);
    assert.equal(
      recordSegment('ORDERITEMS_SUBFORM', lines, '3'),
      'ORDERITEMS_SUBFORM(3)',
    );
    assert.equal(
      recordSegment('ORDERITEMS_SUBFORM', lines, '3', true),
      'ORDERITEMS_SUBFORM(KLINE=3)',
    );
    assert.throws(
      () => recordSegment('ORDERITEMS_SUBFORM', lines, '3 '),
      /whole number/,
    );
  });

  it('names every part of a compound key once', () => {
    const t = type(['USER', 'DAY'], [text('USER'), int('DAY')]);
    assert.equal(recordSegment('X', t, 'USER=u1,DAY=2'), "X(USER='u1',DAY=2)");
    assert.throws(() => recordSegment('X', t, 'u1'), /compound key/);
    assert.throws(
      () => recordSegment('X', t, 'USER=u1,USER=u2'),
      /compound key/,
    );
  });

  it('refuses what the Gate would refuse: traversal, encodings and control text', () => {
    const t = type(['ORDNAME'], [text('ORDNAME', 300)]);
    for (const bad of ['..', 'a/b', '%27', 'a\\b', 'a\nb', '', 'x'.repeat(260)])
      assert.throws(() => recordSegment('ORDERS', t, bad), bad);
  });
});
