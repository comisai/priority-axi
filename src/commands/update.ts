// update, add-line and update-line: change a record that exists. Each checks
// its fields against the index and sends one request, which inside Comis the
// Gate holds for the owner's approval. A record is named by its key in the
// path, NAME('KEY'), the only form the Gate's record type takes.

import type { CommandInput } from '../cli/table.ts';
import { serviceRoot } from '../config.ts';
import { usage } from '../errors.ts';
import { type Answer, send } from '../http.ts';
import {
  type Resolved,
  resolveScreen,
  resolveSub,
  type ScreenType,
} from '../index/build.ts';
import { recordSegment } from '../odata.ts';
import { defaultColumns, tableRow } from '../output/shape.ts';
import { render } from '../output/toon.ts';
import { open, screenIndex, strings, tokenLine } from './common.ts';
import { assign } from './create.ts';

type Body = Record<string, unknown>;

function fields(type: ScreenType, where: string, terms: string[]): Body {
  const body: Body = {};
  for (const term of terms) assign(type, where, body, term);
  if (!Object.keys(body).length)
    throw usage('Nothing to change: give --set FIELD=VALUE.');
  for (const key of type.key)
    if (key in body)
      throw usage(`${key} names the record; an update cannot change it.`);
  return body;
}

function keyOf(input: CommandInput, at: number, what: string): string {
  const key = input.positionals[at] ?? '';
  if (!key) throw usage(`Give ${what}.`);
  return key;
}

interface Write {
  method: 'PATCH' | 'POST';
  screen: Resolved;
  path: string;
  body: Body;
  shown: ScreenType;
  done: string;
}

async function write(
  input: CommandInput,
  s: ReturnType<typeof open>,
  w: Write,
  command: string,
): Promise<string> {
  const root = new URL(serviceRoot(s.settings)).pathname;
  if (input.values['dry-run'] === true) {
    return render(
      {
        dry_run: true,
        request: `${w.method} ${root}/${w.path}`,
        body: w.body,
        transactions: 1,
      },
      [
        `Run \`${tokenLine(command, input.tokens, ['dry-run'])}\` to send it; inside Comis the owner approves it first`,
      ],
    );
  }
  // Sent once. A write is never retried; a held write is waited on with comis action wait.
  const answer: Answer = await send(
    s.settings,
    {
      method: w.method,
      path: w.path,
      body: w.body,
      context: { screen: w.screen.name },
    },
    input.io.http,
  );
  const record =
    answer.json &&
    typeof answer.json === 'object' &&
    !Array.isArray(answer.json)
      ? (answer.json as Body)
      : undefined;
  return render(
    {
      [w.done]: w.screen.name,
      request: `${w.method} ${root}/${w.path}`,
      transactions: 1,
      record: record
        ? tableRow(w.shown, record, defaultColumns(w.shown, [record]), 500)
        : null,
    },
    [
      `Run \`priority-axi show ${w.screen.name} ${keyOf(input, 1, 'the key')} --with <SUB>\` to read it back`,
    ],
  );
}

/** update <SCREEN> <key> --set F=V: change fields of one record. */
export async function update(input: CommandInput): Promise<string> {
  const s = open(input);
  const { index } = await screenIndex(s);
  const screen = resolveScreen(index, input.positionals[0] ?? '');
  const key = keyOf(
    input,
    1,
    `the key of the ${screen.name} record after the screen`,
  );
  const body = fields(screen.type, screen.name, strings(input.values.set));
  return write(
    input,
    s,
    {
      method: 'PATCH',
      screen,
      path: recordSegment(screen.name, screen.type, key),
      body,
      shown: screen.type,
      done: 'updated',
    },
    'update',
  );
}

/** add-line <SCREEN> <key> <SUB> <F=V>...: add one line to a record. */
export async function addLine(input: CommandInput): Promise<string> {
  const s = open(input);
  const { index } = await screenIndex(s);
  const screen = resolveScreen(index, input.positionals[0] ?? '');
  const key = keyOf(
    input,
    1,
    `the key of the ${screen.name} record after the screen`,
  );
  const sub = resolveSub(
    index,
    screen,
    keyOf(input, 2, 'the sub-screen after the key'),
  );
  if (!sub.many)
    throw usage(
      `${screen.name} > ${sub.name} holds one record; change it with update-line.`,
    );
  const where = `${screen.name} > ${sub.name}`;
  const body: Body = {};
  for (const term of input.positionals.slice(3))
    assign(sub.def, where, body, term);
  if (!Object.keys(body).length)
    throw usage(
      `Give the new line's fields after ${sub.name}, as FIELD=VALUE.`,
    );
  return write(
    input,
    s,
    {
      method: 'POST',
      screen,
      path: `${recordSegment(screen.name, screen.type, key)}/${sub.nav}`,
      body,
      shown: sub.def,
      done: 'added',
    },
    'add-line',
  );
}

/** update-line <SCREEN> <key> <SUB> <line-key> --set F=V: change one line. */
export async function updateLine(input: CommandInput): Promise<string> {
  const s = open(input);
  const { index } = await screenIndex(s);
  const screen = resolveScreen(index, input.positionals[0] ?? '');
  const key = keyOf(
    input,
    1,
    `the key of the ${screen.name} record after the screen`,
  );
  const sub = resolveSub(
    index,
    screen,
    keyOf(input, 2, 'the sub-screen after the key'),
  );
  const line = keyOf(
    input,
    3,
    `the line's key after ${sub.name}, such as ${sub.def.key.map((k) => `${k}=1`).join(',') || 'its number'}`,
  );
  const where = `${screen.name} > ${sub.name}`;
  const body = fields(sub.def, where, strings(input.values.set));
  return write(
    input,
    s,
    {
      method: 'PATCH',
      screen,
      path: `${recordSegment(screen.name, screen.type, key)}/${recordSegment(sub.nav, sub.def, sub.def.key.length === 1 ? line.replace(new RegExp(`^${sub.def.key[0]}=`, 'i'), '') : line, true)}`,
      body,
      shown: sub.def,
      done: 'updated',
    },
    'update-line',
  );
}
