// Dispatch: home view with no command, help and version, then one command.
// Everything goes to stdout. Exit codes: 0 ok, 1 error, 2 usage.

import { encode } from '@toon-format/toon';
import { fields, screens } from '../commands/catalog.ts';
import { create } from '../commands/create.ts';
import { find as findRecords } from '../commands/find.ts';
import { home } from '../commands/home.ts';
import { changes, get, show } from '../commands/read.ts';
import { refresh } from '../commands/refresh.ts';
import { AxiError, usage } from '../errors.ts';
import { errorText } from '../output/toon.ts';
import { VERSION } from '../version.ts';
import { parseCommand } from './parse.ts';
import {
  BIN,
  CONNECTION_FLAGS,
  type CommandSpec,
  commandName,
  type Io,
  usageLine,
} from './table.ts';

export const DESCRIPTION =
  'Read and create Priority ERP records over its REST API';

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: '',
    args: [],
    flags: { ...CONNECTION_FLAGS },
    summary:
      'Home view: connection, Priority version, company, index and next steps',
    run: home,
  },
  {
    name: 'screens',
    args: [{ name: '<text>', required: false }],
    flags: {
      limit: {
        type: 'string',
        value: '<n>',
        summary: 'Rows to show, default 20, at most 2000',
      },
      full: { type: 'boolean', summary: 'Show every match' },
      ...CONNECTION_FLAGS,
    },
    summary: 'Find screens by name, sub-screen title or field description',
    run: screens,
  },
  {
    name: 'fields',
    args: [{ name: '<SCREEN>', required: true }],
    flags: {
      sub: {
        type: 'string',
        value: '<SUB>',
        summary: 'Describe a sub-screen, such as ORDERITEMS',
      },
      all: { type: 'boolean', summary: 'Include internal IDs' },
      full: {
        type: 'boolean',
        summary: 'Show every field without the size limit',
      },
      ...CONNECTION_FLAGS,
    },
    summary: "Describe a screen's fields, key and sub-screens",
    run: fields,
  },
  {
    name: 'get',
    args: [{ name: '<SCREEN>', required: true }],
    flags: {
      where: {
        type: 'string',
        multiple: true,
        value: '<F=V>',
        summary: 'Filter: F=V, F!=V, F>V, F>=V, F<V or F<=V',
      },
      filter: {
        type: 'string',
        value: '<odata>',
        summary: 'A raw OData $filter, combined with --where using and',
      },
      fields: { type: 'string', value: '<A,B>', summary: 'Columns to show' },
      with: {
        type: 'string',
        multiple: true,
        value: '<SUB>',
        summary: 'Include sub-screen lines, such as ORDERITEMS',
      },
      sort: {
        type: 'string',
        value: '<F[:desc]>',
        summary: 'Sort by a field; add :desc to reverse. Default: the key',
      },
      limit: {
        type: 'string',
        value: '<n>',
        summary: 'Records per page, default 20, at most 500',
      },
      page: { type: 'string', value: '<n>', summary: 'Page number, default 1' },
      full: {
        type: 'boolean',
        summary: 'Every non-empty field, no size limit',
      },
      ...CONNECTION_FLAGS,
    },
    summary: 'Read records from a screen',
    run: get,
  },
  {
    name: 'show',
    args: [
      { name: '<SCREEN>', required: true },
      { name: '<key>', required: false },
    ],
    flags: {
      key: {
        type: 'string',
        multiple: true,
        value: '<F=V>',
        summary: 'One part of a compound key',
      },
      with: {
        type: 'string',
        multiple: true,
        value: '<SUB>',
        summary: 'Include sub-screen lines',
      },
      all: { type: 'boolean', summary: 'Include internal IDs' },
      full: { type: 'boolean', summary: 'Every field and line, no size limit' },
      ...CONNECTION_FLAGS,
    },
    summary: 'Read one record by its key',
    run: show,
  },
  {
    name: 'changes',
    args: [{ name: '<SCREEN>', required: true }],
    flags: {
      since: {
        type: 'string',
        required: true,
        value: '<time>',
        summary: 'From when: 7d, 24h, 2026-11-01 or a full UTC time',
      },
      where: {
        type: 'string',
        multiple: true,
        value: '<F=V>',
        summary: 'Filter, as for get',
      },
      fields: { type: 'string', value: '<A,B>', summary: 'Columns to show' },
      limit: {
        type: 'string',
        value: '<n>',
        summary: 'Records per page, default 20, at most 500',
      },
      page: { type: 'string', value: '<n>', summary: 'Page number, default 1' },
      full: {
        type: 'boolean',
        summary: 'Every non-empty field, no size limit',
      },
      ...CONNECTION_FLAGS,
    },
    summary:
      'Read records created or changed since a time (screens with a BPM status workflow)',
    run: changes,
  },
  {
    name: 'find',
    args: [
      { name: '<SCREEN>', required: true },
      { name: '<words>', required: true, variadic: true },
    ],
    flags: {
      sub: {
        type: 'string',
        value: '<SUB>',
        summary:
          'Search the lines of a sub-screen with their parent, such as CUSTOMERS --sub CUSTPROJECTS',
      },
      all: { type: 'boolean', summary: 'Include inactive records' },
      limit: {
        type: 'string',
        value: '<n>',
        summary: 'Matches per page, default 20, at most 200',
      },
      page: { type: 'string', value: '<n>', summary: 'Page number, default 1' },
      refresh: {
        type: 'boolean',
        summary: 'Rebuild the local catalog now instead of after a day',
      },
      ...CONNECTION_FLAGS,
    },
    summary:
      'Find records by words in their name or description, such as parts or customers',
    run: findRecords,
  },
  {
    name: 'create',
    args: [
      { name: '<SCREEN>', required: true },
      // The F=V terms of a --line; its placeholder shows them.
      { name: '<F=V>', required: false, variadic: true, hidden: true },
    ],
    flags: {
      set: {
        type: 'string',
        multiple: true,
        value: '<F=V>',
        summary: 'A field of the new record',
      },
      line: {
        type: 'string',
        multiple: true,
        value: '<SUB> <F=V>...',
        summary: 'A sub-screen line: the sub-screen, then its fields',
      },
      'json-file': {
        type: 'string',
        value: '<path>',
        summary: 'The record as JSON instead of --set and --line',
      },
      'dry-run': {
        type: 'boolean',
        summary: 'Check and show the request without sending it',
      },
      ...CONNECTION_FLAGS,
    },
    summary: 'Create a record; inside Comis the owner approves it first',
    run: create,
  },
  {
    name: 'refresh',
    args: [],
    flags: { ...CONNECTION_FLAGS },
    summary: 'Rebuild the screen index from Priority now',
    run: refresh,
  },
  {
    name: 'help',
    args: [{ name: '<command>', required: false }],
    flags: {},
    summary: 'List the commands, or show one command',
    run: async () => '',
  },
];

