// get, changes and show: reads through $filter, never with a key in the path.

import type { CommandInput } from '../cli/table.ts';
import { AxiError, usage } from '../errors.ts';
import { rowsOf } from '../http.ts';
import {
  type Resolved,
  resolveField,
  resolveScreen,
  resolveSub,
  type ScreenIndex,
  type ScreenType,
  type SubLink,
} from '../index/build.ts';
import {
  combineFilters,
  literal,
  orderBy,
  parseWhere,
  queryString,
  whereToFilter,
} from '../odata.ts';
import { defaultColumns, recordView, tableRow } from '../output/shape.ts';
import { bounded, render } from '../output/toon.ts';
import {
  builtNote,
  commandLine,
  intFlag,
  open,
  readScreen,
  screenIndex,
  shellWord,
  sinceFlag,
  str,
  strings,
} from './common.ts';

/** Fields asked for when no --fields is given: the key and the first candidates in form order. */
const CANDIDATES = 12;
/** Sub-screen lines shown per record without --full. */
const LINES = 5;

type Sub = SubLink & { def: ScreenType };
type Row = Record<string, unknown>;

function candidateSelect(type: ScreenType): string[] {
  const keys = type.key.filter((k) => type.fields.some((f) => f.name === k));
  const rest = type.fields
    .filter((f) => !f.internalId && !keys.includes(f.name))
    .slice(0, CANDIDATES)
    .map((f) => f.name);
  return [...keys, ...rest];
}

/**
 * $expand for --with. Without --full, each line list is narrowed and capped on
 * the server: Priority 23.1 honours $select and $top inside $expand (live S9),
 * so a large order does not send every line. One extra line shows that more exist.
 */
function expandOf(subs: readonly Sub[], full: boolean): string | undefined {
  if (!subs.length) return undefined;
  return subs
    .map((x) =>
      !x.many || full
        ? x.nav
        : `${x.nav}($select=${candidateSelect(x.def).join(',')};$top=${LINES + 1})`,
    )
    .join(',');
}

function explicitFields(
  type: ScreenType,
  screen: string,
  raw: string | undefined,
): string[] | undefined {
  if (raw === undefined) return undefined;
  const names = raw
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  if (!names.length)
    throw usage('--fields needs field names, such as --fields CUSTNAME,CDES.');
  const keys = type.key.filter((k) => type.fields.some((f) => f.name === k));
  const chosen = names.map((n) => resolveField(type, screen, n).name);
  return [...keys, ...chosen.filter((n) => !keys.includes(n))];
}

/** Lines of one sub-screen in a record, as a small table or one record. */
function subView(
  sub: Sub,
  value: unknown,
  fieldLimit: number,
  full: boolean,
): Record<string, unknown> {
  if (!sub.many) {
    const one =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Row)
        : undefined;
    return { [sub.name]: one ? recordView(sub.def, one, fieldLimit) : null };
  }
  const lines = Array.isArray(value) ? (value as Row[]) : [];
  const shown = full ? lines : lines.slice(0, LINES);
  const columns = defaultColumns(sub.def, shown);
  return {
    [sub.name]: shown.map((line) =>
      tableRow(sub.def, line, columns, fieldLimit),
    ),
    ...(shown.length < lines.length
      ? { [`${sub.name}_more`]: 'more lines exist; --full shows all' }
      : {}),
  };
}

function resolveWith(
  index: ScreenIndex,
  screen: Resolved,
  raw: unknown,
): Sub[] {
  const subs = strings(raw).map((w) => resolveSub(index, screen, w));
  return subs.filter(
    (sub, i) => subs.findIndex((x) => x.nav === sub.nav) === i,
  );
}

