# Contributing to priority-axi

Thank you for helping. This guide covers how to set up the project, what a good change looks like, and how changes are reviewed.

## Before you start

- **Bugs:** open an [issue](https://github.com/comisai/priority-axi/issues) with the command, its output and what you expected.
- **Features and larger changes:** open an issue first, so we can agree on the approach before you write code.
- **Security problems:** do not open a public issue. Follow [SECURITY.md](SECURITY.md).
- **Real data:** never paste passwords, server addresses or real customer data into issues, pull requests, tests or fixtures.

## Setup

You need Node.js 22.18 or later. Node runs the TypeScript sources directly, so tests need no build step.

```sh
git clone https://github.com/comisai/priority-axi.git
cd priority-axi
npm ci
npm run check       # type-check, lint, unit and contract tests
npm run build       # dist/bin/priority-axi.js
npm run test:dist   # contract and AXI-principle tests against the built CLI
```

`npm run format` formats the code with Biome.

## Project layout

| Path | What it holds |
| --- | --- |
| `src/cli/` | Argument parsing and the command table |
| `src/commands/` | One module per command: `get`, `show`, `changes`, `find`, `create` and the others |
| `src/index/` | The screen index built from Priority's metadata, the cache, and `find`'s local catalog |
| `src/output/` | TOON rendering, size bounds, text safety and row shaping |
| `src/http.ts`, `src/odata.ts`, `src/errors.ts` | Requests, OData query building, and the error codes |
| `test/unit/`, `test/contract/` | Unit tests, and end-to-end tests of the CLI against a fake Priority |
| `test/axi/` | The ten AXI principles, checked against the CLI |
| `test/fake/` | The fake Priority server the tests use |
| `test/live/` | Opt-in checks against a real Priority server |
| `comis/` | The Comis connector bundle: catalog entry, Gate template, skills and wrapper |
| `docs/` | Design and plans |

## What a good change looks like

priority-axi is used by AI agents, so its output is part of its interface. Keep to these rules; `test/axi/principles.test.ts` checks most of them:
- **Output:** results go to stdout as TOON, starting with a summary line. Output stays within the size limits unless `--full` is given.
- **Hints:** each hint is one line that starts with ``Run `priority-axi …` ``.
- **Errors:** an error prints `message`, `code` and `usage` on stdout. The exit code is 1 for an error and 2 for a usage error. Reuse an existing code before adding a new one.
- **Writes:** a write is sent once and never retried. Every field is checked against the metadata before sending.
- **Secrets:** a password never appears in output, errors or logs.
- **Data from Priority is untrusted.** It goes through the text-safety layer in `src/output/text.ts`. Write invisible or bidirectional characters in source as `\u` escapes, never as literal characters.
- **Dependencies:** the only runtime dependency is `@toon-format/toon`, pinned exactly. Discuss any new dependency in an issue first.
- **Wording:** messages, help and docs use short, plain English sentences.

Add or update tests with every change. Extend `test/fake/priority-fake.ts` when the fake needs to model new server behaviour, and write down in the pull request what the real server does. When behaviour changes, update the README, the `--help` text and, if needed, the Comis skills in `comis/skills/`.

## Live tests

`test/live/priority-live.mjs` runs read-only checks against a real Priority server. Run it with `--help` to see its options. It needs your own server and API user:
- **Credentials:** put `PRIORITY_URL`, `PRIORITY_COMPANY`, `PRIORITY_USER` and `PRIORITY_PASSWORD` in a local env file, such as `test/live/.env.local`, and run `node --env-file=test/live/.env.local test/live/priority-live.mjs`. Git ignores `.env*` files; never commit credentials.
- **Writes:** the live tests write only with `--write` and `PRIORITY_LIVE_WRITES=1`. Each create uses a paid API transaction, so write only to a test company you are allowed to change.
- **Reports:** reports in `test/live/reports/` stay local and are not committed.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep each pull request to one topic.
3. Run `npm run check`, `npm run build` and `npm run test:dist`. Continuous integration runs the same checks on Node 22 and 24.
4. Fill in the pull request template: what changed, why, and how you tested it.

`main` is protected. Every change goes through a pull request whose checks pass, and is squash-merged by a maintainer.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
