// find: text search over a screen's catalog (key, description, unit, family,
// status), kept locally because Priority cannot search text. Records that are
// not in use (not active, cancelled, finished, closed) are left out unless
// --all. With --sub, the lines of a sub-screen are searched together with
// their parent, such as the projects of every customer; a project screen's
// customer name is searched too. The `matched` column says `own` when every
// word was in the record itself, or `parent` / `customer` when some were only
// there.

import type { CommandInput } from '../cli/table.ts';
import { usage } from '../errors.ts';
import { rowsOf } from '../http.ts';
import { resolveScreen, resolveSub } from '../index/build.ts';
import {
  type Catalog,
  layout,
  pullCatalog,
  readCatalog,
  writeCatalog,
} from '../index/catalog.ts';
import { bounded, cut, render } from '../output/toon.ts';
import { haystack, missing, queryTerms, rank } from '../search.ts';
import {
  builtNote,
  commandLine,
  intFlag,
  open,
  readScreen,
  screenIndex,
  str,
} from './common.ts';

/**
 * A status that means the record is not in use, in Priority's Hebrew and
 * English words: not active, cancelled, finished, closed.
 */
const INACTIVE =
  /לא\s*פעיל|מבוטל|הסתיים|סגור|\b(inactive|not active|cancel+ed|finished|closed)\b/i;

const when = (iso: string) => iso.slice(0, 16).replace('T', ' ');

