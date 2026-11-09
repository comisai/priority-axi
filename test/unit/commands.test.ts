import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shortType } from '../../src/commands/catalog.ts';
import {
  commandLine,
  intFlag,
  shellWord,
  sinceFlag,
  tokenLine,
} from '../../src/commands/common.ts';
import { typedValue } from '../../src/commands/create.ts';
import { AxiError } from '../../src/errors.ts';
import type { Field } from '../../src/index/build.ts';

const isUsage = (e: unknown) => e instanceof AxiError && e.code === 'usage';
const f = (type: string, extra: Partial<Field> = {}): Field => ({
  name: 'F',
  type,
  ...extra,
});

describe('typedValue', () => {
  it('converts values to the JSON type Priority expects', () => {
    assert.equal(typedValue(f('String', { max: 5 }), 'abc', 'S'), 'abc');
    assert.equal(
      typedValue(f('String', { max: 3 }), 'שלו', 'S'),
      'שלו',
      'counts code points, not bytes',
    );
    assert.equal(typedValue(f('Int64'), '-7', 'S'), -7);
    assert.equal(typedValue(f('Decimal'), '12.50', 'S'), 12.5);
    assert.equal(typedValue(f('Boolean'), 'false', 'S'), false);
    assert.equal(
      typedValue(f('DateTimeOffset'), '2026-11-05', 'S'),
      '2026-11-05T00:00:00Z',
    );
  });

  it('refuses values that would fail at Priority', () => {
    assert.throws(
      () => typedValue(f('String', { max: 2 }), 'abc', 'S'),
      isUsage,
    );
    assert.throws(() => typedValue(f('Int64'), '1.5', 'S'), isUsage);
    assert.throws(
      () => typedValue(f('Int64'), '99999999999999999999', 'S'),
      isUsage,
    );
    assert.throws(() => typedValue(f('Decimal'), '1,5', 'S'), isUsage);
    assert.throws(() => typedValue(f('Boolean'), 'Y', 'S'), isUsage);
    assert.throws(
      () => typedValue(f('String', { readOnly: true }), 'x', 'S'),
      isUsage,
    );
    assert.throws(
      () => typedValue(f('Int64', { internalId: true }), '1', 'S'),
      isUsage,
    );
  });
});

describe('command hints', () => {
  it('quotes shell words only when needed', () => {
    assert.equal(shellWord('CUSTNAME=C1001'), 'CUSTNAME=C1001');
    assert.equal(shellWord('CDES=Example Ltd'), "'CDES=Example Ltd'");
    assert.equal(shellWord("O'Brien"), "'O'\\''Brien'");
    assert.equal(shellWord('לקוח'), "'לקוח'");
  });

  it('rebuilds a command with one flag changed', () => {
    assert.equal(
      commandLine(
        'get',
        ['ORDERS'],
        { where: ['A=1', 'B=x y'], limit: '5', full: true, page: '1' },
        { page: '2' },
      ),
      "priority-axi get ORDERS --where A=1 --where 'B=x y' --limit 5 --full --page 2",
    );
    assert.equal(
      commandLine('screens', [], { limit: '2' }, { limit: null, full: '' }),
      'priority-axi screens --full',
    );
  });

  it('rebuilds create in the order given', () => {
    assert.equal(
      tokenLine(
        'create',
        [
          { kind: 'positional', value: 'ORDERS' },
          { kind: 'option', name: 'line', value: 'ORDERITEMS' },
          { kind: 'positional', value: 'PDES=Big part' },
          { kind: 'option', name: 'dry-run', value: undefined },
        ],
        ['dry-run'],
      ),
      "priority-axi create ORDERS --line ORDERITEMS 'PDES=Big part'",
    );
  });
});

describe('flag values', () => {
  it('parses whole numbers in range', () => {
    assert.equal(intFlag(undefined, 'limit', 20, 1, 500), 20);
    assert.equal(intFlag('7', 'limit', 20, 1, 500), 7);
    for (const bad of ['0', '501', '-1', '2.5', 'x', '']) {
      assert.throws(() => intFlag(bad, 'limit', 20, 1, 500), isUsage, bad);
    }
  });

  it('reads --since as relative, a date or a full time', () => {
    const now = new Date('2026-11-05T12:00:00.000Z');
    assert.equal(sinceFlag('7d', now), '2026-10-29T12:00:00Z');
    assert.equal(sinceFlag('24h', now), '2026-11-04T12:00:00Z');
    assert.equal(sinceFlag('2026-11-01', now), '2026-11-01T00:00:00Z');
    assert.throws(() => sinceFlag(undefined, now), isUsage);
    assert.throws(() => sinceFlag('yesterday', now), isUsage);
  });
});

describe('shortType', () => {
  it('names types the way an agent reads them', () => {
    assert.equal(shortType(f('String', { max: 16 })), 'text(16)');
    assert.equal(shortType(f('Int64')), 'int');
    assert.equal(shortType(f('Decimal')), 'decimal');
    assert.equal(shortType(f('DateTimeOffset', { dateType: 'Date' })), 'date');
    assert.equal(shortType(f('DateTimeOffset')), 'datetime');
    assert.equal(shortType(f('Boolean')), 'bool');
  });
});
