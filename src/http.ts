// HTTP to Priority, directly or through the Gate (HTTPS_PROXY with
// NODE_USE_ENV_PROXY=1, set by the Comis wrapper). Reads may be retried once
// after a short 429. Writes are sent once and never retried, whatever happens.

import { type Settings, serviceRoot } from './config.ts';
import { AxiError, type ClassifyContext, classify } from './errors.ts';
import { VERSION } from './version.ts';

/** Priority Cloud drops a request after 3 minutes; an unfiltered document read took 86 s live. */
export const READ_TIMEOUT_MS = 150_000;
/** Longer than the Gate's 45 s approval hold. */
export const WRITE_TIMEOUT_MS = 120_000;
/** A write needs the Gate's 45 s approval hold and Priority's answer. */
export const WRITE_MIN_MS = 50_000;
/** Priority caps an answer at 350 MB; priority-axi reads at most this much. */
export const MAX_ANSWER_BYTES = 32 * 2 ** 20;
const MAX_RETRY_AFTER_S = 15;

export interface HttpDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** The clock for COMIS_DEADLINE, in epoch milliseconds. */
  now?: () => number;
  /** Shorter timeouts, for tests. */
  timeouts?: { read?: number; write?: number };
}

export const defaultDeps: HttpDeps = {
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface Answer {
  status: number;
  headers: Headers;
  json: unknown;
  /** A non-empty body that is not JSON, such as an answer cut off mid-stream. */
  malformed: boolean;
  /** The start of a body that is not JSON (Priority sends some errors as XML). */
  text?: string;
  bytes: number;
  ms: number;
}

export interface Call {
  method: 'GET' | 'POST' | 'PATCH';
  /** Path below the service root, built from checked names only. */
  path: string;
  query?: string;
  body?: unknown;
  context?: ClassifyContext;
}

function headers(
  settings: Settings,
  withBody: boolean,
): Record<string, string> {
  const auth = Buffer.from(`${settings.user}:${settings.password}`).toString(
    'base64',
  );
  return {
    Accept: 'application/json',
    'OData-Version': '4.0',
    'User-Agent': `priority-axi/${VERSION}`,
    Authorization: `Basic ${auth}`,
    ...(withBody ? { 'Content-Type': 'application/json' } : {}),
  };
}

/** Milliseconds left before COMIS_DEADLINE, less a one-second margin. */
export function timeLeft(settings: Settings, deps: HttpDeps): number {
  return settings.deadline === undefined
    ? Number.POSITIVE_INFINITY
    : settings.deadline - (deps.now ?? Date.now)() - 1000;
}

const WORKER =
  'Run it from a worker, which has more time: the first index build and a cold find catalog each take about 30 s.';

// Errors that prove nothing was sent: no address, no connection, a refused
// TLS handshake or a refused proxy tunnel. Anything else may come after the
// request went out.
const BEFORE_SENDING = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);
const TLS_HANDSHAKE =
  /^(CERT_|UNABLE_TO_|ERR_TLS_CERT_|ERR_SSL_TLSV1_ALERT_|ERR_SSL_SSLV3_ALERT_HANDSHAKE)/;
const PROXY_REFUSED = /Proxy response \(\d+\) !== 200 when HTTP Tunneling/;

/** True only when the error proves the request never left this machine. */
export function beforeSending(error: unknown): boolean {
  const codes: string[] = [];
  let proxyRefused = false;
  const walk = (e: unknown, depth: number) => {
    if (!e || typeof e !== 'object' || depth > 6) return;
    const { code, message, cause, errors } = e as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (typeof code === 'string') codes.push(code);
    if (typeof message === 'string' && PROXY_REFUSED.test(message))
      proxyRefused = true;
    if (Array.isArray(errors)) for (const x of errors) walk(x, depth + 1);
    walk(cause, depth + 1);
  };
  walk(error, 0);
  if (proxyRefused) return true;
  return (
    codes.length > 0 &&
    codes.every((c) => BEFORE_SENDING.has(c) || TLS_HANDSHAKE.test(c))
  );
}

/** What a write did, in words, for its error messages. */
function writeName(call: Call): string {
  if (call.method === 'PATCH') return 'update';
  return call.path.includes('(') ? 'new line' : 'create';
}

const CHECK_FIRST =
  'Check with `priority-axi show` or `priority-axi get` before sending it again. Do not retry.';

/** The sentence for a write whose outcome is unknown once it was sent. */
export function maySaved(call: Call, what: string): string {
  return `${what}, so Priority may have saved the ${writeName(call)}. ${CHECK_FIRST}`;
}

/** Read the body, at most MAX_ANSWER_BYTES. */
async function readBody(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => {});
      throw new TooLarge(total);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

class TooLarge extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    super('too large');
    this.bytes = bytes;
  }
}

