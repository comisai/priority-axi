// create: check everything against the index, build one deep-insert body,
// and send it once. Inside Comis the Gate holds it for the owner's approval.

import { readFileSync } from 'node:fs';
import type { CommandInput } from '../cli/table.ts';
import { serviceRoot } from '../config.ts';
import { AxiError, usage } from '../errors.ts';
import { send } from '../http.ts';
import {
  type Field,
  type Resolved,
  resolveField,
  resolveScreen,
  resolveSub,
  type ScreenIndex,
  type ScreenType,
} from '../index/build.ts';
import { recordReach } from '../index/cache.ts';
import { parseWhere, screenSegment, utc } from '../odata.ts';
import { defaultColumns, tableRow } from '../output/shape.ts';
import { render } from '../output/toon.ts';
import {
  open,
  screenIndex,
  shellWord,
  str,
  strings,
  tokenLine,
} from './common.ts';

type Body = Record<string, unknown>;

const INTEGER = new Set(['Int16', 'Int32', 'Int64', 'Byte', 'SByte']);
const DECIMAL = new Set(['Decimal', 'Double', 'Single']);

function writable(field: Field, where: string): void {
  if (field.readOnly)
    throw usage(`${field.name} is read-only in ${where}; Priority fills it.`);
  if (field.internalId)
    throw usage(
      `${field.name} is an internal ID in ${where}; Priority assigns it.`,
    );
}

/** Convert one value to the JSON type Priority expects for this field. */
export function typedValue(field: Field, raw: string, where: string): unknown {
  writable(field, where);
  if (field.type === 'String') {
    const length = [...raw].length;
    if (field.max !== undefined && length > field.max) {
      throw usage(
        `${field.name} holds at most ${field.max} characters; the value has ${length}.`,
      );
    }
    return raw;
  }
  if (INTEGER.has(field.type)) {
    const n = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(n))
      throw usage(`${field.name} is a whole number.`);
    return n;
  }
  if (DECIMAL.has(field.type)) {
    if (!/^-?\d+(\.\d+)?$/.test(raw))
      throw usage(
        `${field.name} is a number; write it with a point, such as 12.50.`,
      );
    return Number(raw);
  }
  if (field.type === 'Boolean') {
    if (raw !== 'true' && raw !== 'false')
      throw usage(`${field.name} is true or false.`);
    return raw === 'true';
  }
  if (field.type === 'DateTimeOffset') return utc(raw, field.name);
  throw usage(`${field.name} has type ${field.type}, which create cannot set.`);
}

function assign(
  type: ScreenType,
  where: string,
  target: Body,
  term: string,
): void {
  const t = parseWhere(term);
  if (t.op !== '=')
    throw usage(`Set fields with FIELD=VALUE; ${t.field} uses ${t.op}.`);
  const field = resolveField(type, where, t.field);
  if (field.name in target)
    throw usage(`${field.name} is set more than once in ${where}.`);
  target[field.name] = typedValue(field, t.value, where);
}

interface Line {
  sub: ReturnType<typeof resolveSub>;
  body: Body;
}

/** Build the body from --set and --line flags, in the order given. */
function fromFlags(
  index: ScreenIndex,
  screen: Resolved,
  input: CommandInput,
): { body: Body; lines: Line[] } {
  const body: Body = {};
  const lines: Line[] = [];
  let current: Line | undefined;
  let screenSeen = false;
  for (const token of input.tokens) {
    if (token.kind === 'positional') {
      if (!screenSeen) {
        screenSeen = true;
        continue;
      }
      if (!current) {
        throw usage(
          'A FIELD=VALUE after the screen belongs to a --line <SUB>. Use --set FIELD=VALUE for the record itself.',
        );
      }
      assign(
        current.sub.def,
        `${screen.name} > ${current.sub.name}`,
        current.body,
        token.value,
      );
      continue;
    }
    if (token.name === 'set') {
      current = undefined;
      assign(screen.type, screen.name, body, token.value ?? '');
    } else if (token.name === 'line') {
      current = { sub: resolveSub(index, screen, token.value ?? ''), body: {} };
      lines.push(current);
    } else {
      current = undefined;
    }
  }
  return { body, lines };
}

const scalar = (value: unknown, where: string): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  throw usage(
    `${where}: each value must be text, a number or true/false. Leave out fields with no value.`,
  );
};

