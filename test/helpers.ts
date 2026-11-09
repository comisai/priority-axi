import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Io } from '../src/cli/table.ts';

export const FIXTURE: unknown = JSON.parse(
  readFileSync(
    new URL('./fixtures/metadata.min.json', import.meta.url),
    'utf8',
  ),
);
export const NOW = new Date('2026-11-05T12:00:00.000Z');
export const ORIGIN = 'https://erp.example.com';
export const ROOT = `${ORIGIN}/odata/Priority/tabula.ini/demo`;
export const PASSWORD = 'placeholder-pass-1';

export function json(
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export type Route = (
  url: URL,
  init: RequestInit,
) => Response | Promise<Response>;

export interface Call {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Standard answers for company "demo" on Priority 23.1. */
export function standardRoutes(): Record<string, Route> {
  return {
    'GetPriorityVersion()': () => json(200, { value: '23.1' }),
    GETCOMPANIES: () =>
      json(200, { value: [{ NAME: 'demo', TITLE: 'Demo Ltd' }] }),
    $metadata: () => json(200, FIXTURE),
  };
}

export function fakeFetch(
  routes: Record<string, Route>,
  calls: Call[] = [],
): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(
      url.pathname.replace(/^\/odata\/Priority\/[^/]+\/[^/]+\//, ''),
    );
    calls.push({
      url: url.toString(),
      path,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
    });
    const route = routes[path];
    return route ? route(url, init) : new Response(null, { status: 404 });
  }) as typeof fetch;
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'priority-axi-test-'));
}

export function makeIo(
  routes: Record<string, Route> = standardRoutes(),
  env: Record<string, string | undefined> = {},
): { io: Io; output: () => string; calls: Call[]; sleeps: number[] } {
  const chunks: string[] = [];
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const io: Io = {
    stdout: (text) => {
      chunks.push(text);
    },
    env: {
      PRIORITY_URL: ROOT,
      PRIORITY_USER: 'user_a',
      PRIORITY_PASSWORD: PASSWORD,
      XDG_CACHE_HOME: tempDir(),
      ...env,
    },
    now: () => NOW,
    http: {
      fetch: fakeFetch(routes, calls),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  };
  return { io, output: () => chunks.join(''), calls, sleeps };
}

/** The binary under test: dist when PRIORITY_AXI_BIN=dist, else the TypeScript source. */
export const BIN =
  process.env.PRIORITY_AXI_BIN === 'dist'
    ? new URL('../dist/bin/priority-axi.js', import.meta.url).pathname
    : new URL('../src/bin/priority-axi.ts', import.meta.url).pathname;

/** Run the binary as a separate process with only the given environment and closed stdin. */
export function runBinary(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [BIN, ...args],
      { env: { PATH: process.env.PATH ?? '', ...env } },
      (error, stdout, stderr) => {
        resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
      },
    );
    child.stdin?.end();
  });
}
