// Cut a small test fixture from a full Priority JSON CSDL ($metadata?$format=json).
// Usage: node scripts/cut-metadata.mjs <full.json> <out.json> TYPE [TYPE...]
// Keeps the listed entity types, their container entries, and the schema's
// annotation terms. Schema only: metadata holds no records.
import { readFileSync, writeFileSync } from 'node:fs';

const [, , source, target, ...wanted] = process.argv;
if (!source || !target || !wanted.length) {
  console.error(
    'usage: node scripts/cut-metadata.mjs <full.json> <out.json> TYPE [TYPE...]',
  );
  process.exit(2);
}
const full = JSON.parse(readFileSync(source, 'utf8'));
const nsName = Object.keys(full).find((k) => !k.startsWith('$'));
const ns = full[nsName];
const containerName = full.$EntityContainer.split('.').pop();
const container = ns[containerName];
const out = {};
for (const [name, def] of Object.entries(ns)) {
  if (name === containerName) continue;
  if (def?.$Kind === 'EntityType' && !wanted.includes(name)) continue;
  if (def?.$Kind === 'EntityType' || def?.$Kind === 'Term') out[name] = def;
}
const missing = wanted.filter((t) => !out[t]);
if (missing.length) {
  console.error(`not in metadata: ${missing.join(' ')}`);
  process.exit(1);
}
const kept = { $Kind: 'EntityContainer' };
for (const [name, entry] of Object.entries(container)) {
  if (entry?.$Collection && wanted.includes(entry.$Type.split('.').pop()))
    kept[name] = entry;
}
out[containerName] = kept;
writeFileSync(
  target,
  `${JSON.stringify({ $Version: full.$Version, $EntityContainer: full.$EntityContainer, [nsName]: out }, null, 1)}\n`,
);
console.log(
  `${target}: ${Object.keys(kept).length - 1} screens, ${wanted.length} types`,
);
