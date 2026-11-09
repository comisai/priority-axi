// HTTP to Priority, directly or through the Gate (HTTPS_PROXY with
// NODE_USE_ENV_PROXY=1, set by the Comis wrapper). Reads may be retried once
// after a short 429. Writes are sent once and never retried, whatever happens.

import { type Settings, serviceRoot } from './config.ts';
import { AxiError, type ClassifyContext, classify } from './errors.ts';
import { VERSION } from './version.ts';

export const READ_TIMEOUT_MS = 90_000;
/** Longer than the Gate's 45 s approval hold. */
export const WRITE_TIMEOUT_MS = 120_000;
const MAX_RETRY_AFTER_S = 15;

export interface HttpDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
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
  method: 'GET' | 'POST';
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
  const url = `${serviceRoot(settings)}/${call.path}${call.query ?? ''}`;
  const timeout = call.method === 'GET' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS;
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
    throw new AxiError(
      'unreachable',
      timedOut
        ? `Priority did not answer within ${timeout / 1000} s.`
        : 'Priority could not be reached. Check the address, or whether the Gate is running.',
    );
  }
  let buffer: Buffer;
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } catch {
    // Priority 23.1 can drop the connection part way through an answer.
    throw new AxiError(
      'unreachable',
      call.method === 'GET'
        ? 'Priority broke off its answer part way through. Try again with a smaller --limit or fewer --with sub-screens.'
        : 'Priority broke off its answer to the create, so it may have been saved. Check with priority-axi get or show before creating it again.',
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
    if (Number.isFinite(wait) && wait >= 0 && wait <= MAX_RETRY_AFTER_S) {
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
    ...call.context,
  });
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
