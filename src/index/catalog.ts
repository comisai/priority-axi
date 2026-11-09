// A local copy of one screen's key, description, unit, family and status
// columns, for `find`. Priority cannot search text (contains and startswith
// answer 501), so the catalog is pulled once, page by page, and searched
// locally. It is rebuilt after a day, or with --refresh. Like the index, it is
// derived data under the connection's cache directory.

import { join } from 'node:path';
import { usage } from '../errors.ts';
import { queryString } from '../odata.ts';
import type { Resolved, ScreenType, SubLink } from './build.ts';
import { readJson, writeJsonAtomic } from './cache.ts';

export const CATALOG_FORMAT = 1;
export const MAX_CATALOG_AGE_MS = 24 * 60 * 60 * 1000;
export const CATALOG_PAGE = 1000;
/** Pages read at once after the first, as the live sweep does. */
export const CATALOG_PARALLEL = 4;
/** Top-level records read at most; beyond this the catalog is marked partial. */
export const MAX_CATALOG_RECORDS = 200_000;

export interface Catalog {
  format: typeof CATALOG_FORMAT;
  builtAt: string;
  screen: string;
  sub?: string;
  /** Stored column names, in row order. */
  columns: string[];
  rows: unknown[][];
  /** Top-level records read; the rows of a sub-screen catalog are its lines. */
  records: number;
  partial?: true;
}

/** Which stored columns are searched, shown, and checked for an inactive status. */
export interface Layout {
  columns: string[];
  /** $select at the top level. */
  select: string[];
  /** $select inside the sub-screen's $expand. */
  subSelect?: string[];
  search: string[];
  show: string[];
  status: string[];
  /** The key of the level searched (sub-screen columns for --sub). */
  key: string[];
  /** The top-level key, for show hints. */
  parentKey: string[];
  /** The searched columns that belong to the record itself. */
  own: string[];
  /** Where the other searched columns come from: the parent (--sub) or the customer. */
  context: 'parent' | 'customer' | undefined;
}

const unique = (names: ReadonlyArray<string | undefined>): string[] => [
  ...new Set(names.filter((n): n is string => !!n)),
];

const has = (type: ScreenType, name: string) =>
  type.fields.some((f) => f.name === name);

interface Level {
  key: string[];
  description: string;
  foreign: string | undefined;
  unit: string | undefined;
  family: string | undefined;
  status: string | undefined;
  /** The customer a record belongs to, when it is not the record itself. */
  customer: string[];
}

/**
 * A screen level's searchable columns: its key; its main description (the
 * first editable text field named ...DES, such as PARTDES, CUSTDES or PROJDES,
 * so a customer name copied onto a project does not win); the foreign
 * description beside it; the sales unit; the family; the status; and the
 * customer it belongs to (CUSTNAME and CUSTDES on a project).
 */
function level(type: ScreenType, label: string, hint: string): Level {
  const key = type.key.filter((k) => has(type, k));
  const named = type.fields.filter(
    (f) =>
      f.type === 'String' &&
      !f.internalId &&
      !key.includes(f.name) &&
      f.name !== 'STATDES' &&
      /DES$/.test(f.name),
  );
  const description = (named.find((f) => !f.readOnly) ?? named[0])?.name;
  if (!description) {
    throw usage(
      `${label} has no description field for find to search. ${hint}`,
    );
  }
  const foreign = has(type, `E${description}`) ? `E${description}` : undefined;
  const unit = ['PUNITNAME', 'UNITNAME'].find((n) => has(type, n));
  const customer =
    description !== 'CUSTDES' &&
    !key.includes('CUSTNAME') &&
    has(type, 'CUSTDES')
      ? unique([has(type, 'CUSTNAME') ? 'CUSTNAME' : undefined, 'CUSTDES'])
      : [];
  return {
    key,
    description,
    foreign,
    unit,
    family: has(type, 'FAMILYDES') ? 'FAMILYDES' : undefined,
    status: has(type, 'STATDES') ? 'STATDES' : undefined,
    customer,
  };
}

