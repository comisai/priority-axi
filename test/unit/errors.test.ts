import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AxiError,
  classify,
  formLine,
  priorityMessage,
} from '../../src/errors.ts';

const answer = (
  status: number,
  json?: unknown,
  headers: Record<string, string> = {},
) => ({
  status,
  json,
  headers: new Headers(headers),
});
const priority = (message: string) => ({ error: { code: '400', message } });

describe('classify', () => {
  it('passes success', () => {
    assert.equal(classify(answer(200, { value: [] })), null);
    assert.equal(classify(answer(201, {})), null);
  });

  it('reads a Gate hold as held_for_approval with the action id, exit 1', () => {
    const e = classify(
      answer(409, undefined, {
        'Comis-Refusal': 'approval_pending',
        'Comis-Action': 'A-9',
      }),
    );
    assert.equal(e?.code, 'held_for_approval');
    assert.equal(e?.fields.action, 'A-9');
    assert.match(
      e?.message ?? '',
      /Do not retry\. Run `comis action wait A-9`/,
    );
    assert.equal(e?.exitCode, 1);
  });

  it('strips "; replayed" from the action id', () => {
    const e = classify(
      answer(409, undefined, {
        'Comis-Refusal': 'approval_pending',
        'Comis-Action': 'A-9; replayed',
      }),
    );
    assert.equal(e?.fields.action, 'A-9');
  });

  it('reads the Gate reconnect refusal and other refusals', () => {
    assert.equal(
      classify(answer(502, undefined, { 'Comis-Refusal': 'reconnect_needed' }))
        ?.code,
      'reconnect_needed',
    );
    const refused = classify(
      answer(403, undefined, { 'Comis-Refusal': 'standing_rule_blocked' }),
      { screen: 'ORDERS' },
    );
    assert.equal(refused?.code, 'refused');
    assert.equal(refused?.fields.refusal, 'standing_rule_blocked');
    assert.equal(refused?.fields.screen, 'ORDERS');
  });

  it('maps a direct 401 to auth_failed', () => {
    assert.equal(classify(answer(401))?.code, 'auth_failed');
  });

  it('recognises the not-enabled message in Hebrew and in English', () => {
    for (const text of [
      'לא ניתן להפעיל API למסך זה.',
      'API cannot be run for this form.',
      'API cannot be run for this screen',
    ]) {
      const e = classify(answer(400, priority(text)), { screen: 'ORDERS' });
      assert.equal(e?.code, 'screen_not_enabled', text);
      assert.match(e?.message ?? '', /add ORDERS to Limited Access\/API Forms/);
    }
  });

  it('recognises the bad-company message in Hebrew and in English', () => {
    for (const text of [
      'שם החברה שנשלח לא תקין, או היתה בעיה במעבר לחברה.',
      'There was a problem changing companies. The company name that was sent may be wrong.',
    ]) {
      assert.equal(
        classify(answer(400, priority(text)), { company: 'zz' })?.code,
        'company_not_found',
        text,
      );
    }
  });

  it('maps the other statuses', () => {
    assert.equal(classify(answer(404), { screen: 'NOPE' })?.code, 'not_found');
    assert.equal(
      classify(answer(409, priority('exists')))?.code,
      'already_exists',
    );
    assert.equal(classify(answer(429))?.code, 'rate_limited');
    const unsupported = classify(
      answer(501, priority('Function "startswith" is not supported')),
    );
    assert.equal(unsupported?.code, 'unsupported_query');
    assert.match(unsupported?.message ?? '', /startswith/);
    const rejected = classify(
      answer(400, priority('Field CUSTNAME is required')),
    );
    assert.equal(rejected?.code, 'priority_rejected');
    assert.equal(rejected?.message, 'Field CUSTNAME is required');
    assert.equal(
      classify(answer(500, priority('boom')))?.code,
      'priority_error',
    );
    assert.equal(classify(answer(503))?.code, 'priority_error');
  });

  it('gives usage exit 2 and every other code exit 1', () => {
    assert.equal(new AxiError('usage', 'x').exitCode, 2);
    assert.equal(new AxiError('not_connected', 'x').exitCode, 1);
  });
});

describe('classify $since on a screen without BPM', () => {
  it('is unsupported_query naming the screen, with get as the way forward', () => {
    const e = classify(
      answer(
        400,
        priority(
          'השימוש ב $since נתמך רק בפניה למסכים עם BPM (הערה: ניתן להשתמש ב-$expand)',
        ),
      ),
      { screen: 'CURRENCIES' },
    );
    assert.ok(e instanceof AxiError);
    assert.equal(e.code, 'unsupported_query');
    assert.match(e.message, /^CURRENCIES has no status workflow \(BPM\)/);
    assert.match(e.message, /priority-axi get CURRENCIES/);
  });
});