async function list(
  input: CommandInput,
  mode: 'get' | 'changes',
): Promise<string> {
  const s = open(input);
  const loaded = await screenIndex(s);
  const { index } = loaded;
  const screen = resolveScreen(index, input.positionals[0] ?? '');
  const v = input.values;
  const limit = intFlag(v.limit, 'limit', 20, 1, 500);
  const page = intFlag(v.page, 'page', 1, 1, 1_000_000);
  const full = v.full === true;
  const since =
    mode === 'changes' ? sinceFlag(v.since, input.io.now()) : undefined;
  const filter = combineFilters(
    whereToFilter(strings(v.where), screen.type, screen.name),
    str(v.filter),
  );
  const keys = screen.type.key.filter((k) =>
    screen.type.fields.some((f) => f.name === k),
  );
  const order = str(v.sort)
    ? orderBy(String(v.sort), screen.type, screen.name)
    : keys.join(',') || undefined;
  const explicit = explicitFields(screen.type, screen.name, str(v.fields));
  const subs = resolveWith(index, screen, v.with);
  const select = explicit ?? (full ? undefined : candidateSelect(screen.type));

  const answer = await readScreen(
    s,
    screen.name,
    queryString({
      $filter: filter,
      $select: select?.join(','),
      $orderby: order,
      $top: limit + 1,
      $skip: page > 1 ? (page - 1) * limit : undefined,
      $expand: expandOf(subs, full),
      $since: since,
    }),
  );
  const fetched = rowsOf(answer);
  const more = fetched.length > limit;
  const rows = fetched.slice(0, limit);
  const columns =
    explicit ??
    (full
      ? screen.type.fields
          .filter(
            (f) =>
              keys.includes(f.name) ||
              (!f.internalId &&
                rows.some(
                  (r) =>
                    r[f.name] !== null &&
                    r[f.name] !== '' &&
                    r[f.name] !== undefined,
                )),
          )
          .map((f) => f.name)
      : defaultColumns(screen.type, rows));

  const noun = rows.length === 1 ? 'record' : 'records';
  const place = mode === 'changes' ? ` changed since ${since}` : '';
  const pageNote = page > 1 ? ` (page ${page})` : '';
  const summary = `${rows.length} ${noun} from ${screen.name}${place}${pageNote}${more ? ', more exist' : ''}`;

  if (!rows.length) {
    const help =
      filter || since
        ? [
            `Run \`priority-axi fields ${screen.name}\` to check value types if you expected records; the filter's field names are valid, so no record matched`,
          ]
        : [];
    return render({ summary, ...builtNote(loaded) }, help);
  }

  return bounded(
    {
      total: rows.length,
      narrower: commandLine(mode, [screen.name], v, {
        full: null,
        limit: '20',
      }),
      build: (shown, fieldLimit) => {
        const records = rows.slice(0, shown).map((row) => {
          const base = tableRow(screen.type, row, columns, fieldLimit);
          for (const sub of subs) {
            Object.assign(base, subView(sub, row[sub.nav], fieldLimit, full));
          }
          return base;
        });
        const help: string[] = [];
        if (more) {
          help.push(
            `Run \`${commandLine(mode, [screen.name], v, { page: String(page + 1) })}\` for the next ${limit}`,
          );
        }
        if (keys.length === 1) {
          help.push(
            `Run \`priority-axi show ${screen.name} <${keys[0]}>\` for one record`,
          );
        }
        return render(
          {
            summary,
            ...builtNote(loaded),
            records,
            ...(shown < rows.length
              ? {
                  omitted: `${rows.length - shown} records not shown; use --limit ${Math.max(1, shown)} or --full`,
                }
              : {}),
          },
          help,
        );
      },
    },
    full,
  );
}

export const get = (input: CommandInput) => list(input, 'get');
export const changes = (input: CommandInput) => list(input, 'changes');