export function layout(
  screen: Resolved,
  sub?: SubLink & { def: ScreenType },
): Layout {
  const top = level(
    screen.type,
    screen.name,
    `Use \`priority-axi get ${screen.name} --where F=V\` instead.`,
  );
  if (!sub) {
    const columns = unique([
      ...top.key,
      top.description,
      top.foreign,
      top.unit,
      top.family,
      top.status,
      ...top.customer,
    ]);
    const own = unique([...top.key, top.description, top.foreign, top.family]);
    return {
      columns,
      select: columns,
      search: unique([
        ...own,
        top.customer.includes('CUSTDES') ? 'CUSTDES' : undefined,
      ]),
      show: unique([
        ...top.key,
        top.description,
        top.unit,
        top.family,
        ...top.customer,
      ]),
      status: unique([top.status]),
      key: top.key,
      parentKey: top.key,
      own,
      context: top.customer.length ? 'customer' : undefined,
    };
  }
  const low = level(
    sub.def,
    `${screen.name} > ${sub.name}`,
    `Use \`priority-axi show ${screen.name} <key> --with ${sub.name}\` instead.`,
  );
  const parent = unique([...top.key, top.description, top.status]);
  const subFields = unique([
    ...low.key,
    low.description,
    low.foreign,
    low.unit,
    low.family,
    low.status,
  ]);
  // A sub-screen column named like a parent column is stored as SUB.FIELD.
  const stored = (f: string | undefined) =>
    f === undefined ? undefined : parent.includes(f) ? `${sub.name}.${f}` : f;
  const own = unique([
    ...low.key.map(stored),
    stored(low.description),
    stored(low.foreign),
    stored(low.family),
  ]);
  return {
    columns: [...parent, ...subFields.map((f) => stored(f) as string)],
    select: parent,
    subSelect: subFields,
    search: unique([...own, top.description]),
    own,
    context: 'parent',
    show: unique([
      ...low.key.map(stored),
      stored(low.description),
      stored(low.unit),
      ...top.key,
      top.description,
    ]),
    status: unique([top.status, stored(low.status)]),
    key: low.key.map((k) => stored(k) as string),
    parentKey: top.key,
  };
}

function catalogPath(dir: string, screen: string, sub?: string): string {
  return join(dir, 'find', `${screen}${sub ? `.${sub}` : ''}.json`);
}

export function readCatalog(
  dir: string,
  screen: string,
  sub: string | undefined,
  columns: readonly string[],
  now: Date,
): Catalog | undefined {
  const value = readJson(catalogPath(dir, screen, sub)) as
    | Partial<Catalog>
    | undefined;
  if (
    !value ||
    value.format !== CATALOG_FORMAT ||
    value.screen !== screen ||
    value.sub !== sub ||
    !Array.isArray(value.rows) ||
    !Array.isArray(value.columns) ||
    value.columns.join(',') !== columns.join(',') ||
    typeof value.builtAt !== 'string'
  ) {
    return undefined;
  }
  const age = now.getTime() - Date.parse(value.builtAt);
  if (!(age >= 0 && age < MAX_CATALOG_AGE_MS)) return undefined;
  return value as Catalog;
}

export function writeCatalog(dir: string, catalog: Catalog): void {
  writeJsonAtomic(catalogPath(dir, catalog.screen, catalog.sub), catalog);
}

export type PageReader = (query: string) => Promise<Record<string, unknown>[]>;

/**
 * Read every record, ordered by the key, CATALOG_PAGE at a time: the first page
 * alone, then CATALOG_PARALLEL pages at once until a short page.
 */
export async function pullCatalog(
  screen: Resolved,
  sub: (SubLink & { def: ScreenType }) | undefined,
  lay: Layout,
  read: PageReader,
  now: Date,
): Promise<Catalog> {
  const order = screen.type.key.filter((k) => has(screen.type, k)).join(',');
  const query = (skip: number) =>
    queryString({
      $select: lay.select.join(','),
      $orderby: order || undefined,
      $top: CATALOG_PAGE,
      $skip: skip || undefined,
      $expand:
        sub && lay.subSelect
          ? `${sub.nav}($select=${lay.subSelect.join(',')})`
          : undefined,
    });
  const rows: unknown[][] = [];
  let records = 0;
  let partial = false;
  const take = (page: Record<string, unknown>[]) => {
    records += page.length;
    for (const record of page) {
      const head = lay.select.map((c) => record[c] ?? null);
      if (!sub || !lay.subSelect) {
        rows.push(head);
        continue;
      }
      const value = record[sub.nav];
      const lines = Array.isArray(value)
        ? value
        : value && typeof value === 'object'
          ? [value]
          : [];
      for (const line of lines as Record<string, unknown>[]) {
        rows.push([...head, ...lay.subSelect.map((c) => line[c] ?? null)]);
      }
    }
  };
  const first = await read(query(0));
  take(first);
  let done = first.length < CATALOG_PAGE;
  let skip = CATALOG_PAGE;
  while (!done) {
    if (records >= MAX_CATALOG_RECORDS) {
      partial = true;
      break;
    }
    const pages = await Promise.all(
      Array.from({ length: CATALOG_PARALLEL }, (_, i) =>
        read(query(skip + i * CATALOG_PAGE)),
      ),
    );
    skip += CATALOG_PARALLEL * CATALOG_PAGE;
    for (const page of pages) {
      take(page);
      if (page.length < CATALOG_PAGE) {
        done = true;
        break;
      }
    }
  }
  return {
    format: CATALOG_FORMAT,
    builtAt: now.toISOString(),
    screen: screen.name,
    ...(sub ? { sub: sub.name } : {}),
    columns: lay.columns,
    rows,
    records,
    ...(partial ? { partial: true as const } : {}),
  };
}
