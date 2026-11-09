// The home view: connection, live Priority version, company, index state and
// next steps. Two small GETs; it never downloads the metadata.

import type { CommandInput } from '../cli/table.ts';
import { readIndex, readReach, staleReason } from '../index/cache.ts';
import { render } from '../output/toon.ts';
import { checkCompany, open, priorityVersion } from './common.ts';

const SHOWN = 20;

function names(list: string[]): string[] {
  return list.length > SHOWN
    ? [...list.slice(0, SHOWN), `${list.length - SHOWN} more`]
    : list;
}

export async function home(input: CommandInput): Promise<string> {
  const s = open(input);
  const now = input.io.now();
  const version = await priorityVersion(s);
  const company = await checkCompany(s, true);

  const index = readIndex(s.dir);
  const reason = staleReason(index, { now, liveVersion: version });
  let indexLine: string;
  if (!index) {
    indexLine =
      'not built yet; it is built on first use (about 8 MB from Priority)';
  } else {
    const screens = Object.keys(index.sets).length;
    const built = index.builtAt.slice(0, 10);
    indexLine = reason
      ? `${screens} screens, built ${built} for Priority ${index.version}; rebuilt on next use (${reason === 'age' ? 'older than 7 days' : 'new Priority version'})`
      : `${screens} screens, built ${built}`;
  }

  const reach = readReach(s.dir);
  const enabled = Object.keys(reach)
    .filter((k) => reach[k]?.api === 'yes')
    .sort();
  const refused = Object.keys(reach)
    .filter((k) => reach[k]?.api === 'no')
    .sort();

  const doc: Record<string, unknown> = {
    priority: `${s.settings.origin} · ${s.settings.ini} · company ${s.settings.company}`,
    company: company.title || company.code,
    version,
    login: s.settings.user,
    index: indexLine,
    screens_read: enabled.length ? names(enabled) : 'none yet',
  };
  if (refused.length) doc.not_enabled = names(refused);
  doc.note = `screens_read lists the screens read so far, not every screen open to the API; try any other.${refused.length ? ' Screens under not_enabled refused API access; the Priority administrator adds them in Limited Access/API Forms.' : ''}`;
  const help = [
    'Run `priority-axi screens <text>` to find a screen',
    'Run `priority-axi get <SCREEN> --limit 5` to read records',
  ];
  if (index && reason)
    help.push('Run `priority-axi refresh` to rebuild the screen index now');
  return render(doc, help);
}
