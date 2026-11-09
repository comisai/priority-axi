// Generate comis/templates/priority.yaml (C5a: a manually configured Gate
// service for a Priority server on a public host other than Priority Cloud)
// from comis/key-services/priority.json, so the two never drift apart.
// Usage: node scripts/comis-template.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs';

const entry = JSON.parse(
  readFileSync(
    new URL('../comis/key-services/priority.json', import.meta.url),
    'utf8',
  ),
);
const target = new URL('../comis/templates/priority.yaml', import.meta.url);
const q = (s) => JSON.stringify(s);
const lines = [
  '# Priority ERP through priority-axi, for a server on a public host other than',
  '# Priority Cloud (C5a), such as a partner-hosted https://erp.example.com.',
  '#',
  "# `comis connect priority --url` admits only servers on the owner's network",
  '# today (D968), so this service is configured by hand, as the GitLab and Gitea',
  '# templates are for self-hosted instances.',
  '#',
  "# 1. Replace erp.example.com with the server's host name. It must be a public",
  '#    host with a WebPKI certificate; keep scheme https. A credential never',
  '#    crosses plain HTTP.',
  '# 2. Copy the service into gate/gate.yaml and add its name to the profile of',
  '#    each workbench that may use Priority.',
  "# 3. Keep the API user's password under the secret name `priority`.",
  "# 4. Give those workbenches PRIORITY_URL=https://<host> and the secret's",
  '#    placeholder as PRIORITY_PASSWORD (open question for the Comis maintainers:',
  "#    the command that publishes a manual service's placeholder variables).",
  '# 5. Run `comis config check`.',
  '#',
  '# The password goes only to the four Priority REST routes priority-axi uses.',
  '# Reads pass. A create asks the owner first. $batch, every write to user,',
  '# privilege, token and system-setting screens, and every update or delete are',
  '# refused. Answers from screens that hold credentials are withheld.',
  'services:',
  '  priority:',
  '    hosts:',
  '      - erp.example.com',
  '    scheme: https',
  '    credential:',
  `      secret: ${entry.credential.secret}`,
  `      inject: ${entry.credential.inject}`,
  '      match:',
  ...entry.credential.match.map((m) => `        - ${q(m)}`),
  '    writes:',
  ...entry.writes.map(
    (w) => `      - {match: ${q(w.match)}, decide: ${w.decide}}`,
  ),
  '    secret_responses:',
  ...entry.secret_responses.map((m) => `      - ${q(m)}`),
  'profiles:',
  '  trusted:',
  '    services: [priority]',
  '',
];
const text = lines.join('\n');
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== text) {
    console.error(
      'comis/templates/priority.yaml is out of date; run node scripts/comis-template.mjs',
    );
    process.exit(1);
  }
} else {
  writeFileSync(target, text);
}