const HOME = COMMANDS[0] as CommandSpec;
const HELP_FLAGS = new Set(['--help', '-h']);
const VERSION_FLAGS = new Set(['--version', '-v', '-V']);

export function topHelp(): string {
  return `${encode({
    description: DESCRIPTION,
    usage: `${BIN} [command] [flags]`,
    commands: COMMANDS.map((c) => ({
      command: commandName(c),
      summary: c.summary,
    })),
    settings:
      'PRIORITY_URL and PRIORITY_PASSWORD; PRIORITY_USER, PRIORITY_COMPANY and PRIORITY_INI, or their flags',
  })}\nhelp[1]:\n  Run \`${BIN} help <command>\` for its flags\n`;
}

export function commandHelp(spec: CommandSpec): string {
  const flags = Object.entries(spec.flags).map(([name, f]) => ({
    flag:
      f.type === 'string' ? `--${name} ${f.value ?? '<value>'}` : `--${name}`,
    summary: f.multiple ? `${f.summary} (repeatable)` : f.summary,
  }));
  return `${encode({
    command: commandName(spec),
    summary: spec.summary,
    usage: usageLine(spec),
    ...(flags.length ? { flags } : {}),
  })}\n`;
}

function find(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name && c.name !== '');
}

function unknownCommand(name: string): AxiError {
  const shown = /^[a-z][a-z-]{0,30}$/.test(name)
    ? `\`${name}\``
    : 'that command';
  const list = COMMANDS.filter((c) => c.name).map((c) => c.name);
  return usage(`Unknown command ${shown}. Commands: ${list.join(', ')}.`);
}

export async function main(argv: string[], io: Io): Promise<number> {
  let spec: CommandSpec = HOME;
  let usageText = `${BIN} [command] [flags]`;
  try {
    const first = argv[0];
    if (argv.length === 1 && first && VERSION_FLAGS.has(first)) {
      io.stdout(`${VERSION}\n`);
      return 0;
    }
    if (argv.length === 1 && first && HELP_FLAGS.has(first)) {
      io.stdout(topHelp());
      return 0;
    }
    let rest = argv;
    if (first && !first.startsWith('-')) {
      const found = find(first);
      if (!found) throw unknownCommand(first);
      spec = found;
      rest = argv.slice(1);
    }
    usageText = usageLine(spec);
    const beforeTerminator = rest.includes('--')
      ? rest.slice(0, rest.indexOf('--'))
      : rest;
    if (beforeTerminator.some((a) => HELP_FLAGS.has(a))) {
      io.stdout(commandHelp(spec));
      return 0;
    }
    const parsed = parseCommand(spec, rest);
    if (spec.name === 'help') {
      const target = parsed.positionals[0];
      if (!target) {
        io.stdout(topHelp());
        return 0;
      }
      const found = find(target);
      if (!found) throw unknownCommand(target);
      io.stdout(commandHelp(found));
      return 0;
    }
    io.stdout(await spec.run({ ...parsed, io }));
    return 0;
  } catch (error) {
    const axi =
      error instanceof AxiError
        ? error
        : new AxiError(
            'internal_error',
            'priority-axi failed unexpectedly. Run the command once more; if it fails again, report it.',
          );
    io.stdout(errorText(axi, usageText));
    return axi.exitCode;
  }
}