export async function find(input: CommandInput): Promise<string> {
  const s = open(input);
  const v = input.values;
  const words = input.positionals.slice(1);
  const terms = queryTerms(words);
  if (!terms.length) {
    throw usage(
      'find needs words to look for, such as `priority-axi find LOGPART צינור 110`. One-letter words are ignored.',
    );
  }
  const limit = intFlag(v.limit, 'limit', 20, 1, 200);
  const page = intFlag(v.page, 'page', 1, 1, 100_000);
  const all = v.all === true;
  const loaded = await screenIndex(s);
  const { index } = loaded;
  const screen = resolveScreen(index, input.positionals[0] ?? '');
  const subName = str(v.sub);
  const sub = subName ? resolveSub(index, screen, subName) : undefined;
  const lay = layout(screen, sub);
  const label = sub ? `${screen.name} > ${sub.name}` : screen.name;
  const now = input.io.now();

  let catalog: Catalog | undefined =
    v.refresh === true
      ? undefined
      : readCatalog(s.dir, screen.name, sub?.name, lay.columns, now);
  let pulled: string | undefined;
  if (!catalog) {
    const started = performance.now();
    catalog = await pullCatalog(
      screen,
      sub,
      lay,
      async (query) => rowsOf(await readScreen(s, screen.name, query)),
      now,
    );
    writeCatalog(s.dir, catalog);
    const seconds = Math.max(
      1,
      Math.round((performance.now() - started) / 1000),
    );
    pulled = `built now: ${catalog.rows.length} ${sub ? 'lines' : 'records'} from Priority in ${seconds} s`;
  }

  const at = (name: string) => catalog.columns.indexOf(name);
  const statusAt = lay.status.map(at).filter((i) => i >= 0);
  const searchAt = lay.search.map(at).filter((i) => i >= 0);
  // The searched columns of the record itself, without its parent's or customer's.
  const ownAt = lay.own.map(at).filter((i) => i >= 0);
  const active = (row: unknown[]) =>
    statusAt.every((i) => !INACTIVE.test(String(row[i] ?? '')));
  const pool = all ? catalog.rows : catalog.rows.filter(active);
  const text = (row: unknown[]) => haystack(searchAt.map((i) => row[i]));
  const ranked = rank(pool, text, terms);
  // Nothing in use has every word: say so when records not in use do, such as
  // a cancelled project, rather than offering unrelated close matches.
  const retired =
    !all && !ranked.all.length
      ? rank(
          catalog.rows.filter((r) => !active(r)),
          text,
          terms,
        ).all.length
      : 0;
  // Show the status when the records searched do not all share one.
  const statusVaries =
    new Set(pool.map((r) => statusAt.map((i) => r[i]).join('|'))).size > 1;

  const unit = sub ? 'lines' : 'records';
  const kept = all ? catalog.rows.length : pool.length;
  const catalogNote = `${pulled ? `${pulled}; ` : ''}${kept}${all ? '' : ' active'} of ${catalog.rows.length} ${unit}${catalog.partial ? ' (partial: the first 200,000 records)' : ''}, built ${when(catalog.builtAt)} UTC; rebuilt after a day, or with --refresh`;
  const query = words.join(' ');
  const noun = (n: number) => (n === 1 ? (sub ? 'line' : 'record') : unit);
  const columns = [...lay.show, ...(all || statusVaries ? lay.status : [])];
  const closest = !retired && !ranked.all.length && ranked.closest.length;
  const matches = closest
    ? ranked.closest.map((c) => ({ row: c.row, lacking: c.lacking }))
    : ranked.all.map((row) => ({ row, lacking: [] as string[] }));
  const notInUse = (n: number) =>
    `${n} ${noun(n)} not in use (inactive, cancelled, finished or closed) match every word; --all shows them with their status`;
  const from = (page - 1) * limit;
  const slice = matches.slice(from, from + limit);
  const more = matches.length > from + limit;

  const summary = closest
    ? `0 ${unit} from ${label} match all of: ${query}`
    : `${matches.length} ${noun(matches.length)} from ${label} match ${query}${matches.length > limit || page > 1 ? ` (showing ${slice.length ? `${from + 1}-${from + slice.length}` : 'none'})` : ''}`;
  const head = {
    summary,
    ...builtNote(loaded),
    catalog: catalogNote,
    ...(retired ? { not_in_use: notInUse(retired) } : {}),
    ...(closest
      ? {
          closest: `${matches.length} ${noun(matches.length)} match ${terms.length - (matches[0]?.lacking.length ?? 0)} of ${terms.length} words`,
        }
      : {}),
  };

  const help: string[] = [];
  if (more) {
    help.push(
      `Run \`${commandLine('find', input.positionals, v, { page: String(page + 1) })}\` for the next ${limit}`,
    );
  }
  if (retired) {
    help.push(
      `Run \`${commandLine('find', input.positionals, v, { all: '' })}\` to see the ${retired} not in use, then ask before using one`,
    );
  } else if (!matches.length || closest) {
    help.push(
      `Run \`priority-axi find ${screen.name}${sub ? ` --sub ${sub.name}` : ''} <other words>\` with fewer or different words: a number, a size or one distinctive word`,
    );
  }
  if (!retired && !all && kept < catalog.rows.length && !matches.length) {
    help.push(
      `Run \`${commandLine('find', input.positionals, v, { all: '' })}\` to include ${unit} not in use`,
    );
  }
  if (matches.length) {
    help.push(
      sub
        ? `Run \`priority-axi show ${screen.name} <${lay.parentKey.join(', ')}> --with ${sub.name}\` for the record`
        : lay.key.length === 1
          ? `Run \`priority-axi show ${screen.name} <${lay.key[0]}>\` for one record`
          : `Run \`priority-axi show ${screen.name} ${lay.key.map((k) => `--key ${k}=<value>`).join(' ')}\` for one record`,
    );
  }

  if (!slice.length) return render(head, help);
  return bounded(
    {
      total: slice.length,
      narrower: commandLine('find', input.positionals, v, { limit: '5' }),
      build: (shown, fieldLimit) => {
        const records = slice.slice(0, shown).map(({ row, lacking }) => {
          const out: Record<string, unknown> = {};
          for (const name of columns) {
            const value = row[at(name)];
            out[name] =
              value === '' || value === undefined
                ? null
                : typeof value === 'string' && Number.isFinite(fieldLimit)
                  ? cut(value, fieldLimit)
                  : value;
          }
          if (lay.context && !closest)
            out.matched = missing(terms, haystack(ownAt.map((i) => row[i])))
              .length
              ? lay.context
              : 'own';
          if (closest) out.lacking = lacking.join(' ');
          return out;
        });
        return render(
          {
            ...head,
            [sub ? 'lines' : 'records']: records,
            ...(shown < slice.length
              ? {
                  omitted: `${slice.length - shown} not shown; use --limit ${Math.max(1, shown)}`,
                }
              : {}),
          },
          help,
        );
      },
    },
    false,
  );
}
