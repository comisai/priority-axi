// Rebuild the screen index now.

import type { CommandInput } from '../cli/table.ts';
import { loadIndex } from '../index/cache.ts';
import { render } from '../output/toon.ts';
import { checkCompany, indexSource, open, priorityVersion } from './common.ts';

export async function refresh(input: CommandInput): Promise<string> {
  const s = open(input);
  const version = await priorityVersion(s);
  await checkCompany(s, true);
  const { index, rebuilt } = await loadIndex(s.dir, indexSource(s), {
    now: input.io.now(),
    refresh: true,
    liveVersion: version,
  });
  const types = Object.values(index.types);
  const doc: Record<string, unknown> = {
    index: 'rebuilt',
    version: index.version,
    screens: Object.keys(index.sets).length,
    types: types.length,
    fields: types.reduce((n, t) => n + t.fields.length, 0),
  };
  if (rebuilt) {
    doc.metadata = `${(rebuilt.bytes / 2 ** 20).toFixed(1)} MB in ${(rebuilt.ms / 1000).toFixed(1)} s`;
  }
  return render(doc, ['Run `priority-axi` for the home view']);
}
