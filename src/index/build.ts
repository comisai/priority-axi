// Reduces Priority's JSON CSDL ($metadata?$format=json) to a compact index.
// Pure: no I/O. The index is derived data and can always be rebuilt.

import { AxiError, usage } from '../errors.ts';

export interface Field {
  name: string;
  /** Edm type without the "Edm." prefix: String, Int64, Decimal, DateTimeOffset, Boolean. */
  type: string;
  max?: number;
  description?: string;
  readOnly?: true;
  /** Priority.OData.AutoUnique: an internal ID such as CUST. */
  internalId?: true;
  /** Priority.OData.DateType, such as "Date". */
  dateType?: string;
}

export interface SubLink {
  /** The sub-screen name used on the command line, such as ORDERITEMS. */
  name: string;
  /** The navigation property, such as ORDERITEMS_SUBFORM. */
  nav: string;
  /** The entity type of its records. */
  type: string;
  title?: string;
  /** False for a sub-screen that holds one record. */
  many: boolean;
}

export interface ScreenType {
  key: string[];
  fields: Field[];
  subs: SubLink[];
}

export interface ScreenIndex {
  format: 1;
  version: string;
  builtAt: string;
  /** Entity set (a top-level screen) to its entity type. */
  sets: Record<string, string>;
  types: Record<string, ScreenType>;
}

export const INDEX_FORMAT = 1;
const SUBFORM = /_SUBFORM$/;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const lastPart = (qualified: string) => qualified.split('.').pop() ?? qualified;

function invalid(detail: string): never {
  throw new AxiError(
    'priority_error',
    `Priority returned metadata that priority-axi cannot read (${detail}).`,
  );
}

export function buildIndex(
  csdl: unknown,
  meta: { version: string; builtAt: string },
): ScreenIndex {
  if (!isObject(csdl)) invalid('not an object');
  const container =
    typeof csdl.$EntityContainer === 'string' ? csdl.$EntityContainer : '';
  const nsName = Object.keys(csdl).find((k) => !k.startsWith('$'));
  const ns = nsName ? csdl[nsName] : undefined;
  if (!isObject(ns)) invalid('no schema');
  const entities = ns[lastPart(container)];
  if (!isObject(entities)) invalid('no entity container');

  const sets: Record<string, string> = {};
  for (const [name, entry] of Object.entries(entities)) {
    if (
      isObject(entry) &&
      entry.$Collection === true &&
      typeof entry.$Type === 'string'
    ) {
      sets[name] = lastPart(entry.$Type);
    }
  }

  const types: Record<string, ScreenType> = {};
  for (const [typeName, def] of Object.entries(ns)) {
    if (!isObject(def) || def.$Kind !== 'EntityType') continue;
    const key = Array.isArray(def.$Key)
      ? def.$Key.filter((k): k is string => typeof k === 'string')
      : [];
    const fields: Field[] = [];
    const subs: SubLink[] = [];
    for (const [name, prop] of Object.entries(def)) {
      if (name.startsWith('$') || name.startsWith('@') || !isObject(prop))
        continue;
      if (prop.$Kind === 'NavigationProperty') {
        const title = prop['@Priority.OData.Description'];
        subs.push({
          name: name.replace(SUBFORM, ''),
          nav: name,
          type: lastPart(typeof prop.$Type === 'string' ? prop.$Type : name),
          ...(typeof title === 'string' && title ? { title } : {}),
          many: prop.$Collection === true,
        });
        continue;
      }
      const field: Field = {
        name,
        type: (typeof prop.$Type === 'string'
          ? prop.$Type
          : 'Edm.String'
        ).replace(/^Edm\./, ''),
      };
      if (typeof prop.$MaxLength === 'number') field.max = prop.$MaxLength;
      const description = prop['@Priority.OData.Description'];
      if (typeof description === 'string' && description)
        field.description = description;
      if (prop['@Org.OData.Core.V1.Permissions'] === 'Read')
        field.readOnly = true;
      if (prop['@Priority.OData.AutoUnique'] === true) field.internalId = true;
      const dateType = prop['@Priority.OData.DateType'];
      if (typeof dateType === 'string' && dateType) field.dateType = dateType;
      fields.push(field);
    }
    types[typeName] = { key, fields, subs };
  }
  if (Object.keys(sets).length === 0) invalid('no screens');
  return {
    format: INDEX_FORMAT,
    version: meta.version,
    builtAt: meta.builtAt,
    sets,
    types,
  };
}