/** Key terms from a positional value (one-field keys) or --key F=V flags (compound keys). */
function keyTerms(
  screen: Resolved,
  positional: string | undefined,
  flags: string[],
): Array<[string, string]> {
  const keys = screen.type.key.filter((k) =>
    screen.type.fields.some((f) => f.name === k),
  );
  if (!keys.length) {
    throw usage(
      `${screen.name} has no key. Use \`priority-axi get ${screen.name} --where F=V\` instead.`,
    );
  }
  if (positional !== undefined && flags.length)
    throw usage('Give the key as an argument or with --key, not both.');
  if (positional !== undefined) {
    if (keys.length > 1) {
      throw usage(
        `${screen.name} has a compound key (${keys.join(', ')}). Use ${keys.map((k) => `--key ${k}=<value>`).join(' ')}.`,
      );
    }
    return [[keys[0] ?? '', positional]];
  }
  if (!flags.length) {
    throw usage(
      keys.length === 1
        ? `Missing the ${keys[0]} value: priority-axi show ${screen.name} <${keys[0]}>.`
        : `Missing the key: ${keys.map((k) => `--key ${k}=<value>`).join(' ')}.`,
    );
  }
  const terms = flags.map((flag) => {
    const term = parseWhere(flag);
    if (term.op !== '=') throw usage('--key takes FIELD=VALUE.');
    return [
      resolveField(screen.type, screen.name, term.field).name,
      term.value,
    ] as [string, string];
  });
  const named = terms.map(([f]) => f);
  const missing = keys.filter((k) => !named.includes(k));
  const extra = named.filter((f) => !keys.includes(f));
  if (missing.length || extra.length || new Set(named).size !== named.length) {
    throw usage(
      `${screen.name}'s key is ${keys.join(', ')}; give each exactly once with --key.`,
    );
  }
  return terms;
}

export async function show(input: CommandInput): Promise<string> {
  const s = open(input);
  const { index } = await screenIndex(s);
  const screen = resolveScreen(index, input.positionals[0] ?? '');
  const v = input.values;
  const full = v.full === true;
  const all = v.all === true;
  const terms = keyTerms(screen, input.positionals[1], strings(v.key));
  const fieldOf = (name: string) =>
    screen.type.fields.find((f) => f.name === name);
  const filter = terms
    .map(([name, value]) => {
      const field = fieldOf(name);
      if (!field) throw usage(`${screen.name} has no field ${name}.`);
      return `${name} eq ${literal(field, value)}`;
    })
    .join(' and ');
  const subs = resolveWith(index, screen, v.with);
  const answer = await readScreen(
    s,
    screen.name,
    queryString({
      $filter: filter,
      $top: 2,
      $expand: expandOf(subs, full),
    }),
  );
  const rows = rowsOf(answer);
  const keyText = terms.map(([f, value]) => `${f} ${value}`).join(', ');
  if (!rows.length) {
    throw new AxiError(
      'not_found',
      `No ${screen.name} record has ${keyText}. Run \`priority-axi get ${screen.name} --limit 5\` to see records.`,
      { screen: screen.name },
    );
  }
  if (rows.length > 1) {
    throw new AxiError(
      'priority_rejected',
      `More than one ${screen.name} record has ${keyText}.`,
      {
        screen: screen.name,
      },
    );
  }
  const row = rows[0] ?? {};
  const keyNames = terms.map(([f]) => f);
  const fullCommand = commandLine('show', input.positionals, v, { full: '' });

  return bounded(
    {
      total: screen.type.fields.length,
      narrower: `priority-axi show ${input.positionals.map(shellWord).join(' ')}`,
      build: (shown, fieldLimit) => {
        const view = recordView(screen.type, row, fieldLimit, all);
        const ordered: Row = {};
        for (const k of keyNames) if (k in view) ordered[k] = view[k];
        for (const [k, value] of Object.entries(view))
          if (!(k in ordered)) ordered[k] = value;
        const entries = Object.entries(ordered);
        const record = Object.fromEntries(entries.slice(0, shown));
        const omitted = entries.length - Math.min(shown, entries.length);
        const lines: Row = {};
        for (const sub of subs) {
          Object.assign(lines, subView(sub, row[sub.nav], fieldLimit, full));
        }
        // Fields cut at the standard 500 carry their own marker; say more only
        // when fields were dropped or cut shorter to fit.
        const shortened = omitted > 0 || fieldLimit < 500;
        return render({
          screen: screen.name,
          record,
          ...lines,
          ...(shortened
            ? {
                more: `${omitted ? `${omitted} more fields; ` : ''}run ${fullCommand}`,
              }
            : {}),
        });
      },
    },
    full,
  );
}
