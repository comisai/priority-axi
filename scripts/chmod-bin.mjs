import { chmodSync } from 'node:fs';

chmodSync(new URL('../dist/bin/priority-axi.js', import.meta.url), 0o755);