export interface Resolved {
  /** The screen name as Priority spells it. */
  name: string;
  type: ScreenType;
}

/** Find a top-level screen: exact name first, then a unique case-insensitive match. */
export function resolveScreen(index: ScreenIndex, input: string): Resolved {
  const exact = index.sets[input];
  const names = Object.keys(index.sets);
  const name = exact
    ? input
    : (() => {
        const matches = names.filter(
          (n) => n.toLowerCase() === input.toLowerCase(),
        );
        return matches.length === 1 ? matches[0] : undefined;
      })();
  const type = name ? index.types[index.sets[name] ?? ''] : undefined;
  if (!name || !type) {
    const near = suggest(input, names);
    throw usage(
      `No screen named ${safeName(input)}.${near.length ? ` Did you mean ${near.join(', ')}?` : ''} Run \`priority-axi screens <text>\` to search.`,
    );
  }
  return { name, type };
}

/** Find a sub-screen of a screen by its short name (ORDERITEMS) or its navigation name. */
export function resolveSub(
  index: ScreenIndex,
  screen: Resolved,
  input: string,
): SubLink & { def: ScreenType } {
  const upper = input.toUpperCase();
  const sub = screen.type.subs.find(
    (s) =>
      s.name === input ||
      s.nav === input ||
      s.name.toUpperCase() === upper ||
      s.nav.toUpperCase() === upper,
  );
  if (sub && !index.types[sub.type]) {
    throw new AxiError(
      'priority_error',
      `The metadata names ${screen.name} > ${sub.name} but does not describe it. Run \`priority-axi refresh\`.`,
    );
  }
  const def = sub ? index.types[sub.type] : undefined;
  if (!sub || !def) {
    const near = suggest(
      input,
      screen.type.subs.map((s) => s.name),
    );
    throw usage(
      `${screen.name} has no sub-screen ${safeName(input)}.${near.length ? ` Did you mean ${near.join(', ')}?` : ''} Run \`priority-axi fields ${screen.name}\` to list them.`,
    );
  }
  return { ...sub, def };
}

/** Find a field of a screen type: exact, then case-insensitive. */
export function resolveField(
  type: ScreenType,
  screenName: string,
  input: string,
): Field {
  const upper = input.toUpperCase();
  const field =
    type.fields.find((f) => f.name === input) ??
    type.fields.find((f) => f.name === upper);
  if (!field) {
    const near = suggest(
      input,
      type.fields.map((f) => f.name),
    );
    throw usage(
      `${screenName} has no field ${safeName(input)}.${near.length ? ` Did you mean ${near.join(', ')}?` : ''} Run \`priority-axi fields ${screenName}\` to list them.`,
    );
  }
  return field;
}

/** Echo a user-typed name only when it looks like a name; never echo arbitrary values. */
export function safeName(input: string): string {
  return /^[A-Za-z0-9_]{1,64}$/.test(input) ? input : 'with that name';
}

/** Up to five names: same name ignoring case, then names containing the input, then close edits. */
export function suggest(
  input: string,
  names: readonly string[],
  limit = 5,
): string[] {
  const q = input.toUpperCase();
  if (!q) return [];
  const scored: Array<[number, string]> = [];
  for (const name of names) {
    const n = name.toUpperCase();
    let score: number | undefined;
    if (n === q) score = 0;
    else if (n.startsWith(q)) score = 1;
    else if (n.includes(q)) score = 2;
    else if (Math.abs(n.length - q.length) <= 2 && distance(n, q) <= 2)
      score = 3;
    if (score !== undefined) scored.push([score, name]);
  }
  scored.sort(
    (a, b) =>
      a[0] - b[0] || a[1].length - b[1].length || a[1].localeCompare(b[1]),
  );
  return scored.slice(0, limit).map(([, name]) => name);
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j] ?? 0;
      row[j] = Math.min(
        (row[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = temp;
    }
  }
  return row[b.length] ?? 0;
}
