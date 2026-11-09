import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Settings } from '../../src/config.ts';
import { AxiError } from '../../src/errors.ts';
import { type HttpDeps, rowsOf, send } from '../../src/http.ts';
import { VERSION } from '../../src/version.ts';
import { type Call, fakeFetch, json, type Route } from '../helpers.ts';

const settings: Settings = {
  origin: 'https://erp.example.com',
  ini: 'tabula.ini',
  company: 'demo',
  user: 'user_a',
  password: 'placeholder-pass-1',
};

function deps(
  routes: Record<string, Route>,
  calls: Call[] = [],
  sleeps: number[] = [],
): HttpDeps {
  return {
    fetch: fakeFetch(routes, calls),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
}

const code = (c: string) => (e: unknown) =>
  e instanceof AxiError && e.code === c;

describe('send', () => {
  it('sends Basic, Accept, OData-Version and the User-Agent; the password never goes in the URL', async () => {
    const calls: Call[] = [];
    await send(
      settings,
      { method: 'GET', path: 'GetPriorityVersion()' },
      deps(
        { 'GetPriorityVersion()': () => json(200, { value: '23.1' }) },
        calls,
      ),
    );
    const [call] = calls;
    assert.ok(call);
    assert.equal(
      call.url,
      'https://erp.example.com/odata/Priority/tabula.ini/demo/GetPriorityVersion()',
    );
    assert.equal(
      call.headers.Authorization,
      `Basic ${Buffer.from('user_a:placeholder-pass-1').toString('base64')}`,
    );
    assert.equal(call.headers.Accept, 'application/json');
    assert.equal(call.headers['OData-Version'], '4.0');
    assert.equal(call.headers['User-Agent'], `priority-axi/${VERSION}`);
    assert.ok(!call.url.includes('placeholder-pass-1'));
  });

  it('retries a read once after a short Retry-After', async () => {
    let n = 0;
    const sleeps: number[] = [];
    const route = () =>
      ++n === 1
        ? json(429, undefined, { 'Retry-After': '2' })
        : json(200, { value: [] });
    const answer = await send(
      settings,
      { method: 'GET', path: 'CUSTOMERS' },
      deps({ CUSTOMERS: route }, [], sleeps),
    );
    assert.equal(answer.status, 200);
    assert.deepEqual(sleeps, [2000]);
    assert.equal(n, 2);
  });

  it('does not wait out a long Retry-After', async () => {
    const sleeps: number[] = [];
    await assert.rejects(
      send(
        settings,
        { method: 'GET', path: 'CUSTOMERS' },
        deps(
          { CUSTOMERS: () => json(429, undefined, { 'Retry-After': '60' }) },
          [],
          sleeps,
        ),
      ),
      code('rate_limited'),
    );
    assert.deepEqual(sleeps, []);
  });

  it('sends a write exactly once, whatever the answer', async () => {
    for (const status of [429, 500, 502]) {
      const calls: Call[] = [];
      await assert.rejects(
        send(
          settings,
          { method: 'POST', path: 'ORDERS', body: { CUSTNAME: 'C1' } },
          deps(
            { ORDERS: () => json(status, undefined, { 'Retry-After': '1' }) },
            calls,
          ),
        ),
        AxiError,
      );
      assert.equal(calls.length, 1, String(status));
      assert.equal(calls[0]?.body, '{"CUSTNAME":"C1"}');
    }
  });

  it('refuses a percent-encoded write path before sending', async () => {
    const calls: Call[] = [];
    await assert.rejects(
      send(
        settings,
        { method: 'POST', path: 'ORDERS%2F', body: {} },
        deps({}, calls),
      ),
      code('internal_error'),
    );
    assert.equal(calls.length, 0);
  });

  it('reports network failure and timeout as unreachable, without transport details', async () => {
    const failing: HttpDeps = {
      fetch: async () => {
        throw new TypeError('fetch failed', {
          cause: { code: 'ECONNREFUSED' },
        });
      },
      sleep: async () => {},
    };
    await assert.rejects(
      send(settings, { method: 'GET', path: 'X' }, failing),
      (e: unknown) => {
        assert.ok(e instanceof AxiError);
        assert.equal(e.code, 'unreachable');
        assert.ok(!/ECONN|fetch failed/.test(e.message));
        return true;
      },
    );
    const slow: HttpDeps = {
      fetch: async () => {
        throw new DOMException('timed out', 'TimeoutError');
      },
      sleep: async () => {},
    };
    await assert.rejects(
      send(settings, { method: 'GET', path: 'X' }, slow),
      (e: unknown) => e instanceof AxiError && /within 90 s/.test(e.message),
    );
  });

  it('reports an answer broken off mid-stream as unreachable, and warns that a create may be saved', async () => {
    const broken = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"value":[{"A":'));
            controller.error(new TypeError('terminated'));
          },
        }),
        { status: 200 },
      );
    await assert.rejects(
      send(settings, { method: 'GET', path: 'X' }, deps({ X: broken })),
      (e: unknown) =>
        e instanceof AxiError &&
        e.code === 'unreachable' &&
        /broke off/.test(e.message) &&
        !/terminated/.test(e.message),
    );
    await assert.rejects(
      send(
        settings,
        { method: 'POST', path: 'X', body: { A: 1 } },
        deps({ X: broken }),
      ),
      (e: unknown) =>
        e instanceof AxiError && /may have been saved/.test(e.message),
    );
  });

  it('does not follow redirects', async () => {
    await assert.rejects(
      send(
        settings,
        { method: 'GET', path: 'X' },
        deps({
          X: () =>
            new Response(null, {
              status: 302,
              headers: { Location: 'https://elsewhere.example' },
            }),
        }),
      ),
      code('priority_error'),
    );
  });

  it('classifies Priority errors with the screen', async () => {
    const notEnabled = () =>
      json(400, {
        error: { code: '400', message: 'לא ניתן להפעיל API למסך זה.' },
      });
    await assert.rejects(
      send(
        settings,
        { method: 'GET', path: 'ORDERS', context: { screen: 'ORDERS' } },
        deps({ ORDERS: notEnabled }),
      ),
      (e: unknown) =>
        e instanceof AxiError &&
        e.code === 'screen_not_enabled' &&
        e.fields.screen === 'ORDERS',
    );
  });
});

describe('rowsOf', () => {
  it('returns the value array and refuses anything else', async () => {
    const ok = await send(
      settings,
      { method: 'GET', path: 'X' },
      deps({ X: () => json(200, { value: [{ A: 1 }] }) }),
    );
    assert.deepEqual(rowsOf(ok), [{ A: 1 }]);
    const bad = await send(
      settings,
      { method: 'GET', path: 'X' },
      deps({ X: () => json(200, { value: [1] }) }),
    );
    assert.throws(() => rowsOf(bad), code('priority_error'));
  });

  it('refuses a 200 whose JSON was cut off, as QA sends for some $expand reads', async () => {
    const cut = await send(
      settings,
      { method: 'GET', path: 'X' },
      deps({
        X: () => new Response('{"value":[{"IVNUM":"SI1"', { status: 200 }),
      }),
    );
    assert.equal(cut.malformed, true);
    assert.throws(
      () => rowsOf(cut),
      (e: unknown) =>
        e instanceof AxiError &&
        e.code === 'priority_error' &&
        /incomplete answer \(24 bytes\)/.test(e.message),
    );
  });
});
