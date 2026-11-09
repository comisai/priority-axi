# priority-axi

[![CI](https://github.com/comisai/priority-axi/actions/workflows/ci.yml/badge.svg)](https://github.com/comisai/priority-axi/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/priority-axi.svg)](https://www.npmjs.com/package/priority-axi)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A command-line tool that lets AI agents read and create records in Priority ERP through its REST API (OData).

priority-axi is an AXI, an agent experience interface. Every command:

- prints compact [TOON](https://github.com/toon-format/toon) text on stdout, bounded in size;
- checks its input against the server's own metadata, and says exactly what is wrong;
- ends with hints for the next command;
- sends a write once and never retries it.

It was built to run inside Comis, behind the Comis Gate, and it works just as well on its own.

> **Status:** early development (0.x). Reads and creates are tested end to end against Priority 23.1.

## Requirements

- Node.js 22.18 or later.
- A Priority server with the REST API, an API user, and the screens you need opened to the API ([see below](#priority-administrator-setup)).

## Install

```sh
npm install -g priority-axi
```

Each release is published from GitHub Actions with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), so you can check that it was built from this repository. To run from source instead, see [Development](#development).

## Configure

| Variable            | Flag        | Meaning                                                                                |
| ------------------- | ----------- | -------------------------------------------------------------------------------------- |
| `PRIORITY_URL`      |             | `https://host`, or the full service root `https://host/odata/Priority/<ini>/<company>` |
| `PRIORITY_USER`     | `--user`    | The API username                                                                       |
| `PRIORITY_PASSWORD` |             | The password. Inside Comis it is a placeholder that the Gate replaces.                 |
| `PRIORITY_COMPANY`  | `--company` | The company code                                                                       |
| `PRIORITY_INI`      | `--ini`     | The ini file in the URL. The default is `tabula.ini`.                                  |

A flag overrides its variable. Plain `http://` is accepted only for `localhost` and `127.0.0.1`.

### Priority administrator setup

The REST API reads only the screens that the administrator has opened to it. Ask them to:

1. Add the screens you need to **Limited Access / API Forms**, for example CUSTOMERS, LOGPART and ORDERS. Their sub-screens, such as ORDERITEMS, come with them.
2. Give the API user an API license, and only the privileges it needs.

Until then, reads end with `code: screen_not_enabled`. The home view, `screens`, `fields` and `refresh` work without it.

## Usage

```text
priority-axi                                 home view: connection, version, company, next steps
priority-axi screens [<text>]                find screens by name or description
priority-axi fields <SCREEN> [--sub <SUB>]   a screen's fields, key and sub-screens
priority-axi get <SCREEN> [--where F=V]... [--fields A,B] [--with <SUB>]... [--sort F[:desc]] [--limit N] [--page N]
priority-axi show <SCREEN> <key> [--with <SUB>]...
priority-axi changes <SCREEN> --since 7d     recent changes, on screens with a BPM status workflow
priority-axi find <SCREEN> <words>...        records by words in their name or description
priority-axi create <SCREEN> --set F=V... [--line <SUB> F=V...]... [--dry-run]
priority-axi refresh                         rebuild the screen index
priority-axi help [<command>]                every flag of a command
```

Every command that talks to Priority also takes `--company`, `--user` and `--ini`.

```console
$ priority-axi get ORDERS --where CUSTNAME=C1002 --with ORDERITEMS --limit 2
summary: "2 records from ORDERS, more exist"
records[2]:
  - ORDNAME: SO26000102
    CUSTNAME: C1002
    CDES: Example Customer 2 Ltd
    CURDATE: 2026-10-04
    ORDERITEMS[2]{KLINE,PARTNAME,PDES,TQUANT}:
      1,P-100,Part 100,1
      2,P-101,Part 101,2
  - ORDNAME: SO26000105
    ...
help[2]:
  Run `priority-axi get ORDERS --where CUSTNAME=C1002 --with ORDERITEMS --limit 2 --page 2` for the next 2
  Run `priority-axi show ORDERS <ORDNAME>` for one record

$ priority-axi get ORDERS --where NOSUCH=1
message: ORDERS has no field NOSUCH. Run `priority-axi fields ORDERS` to list them.
code: usage
usage: "priority-axi get <SCREEN> [--where <F=V>]... [--filter <odata>] [--fields <A,B>] ..."
```

More examples:

```sh
priority-axi screens customer
priority-axi fields CUSTOMERS
priority-axi show ORDERS SO26000102 --with ORDERITEMS --with ORDERSTEXT
priority-axi changes CUSTOMERS --since 7d
priority-axi find LOGPART צינור ביוב 110
priority-axi create ORDERS --set CUSTNAME=C1001 --line ORDERITEMS PARTNAME=P1 TQUANT=2 --dry-run
```

### Filters

`--where` takes `F=V`, `F!=V`, `F>V`, `F>=V`, `F<V` and `F<=V`. Values are typed from the screen's metadata, so you never write OData quotes. `--filter` passes raw OData for anything else the server supports.

Priority answers 501 to `contains` and `startswith`. For text that starts with `ABC`, use a range: `--where 'F>=ABC' --where 'F<ABD'`.

Always filter large document screens such as orders and invoices. Without a filter, Priority goes through every record before it answers, even when you ask for one.

### Finding records by words

Priority cannot search inside text, so `find` keeps a local copy of a screen's catalog, refreshed daily: the key, description, unit, family and status. It matches as follows:

- **Every word must appear.** A word matches the start of a word, after Hebrew prefix letters, so `ביוב` finds `לביוב`.
- **Numbers match only as whole numbers.** `4` matches neither `4000` nor `SN4`.
- **Spelling variants are ignored:** Hebrew points, final letter forms, and `״`/`׳` against `"`/`'`.

Records that are not in use are left out unless you pass `--all`. When no record has every word, the closest ones are listed with the words they lack. `--sub` searches sub-screen lines together with their parent, for example `find CUSTOMERS --sub CUSTPROJECTS`.

## Output and errors

- **Lists** say how many records they show and whether more exist. Priority reports no totals.
- **Size:** long values are cut at 500 characters, and the whole output at about 4,000. `--full` lifts both limits, up to 256 KB.
- **Text safety:** invisible and bidirectional control characters are shown as `\uXXXX`, and values that look like credentials are withheld. Remarks, which Priority stores as HTML, are shown as plain text.
- **Errors** print `message`, `code` and `usage` on stdout.
- **Exit codes:** 0 on success, 1 on an error, 2 on a usage error.

| Code                                               | Meaning                                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `usage`                                            | The command line is wrong; `usage` shows the right form                                   |
| `not_connected`, `missing_setting`                 | A setting is missing                                                                      |
| `auth_failed`                                      | Priority refused the username or password                                                 |
| `company_not_found`                                | The API user cannot reach that company                                                    |
| `screen_not_enabled`                               | The screen is not in Limited Access / API Forms                                           |
| `not_found`                                        | No record has that key                                                                    |
| `already_exists`                                   | A create clashed with an existing key                                                     |
| `priority_rejected`                                | Priority refused the request; its own message is shown                                    |
| `unsupported_query`                                | Priority cannot run that query                                                            |
| `rate_limited`                                     | Too many requests; wait and try again                                                     |
| `held_for_approval`, `reconnect_needed`, `refused` | Inside Comis: the owner must approve, the owner must reconnect, or the Gate refused       |
| `unreachable`, `priority_error`                    | The server could not be reached, or it failed                                             |
| `output_too_large`                                 | Even `--full` would exceed 256 KB; narrow the query                                       |
| `internal_error`                                   | A bug in priority-axi; please [report it](https://github.com/comisai/priority-axi/issues) |

## Writes

`create` checks every field against the metadata before it sends anything: the field must exist and be writable, and its value must have the right type and length.

- **Dry run:** `--dry-run` shows the request and how many API transactions it will cost: one per record and one per line.
- **Sent once:** a create is never retried. Inside Comis, the Gate holds it until the owner approves it.
- **Fields the metadata does not mark:** Priority may require them, and then refuses with `priority_rejected` and its own message.

## Comis

Comis ships priority-axi in its optional apps pack:

- a read skill, and a write skill that turns a plumber's Hebrew order message into a draft sales order for the owner's approval;
- a Gate catalog entry that injects the password only on the routes priority-axi uses, with a template for a server on a public host.

That integration lives in the Comis repository.

## Development

```sh
npm ci
npm run check       # type-check, lint, unit and contract tests against a fake Priority
npm run build       # dist/bin/priority-axi.js
npm run test:dist   # contract and AXI-principle tests against the built CLI
```

The live tests against a real server are opt-in. Run `node test/live/priority-live.mjs --help` for how to use them. The design is in [`docs/priority-axi-design.md`](docs/priority-axi-design.md).

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first, and follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately, as described in [SECURITY.md](SECURITY.md).

## License

MIT; see [LICENSE](LICENSE). Third-party notices are in [NOTICE](NOTICE).

Priority is a trademark of Priority Software Ltd. This project is not affiliated with or endorsed by Priority Software.
