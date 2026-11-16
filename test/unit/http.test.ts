import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Settings } from '../../src/config.ts';
import { AxiError } from '../../src/errors.ts';
import {
  beforeSending,
  type HttpDeps,
  MAX_ANSWER_BYTES,
  rowsOf,
  send,
} from '../../src/http.ts';
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
      (e: unknown) => e instanceof AxiError && /within 150 s\./.test(e.message),
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
        e instanceof AxiError &&
        /broke off its answer to the create, so Priority may have saved the create\. .*Do not retry\./.test(
          e.message,
        ),
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

describe('a write that fails after it was sent', () => {
  const reject = (cause: unknown): HttpDeps => ({
    fetch: async () => {
      throw new TypeError('fetch failed', { cause });
    },
    sleep: async () => {},
  });
  const errno = (code: string) =>
    Object.assign(new Error(`connect ${code}`), { code });

  it('tells errors that prove nothing was sent from all others', () => {
    for (const code of [
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'UND_ERR_CONNECT_TIMEOUT',
      'CERT_HAS_EXPIRED',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ]) {
      assert.equal(
        beforeSending(new TypeError('fetch failed', { cause: errno(code) })),
        true,
        code,
      );
    }
    // localhost tries ::1 and 127.0.0.1, and both refuse.
    assert.equal(
      beforeSending(
        new TypeError('fetch failed', {
          cause: Object.assign(
            new AggregateError([errno('ECONNREFUSED'), errno('ECONNREFUSED')]),
            { code: 'ECONNREFUSED' },
          ),
        }),
      ),
      true,
    );
    // The Gate or another proxy refused the CONNECT tunnel.
    assert.equal(
      beforeSending(
        new TypeError('fetch failed', {
          cause: Object.assign(
            new Error('Proxy response (403) !== 200 when HTTP Tunneling'),
            { code: 'UND_ERR_ABORTED' },
          ),
        }),
      ),
      true,
    );
    for (const cause of [
      errno('ECONNRESET'),
      errno('EPIPE'),
      Object.assign(new Error('other side closed'), {
        code: 'UND_ERR_SOCKET',
      }),
      new Error('no code'),
      undefined,
    ]) {
      assert.equal(
        beforeSending(new TypeError('fetch failed', { cause })),
        false,
        String((cause as { code?: string } | undefined)?.code),
      );
    }
  });

  it('says a write may have been saved, and not to retry, unless nothing was sent', async () => {
    for (const [call, what] of [
      [{ method: 'POST', path: 'ORDERS', body: {} }, 'create'],
      [{ method: 'PATCH', path: "ORDERS('SO1')", body: {} }, 'update'],
      [
        { method: 'POST', path: "ORDERS('SO1')/ORDERITEMS_SUBFORM", body: {} },
        'new line',
      ],
    ] as const) {
      await assert.rejects(
        send(settings, call, reject(errno('ECONNRESET'))),
        (e: unknown) =>
          e instanceof AxiError &&
          e.code === 'unreachable' &&
          e.message.includes(
            `The connection to Priority broke after the ${what} was sent, so Priority may have saved the ${what}. Check with \`priority-axi show\` or \`priority-axi get\` before sending it again. Do not retry.`,
          ) &&
          !/could not be reached|Check the address/.test(e.message),
      );
    }
    await assert.rejects(
      send(
        settings,
        { method: 'POST', path: 'ORDERS', body: {} },
        reject(errno('ECONNREFUSED')),
      ),
      (e: unknown) =>
        e instanceof AxiError &&
        e.message ===
          'Priority could not be reached, so nothing was sent. Check the address, or whether the Gate is running.',
    );
    const slow: HttpDeps = {
      fetch: async () => {
        throw new DOMException('timed out', 'TimeoutError');
      },
      sleep: async () => {},
    };
    await assert.rejects(
      send(settings, { method: 'PATCH', path: "X('1')", body: {} }, slow),
      (e: unknown) =>
        e instanceof AxiError &&
        /^Priority did not answer within 120 s after the update was sent, so Priority may have saved the update\. .*Do not retry\.$/.test(
          e.message,
        ),
    );
  });

  it('adds the same warning to a server failure answered to a write', async () => {
    for (const status of [500, 502, 504]) {
      await assert.rejects(
        send(
          settings,
          { method: 'POST', path: 'ORDERS', body: {} },
          deps({ ORDERS: () => json(status) }),
        ),
        (e: unknown) =>
          e instanceof AxiError &&
          e.code === 'priority_error' &&
          new RegExp(
            `^Priority answered ${status} with no message\\. Priority may have saved the create anyway\\. .*Do not retry\\.$`,
          ).test(e.message),
      );
    }
    // A read is not a write: no warning.
    await assert.rejects(
      send(
        settings,
        { method: 'GET', path: 'X' },
        deps({ X: () => json(500) }),
      ),
      (e: unknown) =>
        e instanceof AxiError && !/may have saved/.test(e.message),
    );
  });
});