/** Build the body from a JSON file of the same shape, through the same checks. */
function fromFile(
  index: ScreenIndex,
  screen: Resolved,
  path: string,
): { body: Body; lines: Line[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw usage('--json-file must name a readable JSON file.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw usage('--json-file must hold one JSON object.');
  const body: Body = {};
  const lines: Line[] = [];
  for (const [name, value] of Object.entries(raw as Body)) {
    const isSub = screen.type.subs.some(
      (s) => s.nav === name || s.name === name,
    );
    if (!isSub) {
      const field = resolveField(screen.type, screen.name, name);
      body[field.name] = typedValue(
        field,
        scalar(value, field.name),
        screen.name,
      );
      continue;
    }
    const sub = resolveSub(index, screen, name);
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw usage(`${sub.nav} must hold objects of FIELD: value.`);
      }
      const line: Body = {};
      for (const [f, v] of Object.entries(item as Body)) {
        const field = resolveField(sub.def, `${screen.name} > ${sub.name}`, f);
        line[field.name] = typedValue(
          field,
          scalar(v, field.name),
          `${screen.name} > ${sub.name}`,
        );
      }
      lines.push({ sub, body: line });
    }
  }
  return { body, lines };
}

function assemble(body: Body, lines: Line[]): Body {
  const out: Body = { ...body };
  for (const { sub, body: line } of lines) {
    if (!Object.keys(line).length)
      throw usage(`--line ${sub.name} needs at least one FIELD=VALUE.`);
    if (sub.many) {
      const list = (out[sub.nav] as Body[] | undefined) ?? [];
      list.push(line);
      out[sub.nav] = list;
    } else {
      if (out[sub.nav])
        throw usage(`${sub.name} holds one record; give it one --line.`);
      out[sub.nav] = line;
    }
  }
  return out;
}

export async function create(input: CommandInput): Promise<string> {
  const s = open(input);
  const { index } = await screenIndex(s);
  const screen = resolveScreen(index, input.positionals[0] ?? '');
  const file = str(input.values['json-file']);
  const flagged =
    strings(input.values.set).length > 0 ||
    strings(input.values.line).length > 0 ||
    input.positionals.length > 1;
  if (file && flagged)
    throw usage('Use --json-file or --set/--line, not both.');
  const { body, lines } = file
    ? fromFile(index, screen, file)
    : fromFlags(index, screen, input);
  const payload = assemble(body, lines);
  if (!Object.keys(payload).length)
    throw usage(
      'Nothing to create: give --set FIELD=VALUE or --json-file <path>.',
    );
  const transactions = 1 + lines.length;
  const path = `${new URL(serviceRoot(s.settings)).pathname}/${screenSegment(screen.name)}`;

  if (input.values['dry-run'] === true) {
    return render(
      { dry_run: true, request: `POST ${path}`, body: payload, transactions },
      [
        `Run \`${tokenLine('create', input.tokens, ['dry-run'])}\` to send it; inside Comis the owner approves it first`,
      ],
    );
  }

  const now = input.io.now();
  let answer: Awaited<ReturnType<typeof send>>;
  try {
    // Sent once. A write is never retried; a held write is waited on with comis action wait.
    answer = await send(
      s.settings,
      {
        method: 'POST',
        path: screenSegment(screen.name),
        body: payload,
        context: { screen: screen.name },
      },
      input.io.http,
    );
  } catch (error) {
    if (error instanceof AxiError && error.code === 'screen_not_enabled')
      recordReach(s.dir, screen.name, 'no', now);
    throw error;
  }
  recordReach(s.dir, screen.name, 'yes', now);
  const record =
    answer.json && typeof answer.json === 'object' ? (answer.json as Body) : {};
  const keys = screen.type.key.filter(
    (k) => record[k] !== undefined && record[k] !== null && record[k] !== '',
  );
  const keyText = keys.map((k) => String(record[k])).join(', ');
  const columns = defaultColumns(screen.type, [record]);
  return render(
    {
      created: screen.name,
      key: keyText || null,
      transactions,
      record: tableRow(screen.type, record, columns, 500),
    },
    keys.length === 1 && screen.type.key.length === 1
      ? [
          `Run \`priority-axi show ${screen.name} ${shellWord(keyText)}\` to read it`,
        ]
      : [],
  );
}
