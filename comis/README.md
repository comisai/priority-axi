# Comis connector bundle (M7, M8)

This folder holds everything the Comis repository needs to connect Priority through `priority-axi`. It lives here, and is tested here against the real AXI, until `priority-axi` is published to npm (M6). The Comis changes cannot land before that: a pack installs AXIs only from its npm lock, with provenance checked (D335).

| File | Comis change | Goes to, in the Comis repository |
| --- | --- | --- |
| `key-services/priority.json` | C1: the catalog entry, owner-network form | `catalog/key-services.json`, key `priority` |
| `templates/priority.yaml` | C5a: a manual Gate service for a server on a public host other than Priority Cloud (the owner's case) | `images/packs/apps/templates/priority.yaml`, plus a section in `catalog/README.md` |
| `skills/priority/SKILL.md` | C2: the read skill (`main reader`) | `images/packs/apps/skills/priority/SKILL.md` |
| `skills/priority-write/SKILL.md` | C2: the create skill (`main` only) | `images/packs/apps/skills/priority-write/SKILL.md` |
| `bin/priority-axi` | C3: the pack wrapper | `images/packs/apps/bin/priority-axi` |
| `hardening.md` | M9: C4, C6, C2b and C5b proposals | Input for their decision records |

## What is proven here

`test/contract/comis-bundle.test.ts` checks the bundle against the AXI itself:
- **Routes:**
  - it runs every command (home view, `refresh`, `screens`, `fields`, `get` with `--with`, `show`, `changes` and a real `create`) against the fake Priority, and records every HTTP request;
  - each recorded request matches the credential's `match` list, so the Gate injects the password for it;
  - each GET stays a read, and each POST resolves to `ask`.
- **Refusals:**
  - DELETE, PATCH, PUT, `$batch`, keyed paths such as `ORDERS('SO1')`, and writes to the user, privilege, token and system-setting screens resolve to `deny`;
  - the password is never sent to `/webui`, `/mcp`, the `,3` language suffix or extra path segments.
- **Template:** `templates/priority.yaml` is generated from the entry by `scripts/comis-template.mjs` and checked to be in sync.
- **Skills and wrapper:**
  - the skills use flat string metadata and name only commands that exist;
  - the reader skill never mentions `create`;
  - the wrapper turns on `NODE_USE_ENV_PROXY` and runs the published bin path.

The matcher in that test follows the Gate rules as the design records them: paths only, `{name}` matches `[A-Za-z0-9._~-]+`, and `{A|B}` matches one listed literal. The Comis proofs (C7) must still run the real Gate.

## Landing it in Comis (after M6)

1. **C3: the pack and the provenance check.**
   - Add `"priority-axi": "<version>"` to `images/packs/apps/package.json` and refresh its lock.
   - Add `comisai/priority-axi` to `scripts/axi-publishers.json`.
   - Extend `axis()` in `scripts/axi-publishers.mjs` to read `images/packs/*/package-lock.json`.
   - Copy the wrapper, and add `priority-axi` to `doctor/probe` and `NOTICE`.
   - This needs a decision record amending D335.
2. **C1: the catalog entry.**
   - Merge `key-services/priority.json` into `catalog/key-services.json`.
   - Add `priority` to the CLI's token-service list and to the key page's help.
3. **C2: the skills.** Copy both skills.
4. **C5a: the template.** Copy `templates/priority.yaml` and add a "Priority" section to `catalog/README.md` modelled on the GitLab and Gitea sections.
5. **C7: proofs.** Add a fake Priority to `tests/integration/connectors/`; `test/fake/priority-fake.ts` is the reference for its answers. Then run the design §13 proofs:
   - `priority-reads`
   - `priority-placeholder-host`
   - `priority-reconnect-needed`
   - `priority-response-custody`
   - `priority-writes`
   - `priority-refusals`
   - `priority-record-source-binding`
6. **C8: documentation.** Add `docs/priority.md`, covering:
   - what the owner asks the Priority administrator for (master plan §7)
   - the commands
   - the refusals

## Open questions for the Comis maintainers

1. **Placeholders for a manually configured service (C5a).**
   - The Gitea and GitLab templates say to keep the token under a secret name.
   - This bundle could not confirm from the docs which command publishes a manual service's placeholder and URL variables into the workbench's `workbench.env`.
   - Step 4 of the template is marked as this open question.
2. **The Priority Cloud form.**
   - A cloud entry swaps `network` and `url_variable` for fixed `hosts` and `scheme: https`.
   - The AXI still needs `PRIORITY_URL`. Either the entry sets a fixed value per region, or the AXI gets a cloud default.
   - Decide this before shipping the cloud form. Today only the owner-network form and the C5a template are here.
3. **Literal segments.**
   - `GetPriorityVersion()` and `$metadata` are literal path segments. The design recorded that the Gate's literal segments may hold `$` and `()`.
   - Confirm this in `policy.py` when C1 lands.