describe('answer size', () => {
  it('stops reading an answer over the cap and reports output_too_large', async () => {
    const chunk = new Uint8Array(2 ** 20).fill(32);
    let pulled = 0;
    const huge = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulled++;
            controller.enqueue(chunk);
          },
        }),
        { status: 200 },
      );
    await assert.rejects(
      send(settings, { method: 'GET', path: 'X' }, deps({ X: huge })),
      (e: unknown) =>
        e instanceof AxiError &&
        e.code === 'output_too_large' &&
        /over 32 MB/.test(e.message) &&
        e.fields.limit === MAX_ANSWER_BYTES,
    );
    assert.ok(pulled <= 40, String(pulled));
  });
});

describe('COMIS_DEADLINE', () => {
  const now = 1_800_000_000_000;
  const at = (ms: number) => ({ ...settings, deadline: now + ms });
  const clock = (d: HttpDeps): HttpDeps => ({ ...d, now: () => now });

  it('bounds a read by the time left, less a second', async () => {
    let signal: AbortSignal | undefined;
    const d = clock({
      fetch: async (_u, init) => {
        signal = init?.signal ?? undefined;
        throw new DOMException('timed out', 'TimeoutError');
      },
      sleep: async () => {},
    });
    await assert.rejects(
      send(at(20_000), { method: 'GET', path: 'X' }, d),
      (e: unknown) =>
        e instanceof AxiError &&
        e.code === 'unreachable' &&
        /^Priority did not answer within the 19 s left before this command's deadline\. Run it from a worker/.test(
          e.message,
        ),
    );
    assert.ok(signal);
  });

  it('refuses a read when no time is left, before asking Priority', async () => {
    const calls: Call[] = [];
    await assert.rejects(
      send(
        at(900),
        { method: 'GET', path: 'X' },
        clock(deps({ X: () => json(200, { value: [] }) }, calls)),
      ),
      (e: unknown) =>
        e instanceof AxiError &&
        /ran out before Priority was asked/.test(e.message),
    );
    assert.equal(calls.length, 0);
  });

  it('refuses a write with less than 50 s left, without sending it', async () => {
    const calls: Call[] = [];
    const d = clock(deps({ ORDERS: () => json(201, {}) }, calls));
    await assert.rejects(
      send(at(49_000), { method: 'POST', path: 'ORDERS', body: {} }, d),
      (e: unknown) =>
        e instanceof AxiError &&
        e.code === 'unreachable' &&
        /^Only 49 s are left before this command's deadline \(COMIS_DEADLINE\): not enough time for the owner's approval hold, so nothing was sent\. Run it in a worker/.test(
          e.message,
        ),
    );
    assert.equal(calls.length, 0);
    await send(at(60_000), { method: 'POST', path: 'ORDERS', body: {} }, d);
    assert.equal(calls.length, 1);
  });

  it('does not wait out a Retry-After that passes the deadline', async () => {
    const sleeps: number[] = [];
    await assert.rejects(
      send(
        at(3_000),
        { method: 'GET', path: 'X' },
        clock(
          deps(
            { X: () => json(429, undefined, { 'Retry-After': '5' }) },
            [],
            sleeps,
          ),
        ),
      ),
      code('rate_limited'),
    );
    assert.deepEqual(sleeps, []);
  });
});