async function once(
  settings: Settings,
  call: Call,
  deps: HttpDeps,
): Promise<Answer> {
  if (call.method !== 'GET' && call.path.includes('%')) {
    throw new AxiError(
      'internal_error',
      'A write path must not be percent-encoded.',
    );
  }
  const write = call.method !== 'GET';
  const left = timeLeft(settings, deps);
  if (write && left + 1000 < WRITE_MIN_MS) {
    throw new AxiError(
      'unreachable',
      `Only ${Math.max(0, Math.floor((left + 1000) / 1000))} s are left before this command's deadline (COMIS_DEADLINE): not enough time for the owner's approval hold, so nothing was sent. Run it in a worker, which has more time.`,
    );
  }
  if (!write && left <= 0) {
    throw new AxiError(
      'unreachable',
      `The time for this command ran out before Priority was asked. ${WORKER}`,
    );
  }
  const base = write
    ? (deps.timeouts?.write ?? WRITE_TIMEOUT_MS)
    : (deps.timeouts?.read ?? READ_TIMEOUT_MS);
  const timeout = Math.min(base, left);
  const capped = left < base;
  const seconds = Math.max(1, Math.round(timeout / 1000));
  const timedOutText = () =>
    write
      ? maySaved(
          call,
          `Priority did not answer within ${seconds} s after the ${writeName(call)} was sent`,
        )
      : capped
        ? `Priority did not answer within the ${seconds} s left before this command's deadline. ${WORKER}`
        : `Priority did not answer within ${seconds} s. Filter large document screens, or read fewer records.`;
  const url = `${serviceRoot(settings)}/${call.path}${call.query ?? ''}`;
  const started = performance.now();
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: call.method,
      headers: headers(settings, call.body !== undefined),
      ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    if (timedOut) throw new AxiError('unreachable', timedOutText());
    if (beforeSending(error)) {
      throw new AxiError(
        'unreachable',
        `Priority could not be reached${write ? ', so nothing was sent' : ''}. Check the address, or whether the Gate is running.`,
      );
    }
    throw new AxiError(
      'unreachable',
      write
        ? maySaved(
            call,
            `The connection to Priority broke after the ${writeName(call)} was sent`,
          )
        : 'The connection to Priority broke before it answered. Try again; if it fails again, check the address or whether the Gate is running.',
    );
  }
  let buffer: Buffer;
  try {
    buffer = await readBody(response);
  } catch (error) {
    if (error instanceof TooLarge) {
      throw new AxiError(
        'output_too_large',
        write
          ? maySaved(
              call,
              `Priority's answer is over ${MAX_ANSWER_BYTES / 2 ** 20} MB, more than priority-axi reads`,
            )
          : `Priority's answer is over ${MAX_ANSWER_BYTES / 2 ** 20} MB, more than priority-axi reads. Read less with --where, --fields, fewer --with sub-screens or a smaller --limit.`,
        { limit: MAX_ANSWER_BYTES },
      );
    }
    if (error instanceof Error && error.name === 'TimeoutError')
      throw new AxiError('unreachable', timedOutText());
    // Priority 23.1 can drop the connection part way through an answer.
    throw new AxiError(
      'unreachable',
      write
        ? maySaved(
            call,
            `Priority broke off its answer to the ${writeName(call)}`,
          )
        : 'Priority broke off its answer part way through. Try again with a smaller --limit or fewer --with sub-screens.',
    );
  }
  const text = buffer.toString('utf8');
  let json: unknown;
  let malformed = false;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
    malformed = true;
  }
  return {
    status: response.status,
    headers: response.headers,
    json,
    malformed,
    ...(malformed ? { text: text.slice(0, 8000) } : {}),
    bytes: buffer.length,
    ms: Math.round(performance.now() - started),
  };
}

/** Send a call and return the answer, or throw the classified error. */
export async function send(
  settings: Settings,
  call: Call,
  deps: HttpDeps = defaultDeps,
): Promise<Answer> {
  let answer = await once(settings, call, deps);
  if (answer.status === 429 && call.method === 'GET') {
    const wait = Number(answer.headers.get('retry-after') ?? '');
    if (
      Number.isFinite(wait) &&
      wait >= 0 &&
      wait <= MAX_RETRY_AFTER_S &&
      wait * 1000 < timeLeft(settings, deps)
    ) {
      await deps.sleep(wait * 1000);
      answer = await once(settings, call, deps);
    }
  }
  if (answer.status >= 300 && answer.status < 400) {
    throw new AxiError(
      'priority_error',
      `Priority answered with a redirect (${answer.status}), which priority-axi does not follow.`,
    );
  }
  const error = classify(answer, {
    company: settings.company,
    method: call.method,
    ...call.context,
  });
  if (error && call.method !== 'GET' && error.code === 'priority_error') {
    // A server or proxy failure after the write went out: it may have landed.
    const said = /[.!?]$/.test(error.message)
      ? error.message
      : `${error.message}.`;
    throw new AxiError(
      error.code,
      `${said} Priority may have saved the ${writeName(call)} anyway. ${CHECK_FIRST}`,
      error.fields,
    );
  }
  if (error) throw error;
  return answer;
}

/** The "value" array of a collection answer. */
export function rowsOf(answer: Answer): Record<string, unknown>[] {
  if (answer.malformed) {
    throw new AxiError(
      'priority_error',
      `Priority sent an incomplete answer (${answer.bytes} bytes). Try again with a smaller --limit or fewer --with sub-screens.`,
    );
  }
  const value = (answer.json as { value?: unknown } | undefined)?.value;
  if (
    !Array.isArray(value) ||
    value.some((r) => !r || typeof r !== 'object' || Array.isArray(r))
  ) {
    throw new AxiError(
      'priority_error',
      'Priority returned a collection priority-axi cannot read.',
    );
  }
  return value as Record<string, unknown>[];
}

/** The "value" string of a function answer such as GetPriorityVersion(). */
export function stringValue(answer: Answer, what: string): string {
  const value = (answer.json as { value?: unknown } | undefined)?.value;
  if (typeof value !== 'string' || !value) {
    throw new AxiError('priority_error', `Priority returned no ${what}.`);
  }
  return value;
}
