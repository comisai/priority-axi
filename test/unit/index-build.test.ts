import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { AxiError } from '../../src/errors.ts';
import {
  buildIndex,
  resolveField,
  resolveScreen,
  resolveSub,
  suggest,
} from '../../src/index/build.ts';
import { FIXTURE } from '../helpers.ts';

const index = buildIndex(FIXTURE, {
  version: '23.1',
  builtAt: '2026-11-05T12:00:00.000Z',
});

function usageMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof AxiError);
    assert.equal(error.code, 'usage');
    return error.message;
  }
  assert.fail('expected a usage error');
}

describe('buildIndex', () => {
  it('indexes screens, types and sub-screens', () => {
    assert.equal(Object.keys(index.sets).length, 8);
    assert.equal(Object.keys(index.types).length, 12);
    assert.deepEqual(index.types.CUSTOMERS?.key, ['CUSTNAME']);
    assert.equal(
      index.sets.ORDERITEMS,
      undefined,
      'ORDERITEMS is a sub-screen only',
    );
    const sub = index.types.ORDERS?.subs.find((s) => s.name === 'ORDERITEMS');
    assert.deepEqual(sub, {
      name: 'ORDERITEMS',
      nav: 'ORDERITEMS_SUBFORM',
      type: 'ORDERITEMS',
      title: 'פירוטי חוזה',
      many: true,
    });
  });

  it('keeps field type, length, description and flags', () => {
    const fields = index.types.ORDERS?.fields ?? [];
    const byName = (n: string) => fields.find((f) => f.name === n);
    assert.deepEqual(byName('ORDNAME'), {
      name: 'ORDNAME',
      type: 'String',
      max: 16,
      description: 'מס חוזה',
    });
    assert.equal(byName('ORD')?.internalId, true);
    assert.equal(byName('ORD')?.readOnly, true);
    assert.equal(byName('CURDATE')?.type, 'DateTimeOffset');
    assert.equal(byName('CURDATE')?.dateType, 'Date');
    assert.equal(fields.length, 111);
    assert.equal(index.types.ORDERS?.subs.length, 30);
  });

  it('keeps form order, so default columns follow the Priority form', () => {
    assert.deepEqual(
      index.types.ORDERS?.fields.slice(0, 5).map((f) => f.name),
      ['CUSTNAME', 'CDES', 'NAME', 'POSITIONDES', 'CURDATE'],
    );
  });

  it('refuses metadata it cannot read', () => {
    for (const bad of [null, [], {}, { $EntityContainer: 'X.Y', X: {} }]) {
      assert.throws(
        () => buildIndex(bad, { version: '1', builtAt: 'x' }),
        (e: unknown) => e instanceof AxiError && e.code === 'priority_error',
      );
    }
  });

  it('matches the full QA metadata when given (opt-in: PRIORITY_AXI_FULL_METADATA)', (t) => {
    const path = process.env.PRIORITY_AXI_FULL_METADATA;
    if (!path) {
      t.skip(
        'set PRIORITY_AXI_FULL_METADATA to the full $metadata?$format=json file',
      );
      return;
    }
    const full = buildIndex(JSON.parse(readFileSync(path, 'utf8')), {
      version: '23.1',
      builtAt: 'x',
    });
    const types = Object.values(full.types);
    assert.equal(Object.keys(full.sets).length, 1329);
    assert.equal(types.length, 2990);
    assert.equal(
      types.reduce((n, t) => n + t.fields.length, 0),
      35878,
    );
    assert.equal(
      types.reduce((n, t) => n + t.subs.length, 0),
      3056,
    );
  });
});

describe('resolveScreen', () => {
  it('finds exact names, including lowercase ones Priority uses', () => {
    assert.equal(resolveScreen(index, 'CUSTOMERS').name, 'CUSTOMERS');
    assert.equal(resolveScreen(index, 'DOCUMENTS_e').name, 'DOCUMENTS_e');
  });

  it('accepts a unique case-insensitive match', () => {
    assert.equal(resolveScreen(index, 'customers').name, 'CUSTOMERS');
    assert.equal(resolveScreen(index, 'documents_E').name, 'DOCUMENTS_e');
  });

  it('suggests near names and never echoes a value that is not a name', () => {
    assert.match(
      usageMessage(() => resolveScreen(index, 'CUSTOMER')),
      /Did you mean CUSTOMERS\?/,
    );
    const message = usageMessage(() => resolveScreen(index, "x' or 1=1"));
    assert.ok(!message.includes('1=1'));
  });

  it('rejects a sub-screen as a top-level screen', () => {
    usageMessage(() => resolveScreen(index, 'ORDERITEMS'));
  });
});

describe('resolveSub and resolveField', () => {
  const orders = resolveScreen(index, 'ORDERS');

  it('finds a sub-screen by short or navigation name, any case', () => {
    for (const name of ['ORDERITEMS', 'ORDERITEMS_SUBFORM', 'orderitems']) {
      const sub = resolveSub(index, orders, name);
      assert.equal(sub.nav, 'ORDERITEMS_SUBFORM');
      assert.ok(sub.def.fields.length > 0);
    }
  });

  it('names the sub-screens command when one is unknown', () => {
    assert.match(
      usageMessage(() => resolveSub(index, orders, 'NOPE')),
      /priority-axi fields ORDERS/,
    );
  });

  it('finds fields case-insensitively and suggests near ones', () => {
    assert.equal(
      resolveField(orders.type, 'ORDERS', 'custname').name,
      'CUSTNAME',
    );
    assert.match(
      usageMessage(() => resolveField(orders.type, 'ORDERS', 'CUSTNAM')),
      /CUSTNAME/,
    );
  });
});

describe('suggest', () => {
  it('ranks exact, prefix, contains, then close edits', () => {
    assert.deepEqual(
      suggest('ORDER', ['XORDERX', 'ORDERS', 'ORDER', 'OREDR']),
      ['ORDER', 'ORDERS', 'XORDERX', 'OREDR'],
    );
    assert.deepEqual(suggest('', ['A']), []);
  });
});