describe('priorityMessage', () => {
  it('reads form errors (InterfaceErrors) from JSON, as one text or a list', () => {
    assert.equal(
      priorityMessage({
        FORM: {
          '@TYPE': 'CUSTOMERS',
          InterfaceErrors: { text: 'Line 1- bad' },
        },
      }),
      'Line 1- bad',
    );
    assert.equal(
      priorityMessage({
        FORM: {
          InterfaceErrors: [{ text: 'Line 1- a' }, { text: { '#text': 'b' } }],
        },
      }),
      'Line 1- a b',
    );
  });

  it('reads form errors from an XML body, decoding entities and CDATA', () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><FORM TYPE="CUSTOMERS"><InterfaceErrors>' +
      '<text>Line 1- &quot;A&amp;B&quot; &#1513;</text><text><![CDATA[<x>]]></text>' +
      '</InterfaceErrors></FORM>';
    assert.equal(
      priorityMessage(undefined, xml),
      `Line 1- "A&B" ${String.fromCodePoint(0x5e9)} <x>`,
    );
    const e = classify({ ...answer(400), text: xml }, { screen: 'CUSTOMERS' });
    assert.ok(e instanceof AxiError);
    assert.equal(e.code, 'priority_rejected');
    assert.match(e.message, /^Line 1- "A&B"/);
  });

  it('prefers the OData error message and ignores other bodies', () => {
    assert.equal(priorityMessage(priority('odata says')), 'odata says');
    assert.equal(priorityMessage(undefined, '<html>oops</html>'), undefined);
    assert.equal(priorityMessage({ FORM: {} }), undefined);
  });
});

describe('error wording for writes and lockouts', () => {
  it('says not to retry a failed sign-in, and names the lockout', () => {
    const e = classify(answer(401));
    assert.equal(e?.code, 'auth_failed');
    assert.match(
      e?.message ?? '',
      /Do not retry: after 3 failed sign-ins Priority locks the API user for 30 minutes/,
    );
  });

  it('names a possible lockout on a 429 without Retry-After', () => {
    const bare = classify(answer(429));
    assert.match(
      bare?.message ?? '',
      /locked the API user after failed sign-ins/,
    );
    assert.match(bare?.message ?? '', /do not retry in a loop/);
    const timed = classify(answer(429, undefined, { 'Retry-After': '30' }));
    assert.doesNotMatch(timed?.message ?? '', /locked/);
  });

  it("blames the record, not the screen, for a 404 on a write, with Priority's words", () => {
    const e = classify(answer(404, priority('הרשומה לא נמצאה')), {
      screen: 'ORDERS',
      method: 'PATCH',
    });
    assert.equal(e?.code, 'not_found');
    assert.match(
      e?.message ?? '',
      /^Priority found no such ORDERS record or line \(404\)/,
    );
    assert.doesNotMatch(e?.message ?? '', /priority-axi screens/);
    assert.equal(e?.fields.priority, 'הרשומה לא נמצאה');
    const read = classify(answer(404), { screen: 'ORDERS', method: 'GET' });
    assert.match(
      read?.message ?? '',
      /Check the name with `priority-axi screens`/,
    );
  });

  it('does not tell an update that conflicts to read instead of creating', () => {
    const e = classify(answer(409, priority('conflict')), {
      screen: 'ORDERS',
      method: 'PATCH',
    });
    assert.equal(e?.code, 'priority_rejected');
    assert.match(
      e?.message ?? '',
      /conflict \(409\): conflict\. Read the record/,
    );
    assert.doesNotMatch(e?.message ?? '', /creating/);
    const create = classify(answer(409), { screen: 'ORDERS', method: 'POST' });
    assert.equal(create?.code, 'already_exists');
  });

  it("gives the Gate's policy refusal a sentence an agent can act on", () => {
    const e = classify(
      answer(403, undefined, { 'Comis-Refusal': 'policy_refused' }),
    );
    assert.equal(e?.code, 'refused');
    assert.match(e?.message ?? '', /A reader workbench cannot write/);
  });
});

describe('formLine', () => {
  it("reads the line Priority's form errors name, in Hebrew or English", () => {
    const form = (text: unknown) => ({ FORM: { InterfaceErrors: text } });
    assert.equal(formLine(form({ text: 'שורה 2- מק"ט X: לא קיים' })), 2);
    assert.equal(formLine(form({ text: 'Line 3 - Part X does not exist' })), 3);
    assert.equal(
      formLine(form([{ text: 'שורה 4- a' }, { text: 'שורה 2- b' }])),
      2,
    );
    assert.equal(formLine(form({ text: "שורה 1- - חסר מס' חברה" })), 1);
    assert.equal(formLine(form({ text: 'no line here' })), undefined);
    assert.equal(
      formLine(form([{ text: 'שורה 2- a' }, { text: 'other' }])),
      undefined,
    );
    assert.equal(formLine(priority('שורה 2- in an OData message')), undefined);
  });

  it('is carried on a 4xx refusal, without printing it', () => {
    const e = classify(
      answer(400, { FORM: { InterfaceErrors: { text: 'שורה 2- bad part' } } }),
    );
    assert.equal(e?.code, 'priority_rejected');
    assert.equal(e?.formLine, 2);
    assert.equal(e?.fields.line, undefined);
  });
});
