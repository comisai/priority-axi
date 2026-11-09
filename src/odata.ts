// OData request building: --where to $filter, typed literals, query strings
// and paths. Paths are built only from names checked against the index, so a
// write path never needs percent-encoding (the Gate refuses those).

import { AxiError, usage } from './errors.ts';
import { type Field, resolveField, type ScreenType } from './index/build.ts';

const OPERATORS: Record<string, string> = {
  '=': 'eq',
  '!=': 'ne',
  '>': 'gt',
  '>=': 'ge',
  '<': 'lt',
  '<=': 'le',
};
const WHERE = /^([A-Za-z][A-Za-z0-9_]*)\s*(!=|>=|<=|=|>|<|~)\s?([\s\S]*)$/;
const WHERE_HELP =
  'use FIELD=VALUE, FIELD!=VALUE, FIELD>VALUE, FIELD>=VALUE, FIELD<VALUE or FIELD<=VALUE';

export interface WhereTerm {
  field: string;
  op: string;
  value: string;
}

export function parseWhere(expr: string): WhereTerm {
  const m = WHERE.exec(expr);
  if (!m?.[1] || !m[2] || m[3] === undefined)
    throw usage(`Invalid --where; ${WHERE_HELP}.`);
  return { field: m[1], op: m[2], value: m[3] };
}

const INTEGER = new Set(['Int16', 'Int32', 'Int64', 'Byte', 'SByte']);
const DECIMAL = new Set(['Decimal', 'Double', 'Single']);
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** A UTC timestamp with seconds and Z, as Priority recommends for filters. */
export function utc(raw: string, flag: string): string {
  const day = DAY.exec(raw);
  let ms: number;
  if (day) {
    ms = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    if (new Date(ms).toISOString().slice(0, 10) !== raw) ms = Number.NaN;
  } else {
    ms = TIME.test(raw) ? Date.parse(raw) : Number.NaN;
  }
  if (!Number.isFinite(ms)) {
    throw usage(
      `Invalid date for ${flag}; use YYYY-MM-DD or a full time such as 2026-10-01T08:00:00Z.`,
    );
  }
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** An OData literal for a value of this field's type. */
export function literal(field: Field, raw: string): string {
  if (field.type === 'String') return `'${raw.replace(/'/g, "''")}'`;
  if (INTEGER.has(field.type)) {
    if (!/^-?\d+$/.test(raw))
      throw usage(`${field.name} is a whole number; the --where value is not.`);
    return raw;
  }
  if (DECIMAL.has(field.type)) {
    if (!/^-?\d+(\.\d+)?$/.test(raw)) {
      throw usage(
        `${field.name} is a number; write it with a point, such as 12.50.`,
      );
    }
    return raw;
  }
  if (field.type === 'Boolean') {
    if (raw !== 'true' && raw !== 'false')
      throw usage(`${field.name} is true or false.`);
    return raw;
  }
  if (field.type === 'DateTimeOffset' || field.type === 'Date')
    return utc(raw, `--where ${field.name}`);
  throw usage(
    `--where cannot filter ${field.name} (${field.type}); use --filter with raw OData.`,
  );
}

export function whereToFilter(
  wheres: readonly string[],
  type: ScreenType,
  screenName: string,
): string | undefined {
  const parts = wheres.map((expr) => {
    const term = parseWhere(expr);
    const field = resolveField(type, screenName, term.field);
    if (term.op === '~') {
      // QA (Priority 23.1) answers 501 to both contains() and startswith(),
      // so ~ is refused before a request is spent on it.
      throw usage(
        `Priority does not support contains, so --where has no ~. For text that starts with ABC, use a range: --where '${field.name}>=ABC' --where '${field.name}<ABD'.`,
      );
    }
    return `${field.name} ${OPERATORS[term.op]} ${literal(field, term.value)}`;
  });
  return parts.length ? parts.join(' and ') : undefined;
}

export function combineFilters(
  where: string | undefined,
  raw: string | undefined,
): string | undefined {
  if (raw !== undefined && !raw.trim()) throw usage('--filter is empty.');
  if (where && raw) return `${where} and (${raw})`;
  return where ?? raw;
}

/** --sort F or F:desc. */
export function orderBy(
  sort: string,
  type: ScreenType,
  screenName: string,
): string {
  const m = /^([A-Za-z][A-Za-z0-9_]*)(?::(asc|desc))?$/i.exec(sort);
  if (!m?.[1]) throw usage('Invalid --sort; use FIELD or FIELD:desc.');
  const field = resolveField(type, screenName, m[1]);
  return m[2]?.toLowerCase() === 'desc' ? `${field.name} desc` : field.name;
}

/** "?$top=5&$filter=..." with each value encoded; option names stay literal. */
export function queryString(
  params: Record<string, string | number | undefined>,
): string {
  const parts = Object.entries(params)
    .filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined,
    )
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/** A path segment for a screen name already resolved from the index. */
export function screenSegment(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    throw new AxiError(
      'internal_error',
      'A screen name reached the request builder without being checked.',
    );
  }
  return name;
}
