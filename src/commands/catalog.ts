// screens and fields: offline over the screen index once it is built.

import type { CommandInput } from '../cli/table.ts';
import {
  type Field,
  resolveScreen,
  resolveSub,
  type ScreenType,
} from '../index/build.ts';
import { readReach } from '../index/cache.ts';
import { bounded, cut, render } from '../output/toon.ts';
import {
  builtNote,
  commandLine,
  intFlag,
  open,
  screenIndex,
  shellWord,
  str,
} from './common.ts';

interface Hit {
  name: string;
  score: number;
  match: string | null;
}

function scoreScreen(
  name: string,
  type: ScreenType,
  q: string,
): Hit | undefined {
  const lower = name.toLowerCase();
  if (lower === q) return { name, score: 0, match: 'name' };
  if (lower.startsWith(q)) return { name, score: 1, match: 'name' };
  if (lower.includes(q)) return { name, score: 2, match: 'name' };
  const sub = type.subs.find(
    (s) =>
      s.name.toLowerCase().includes(q) || s.title?.toLowerCase().includes(q),
  );
  if (sub) {
    return {
      name,
      score: 3,
      match: `sub ${sub.name}${sub.title ? ` (${sub.title})` : ''}`,
    };
  }
  const field = type.fields.find(
    (f) =>
      f.name.toLowerCase() === q || f.description?.toLowerCase().includes(q),
  );
  if (field) {
    return {
      name,
      score: 4,
      match: `field ${field.name}${field.description ? ` (${field.description})` : ''}`,
    };
  }
  return undefined;
}

export async function screens(input: CommandInput): Promise<string> {
  const s = open(input);
  const loaded = await screenIndex(s);
  const { index } = loaded;
  const text = input.positionals[0]?.trim();
  const q = text?.toLowerCase();
  const limit = intFlag(input.values.limit, 'limit', 20, 1, 2000);
  const full = input.values.full === true;
  const reach = readReach(s.dir);
  const api = (name: string) => reach[name]?.api ?? 'unknown';
  const rank = (name: string) =>
    api(name) === 'yes' ? 0 : api(name) === 'unknown' ? 1 : 2;

  const hits: Hit[] = [];
  for (const [name, typeName] of Object.entries(index.sets)) {
    const type = index.types[typeName];
    if (!type) continue;
    const hit = q
      ? scoreScreen(name, type, q)
      : { name, score: 0, match: null };
    if (hit) hits.push(hit);
  }
  hits.sort(
    (a, b) =>
      a.score - b.score ||
      rank(a.name) - rank(b.name) ||
      a.name.localeCompare(b.name),
  );

  const rows = hits.map((h) => {
    const type = index.types[index.sets[h.name] ?? ''];
    return {
      name: h.name,
      key: type?.key.length ? type.key.join('+') : null,
      api: api(h.name),
      ...(q ? { match: h.match } : { fields: type?.fields.length ?? 0 }),
    };
  });
  const noun = (n: number) => (n === 1 ? 'screen' : 'screens');
  const total = rows.length;
  const capped = full ? total : Math.min(limit, total);
  const what = q
    ? `${total} ${noun(total)} match ${text}`
    : `${total} ${noun(total)}`;

  if (!total) {
    return render({ summary: what, ...builtNote(loaded) }, [
      'Run `priority-axi screens` to list every screen',
    ]);
  }
  return bounded(
    {
      total: capped,
      narrower: `priority-axi screens ${text ? `${shellWord(text)} ` : ''}--limit 20`,
      build: (shown, fieldLimit) => {
        const listed = rows
          .slice(0, shown)
          .map((r) =>
            'match' in r &&
            typeof r.match === 'string' &&
            Number.isFinite(fieldLimit)
              ? { ...r, match: cut(r.match, Math.min(fieldLimit, 80)) }
              : r,
          );
        const help: string[] = [];
        if (shown < total) {
          help.push(
            `Run \`${commandLine('screens', text ? [text] : [], input.values, { full: '', limit: null })}\` to list all ${total}`,
          );
        }
        help.push(
          "Run `priority-axi fields <SCREEN>` to see a screen's fields",
        );
        return render(
          {
            summary: shown < total ? `${what} (${shown} shown)` : what,
            ...builtNote(loaded),
            screens: listed,
          },
          help,
        );
      },
    },
    full,
  );
}

export function shortType(f: Field): string {
  switch (f.type) {
    case 'String':
      return f.max ? `text(${f.max})` : 'text';
    case 'Int16':
    case 'Int32':
    case 'Int64':
      return 'int';
    case 'Decimal':
    case 'Double':
    case 'Single':
      return 'decimal';
    case 'DateTimeOffset':
      return f.dateType === 'Date' ? 'date' : 'datetime';
    case 'Boolean':
      return 'bool';
    default:
      return f.type.toLowerCase();
  }
}

export async function fields(input: CommandInput): Promise<string> {
  const s = open(input);
  const loaded = await screenIndex(s);
  const { index } = loaded;
  const screen = resolveScreen(index, input.positionals[0] ?? '');
  const subName = str(input.values.sub);
  const sub = subName ? resolveSub(index, screen, subName) : undefined;
  const type = sub ? sub.def : screen.type;
  const all = input.values.all === true;
  const full = input.values.full === true;

  const listed = type.fields.filter(
    (f) => all || !f.internalId || type.key.includes(f.name),
  );
  const hidden = type.fields.length - listed.length;
  const rows = listed.map((f) => {
    const flags = [
      type.key.includes(f.name) ? 'key' : '',
      f.readOnly ? 'read-only' : '',
      f.internalId ? 'id' : '',
    ].filter(Boolean);
    return {
      name: f.name,
      type: shortType(f),
      flags: flags.length ? flags.join(' ') : null,
      description: f.description ?? null,
    };
  });
  const target = sub ? `${screen.name} > ${sub.name}` : screen.name;
  const summary = `${type.fields.length} fields${hidden ? ` (${hidden} internal ID${hidden === 1 ? '' : 's'} hidden; --all shows them)` : ''}`;
  const head: Record<string, unknown> = {
    screen: target,
    ...(sub?.title ? { title: sub.title } : {}),
    ...(sub ? { holds: sub.many ? 'lines' : 'one record' } : {}),
    key: type.key.length ? type.key.join(', ') : null,
    summary,
    ...builtNote(loaded),
  };
  const subs = sub ? [] : screen.type.subs.map((x) => x.name);
  return bounded(
    {
      total: rows.length,
      narrower: `priority-axi fields ${screen.name}`,
      build: (shown) => {
        const help = [
          `Run \`priority-axi get ${screen.name} --limit 5\` to read records`,
        ];
        if (shown < rows.length) {
          help.push(
            `Run \`${commandLine('fields', [screen.name], input.values, { full: '' })}\` to list all ${rows.length} fields without the size limit (${shown} shown)`,
          );
        } else if (subs.length) {
          help.push(
            `Run \`priority-axi fields ${screen.name} --sub <SUB>\` for a sub-screen`,
          );
        }
        return render(
          {
            ...head,
            fields: rows.slice(0, shown),
            ...(shown < rows.length
              ? { omitted: `${rows.length - shown} fields not shown` }
              : {}),
            ...(subs.length ? { subforms: subs } : {}),
          },
          help,
        );
      },
    },
    full,
  );
}
