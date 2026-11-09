# priority-axi: implementation plan

| | |
| --- | --- |
| Status | Ready to build. Live read and write qualification is blocked on the Priority administrator. |
| Date | 2026-11-05 |
| Design | `priority-axi-design.md` (updated today with the QA findings) |
| Master plan | `priority-axi-master-plan.md` |
| Live test | `test/live/priority-live.mjs` |

## 1. Summary

This plan breaks the design into tasks you can build and test. It starts from a live check of the QA system, run today.

**What works:**
- connecting to the server
- signing in
- checking the company
- downloading the metadata

**What is blocked:** not one of the 1,328 business screens is enabled for the API. Reading records and creating them therefore cannot be proven on the live system yet.

Everything that does not need a live record can be built now. The AXI is built against the recorded metadata and a fake server, and the fake copies what the live system actually returns. The live test is the referee: each milestone ends when it passes.

## 2. QA environment check, 2026-11-05

Target: `https://<qa-host>/odata/Priority/tabula.ini/a150125`, user `API`. Command:

```sh
PRIORITY_URL=https://<qa-host>/odata/Priority/tabula.ini/a150125 \
PRIORITY_USER=API PRIORITY_PASSWORD=… node test/live/priority-live.mjs
```

| Stage | Result | Evidence |
| --- | --- | --- |
| S1 config | pass | All settings present; the service root was split into origin, ini and company |
| S2 reach | pass | Service document in 114 ms: 1,329 screens and 3 functions. Server Kestrel behind IIS. |
| S3 auth | pass | An unknown user or no credentials gets 401 with an empty body and `WWW-Authenticate: Basic` |
| S4 versions | pass | Priority 23.1, OData 3.0.203.3807, bin 3.0.74.46203. `GetLoginName()` answers 404. |
| S5 company | pass | `GETCOMPANIES` lists `a150125`, "חברת בדיקות 15/01/25" (a test company). A bad company gets the 400 company message. `GetPriorityVersion()` accepts any company. |
| S6 metadata | pass | 7.3 MB of JSON metadata in 1.9 s, uncompressed. 1,329 screens, 2,990 types, 35,878 fields, 3,056 sub-screen links. Indexed in 23 ms. |
| S7 screen access | **blocked** | 0 of 12 common screens. `--sweep` gives 0 of 1,328. All answer `לא ניתן להפעיל API למסך זה.` |
| S8 error mapping | pass | Unknown screen: 404, empty body, about 2 s. The not-enabled text was matched in Hebrew and in English (`,3`). `substringof`: 400. `/$count`: 500. `GetMetadataFor`: 404. |
| S9 query semantics | **blocked** | Needs one enabled screen. Q1 to Q3 stay open. |
| S10 one create | skip | Read-only run. Writes need the owner's authorization. |

`--strict` exits 1 on this result, so the phase-0 gate is closed until screens are enabled.

### 2.1 Findings that change the design

All of these are now in `priority-axi-design.md`.

| # | Finding | Change |
| --- | --- | --- |
| F1 | `GETCOMPANIES` exists and answers without being in API Forms. The design said no call lists companies. | The home view and the first call per cache check the company with it, then cache the result. |
| F2 | Function calls accept any company code. `…/demo/GetPriorityVersion()` answers 200. | `GetPriorityVersion()` alone cannot prove the settings. F1 covers this. |
| F3 | A bad company gets 400 `שם החברה שנשלח לא תקין…`, or in English "There was a problem changing companies…" | New error `company_not_found` |
| F4 | A direct 401 has an empty body. Outside Comis there is no Gate to turn it into 502. | New error `auth_failed`. Inside Comis it stays `reconnect_needed`. |
| F5 | The English not-enabled text says "form", not "screen" | The matcher covers both languages and both words. |
| F6 | `startswith` and `contains` answer 501 `Function "…" is not supported`, at least on `GETCOMPANIES` | New error `unsupported_query`. `~` stays behind Q3. |
| F7 | `/$count` answers 500 | Never sent |
| F8 | An unknown screen answers 404, empty, slowly (about 2 s) | The AXI checks screen names against the index before any call. A typo becomes a local `usage` error that suggests the nearest names. |
| F9 | `GetMetadataFor(entity)` exists. It answers 404 for screens that are not enabled. | New question Q8. It may allow loading one screen's metadata at a time. |
| F10 | Sub-screen links carry Hebrew titles | `fields` shows a title next to each sub-screen. |
| F11 | Owners are given a full service root | `PRIORITY_URL` also accepts a full service root. |

## 3. Build order

1. **Offline core.** Build the index, query builder, TOON output, text safety and error classification as pure functions, tested against recorded fixtures.
2. **Fake Priority.** A small `node:http` server answers exactly as the QA system does (§2). The live test's facts are the fake's specification. When Priority changes, the live test fails first, and the fake is updated to match.
3. **Commands over the fake.** Home view, `screens`, `fields`, `get`, `show`, `changes`, `refresh`, then `create`.
4. **Live qualification.** Once screens are enabled, `priority-live --strict` and the AXI smoke stage (S11, task T18) run against QA.
5. **Release.** Publish to npm with provenance, then integrate with Comis (master plan M7).

## 4. Repository layout

```text
priority-axi/
  package.json                  bin priority-axi; type module; engines node >=22 (Comis runs 24)
  tsconfig.json
  docs/                         design, implementation plan, master plan
  src/
    bin/priority-axi.ts         argv → command → exit code (0 ok, 1 error, 2 usage)
    config.ts                   variables and flags → Settings; splits a service root
    http.ts                     fetch: headers, Basic, timeouts, one 429 retry for reads, never for writes
    errors.ts                   closed error-code set; classify(response) → AxiError; Hebrew and English matchers
    odata.ts                    --where grammar → $filter; typed literals; quote doubling; UTC dates; paths
    index/build.ts              CSDL JSON → compact index (pure)
    index/cache.ts              cache path, atomic write, when to rebuild, reach.json, company check
    index/search.ts             screen search over names, field descriptions and sub-screen titles
    output/toon.ts              TOON encoder wrapper, truncation, help[], error blocks
    output/shape.ts             default columns, drop null and "", date display, 200-character cut
    output/text.ts              visible \uXXXX escapes for invisible characters; credential withholding
    commands/{home,screens,fields,get,show,changes,create,refresh}.ts
  test/
    fixtures/metadata.min.json  cut-down CSDL: GETCOMPANIES, CUSTOMERS, LOGPART, ORDERS with ORDERITEMS
    fixtures/responses/*.json   error bodies recorded by the live test (no personal data)
    fake/priority-fake.ts       fake OData server
    unit/*.test.ts              node:test
    contract/*.test.ts          the built binary against the fake
    axi/principles.test.ts      the ten AXI principles against the built binary
    live/priority-live.mjs      live qualification (exists)
  .github/workflows/ci.yml      lint, typecheck, unit, contract, principles
  .github/workflows/release.yml npm publish --provenance on a tag
```

**Dependencies:**
- **Runtime:** only `@toon-format/toon`, pinned exactly to 4.4.0, as Comis pins it. T2 dropped `axi-sdk-js` (see §6.1).
- **Development:** `typescript` only.
- **Test runner:** `node:test`.

The fixture metadata is cut from Priority's standard schema, which holds no records. Field descriptions are kept because search depends on them.

## 5. Module contracts

```ts
type Settings = { origin: string; ini: string; company: string; user: string; password: string };
// config.ts: PRIORITY_URL may be an origin or a full service root; flags win over variables.
function readSettings(env: NodeJS.ProcessEnv, flags: Flags): Settings | AxiError; // not_connected | missing_setting

type Field = { name: string; type: string; max?: number; description?: string;
               readOnly: boolean; internalId: boolean; dateType?: 'Date' | string };
type Screen = { name: string; key: string[]; fields: Field[];
                subs: { name: string; screen: string; title?: string }[] };
type Index = { version: string; builtAt: string; company: { code: string; title: string };
               screens: Map<string, Screen> };
function buildIndex(csdl: unknown, version: string): Index;            // pure; tested on the fixture
function loadIndex(s: Settings, opts: { refresh?: boolean }): Promise<Index>; // rebuild rules: design §8.3

type ErrorKind = 'not_connected' | 'missing_setting' | 'auth_failed' | 'company_not_found'
  | 'screen_not_enabled' | 'reconnect_needed' | 'held_for_approval' | 'refused' | 'not_found'
  | 'already_exists' | 'priority_rejected' | 'unsupported_query' | 'rate_limited'
  | 'priority_error' | 'unreachable' | 'usage';
type AxiError = { error: ErrorKind; hint: string; exit: 1 | 2; fields?: Record<string, string> };
function classify(res: HttpResult, ctx: { screen?: string; write: boolean }): AxiError | null;

function whereToFilter(where: string[], screen: Screen): string | AxiError; // usage on an unknown field or bad value
function literal(field: Field, raw: string): string | AxiError;             // 'it''s', 42, 2026-10-01T00:00:00Z
```

The classifier's matchers, tried in order:
1. `Comis-Action` on a 409 → `held_for_approval`.
2. `Comis-Refusal` → `refused`, or `reconnect_needed` for the Gate's 502.
3. 401 → `auth_failed`.
4. 400 not-enabled text → `screen_not_enabled`.
5. 400 company text → `company_not_found`.
6. 404 → `not_found`.
7. 409 → `already_exists`.
8. 429 → `rate_limited`.
9. 501 → `unsupported_query`.
10. Any other 400 → `priority_rejected`.
11. 5xx → `priority_error`.
12. Network failure → `unreachable`.

## 6. Work breakdown

The size is in working days for one developer. "Live" says whether the task needs the QA system.

### M2: foundations and reads on the fake (can start now)

| ID | Task | Output and test | Size | Depends | Live |
| --- | --- | --- | --- | --- | --- |
| T1 | Scaffold the repository, CI, exact pins, `node:test` | CI passes on an empty test | 0.5 | — | no |
| T2 | Spike `axi-sdk-js` and the TOON encoder: what they give (help, errors, encoding) and what stays ours | **Done.** Decision in §6.1: own runtime, no SDK | 0.5 | T1 | no |
| T3 | `config.ts`: variables, flags, service-root split, `not_connected`, `missing_setting` | Unit tests, including a full service root and conflicting flags | 0.5 | T1 | no |
| T4 | `index/build.ts` and the cut-down fixture. An opt-in golden test on the full QA metadata (1,329 / 2,990 / 35,878) reads a local file that is not committed. | Unit tests: key, read-only, internal ID, dates, sub-screens with titles | 1 | T1 | no |
| T5 | `index/cache.ts`: path from the hash of origin, ini and company; atomic rename; rebuild on version change, after 7 days, or on `refresh`; `reach.json`; cached company check (F1) | Unit tests, including a crash between write and rename | 1 | T4 | no |
| T6 | `output/*`: TOON, truncation with "more exist", `--full`, null and "" handling, dates, visible escaping and credential withholding | Unit tests with Hebrew values | 1 | T2 | no |
| T7 | `errors.ts`: the matchers in §5, using the response bodies the live test recorded | One unit test per error kind | 0.5 | T1 | no |
| T8 | `odata.ts`: the `--where` grammar, typed literals, quote doubling, UTC `Z` dates, raw `--filter`; refuse `%` in write paths | Unit tests, including `O'Brien`, Hebrew values and numbers | 1 | T4 | no |
| T9 | Fake Priority: service document, JSON `$metadata`, `GetPriorityVersion()`, `GETCOMPANIES`, collections with `$filter` (eq, ne, gt, ge, lt, le, and, or), `$select`, `$top`, `$skip`, `$orderby`, `$expand`, `$since`; the 400 not-enabled and bad-company answers, 404 with an empty body, 401 with a challenge, 501, and 429 with `Retry-After` | Self-tests. Its errors match `test/fixtures/responses/`. | 1.5 | T4 | no |
| T10 | Home view (F1, F2) | Contract test: connected, not connected, bad company | 0.5 | T5, T6, T9 | no |
| T11 | `screens` and `fields`, offline over the index, with nearest-name suggestions (F8) | Contract tests | 1 | T5, T6 | no |
| T12 | `get`: ask for limit + 1, `--page`, default columns, `--fields`, `--full`, `--with` | Contract tests | 1.5 | T8, T9 | no |
| T13 | `show` (key through `$filter`) and `changes` (`$since`) | Contract tests | 0.5 | T12 | no |
| T14 | `refresh`, `--help` for every command, `--version` | Contract tests | 0.5 | T10 | no |
| T15 | AXI principles test (D240): TOON, totals or "more exist", empty state, errors on stdout, exit codes, home view, hints, short help | Passes against the built binary | 1 | T10–T14 | no |

### 6.1 Progress (2026-11-05)

| Task | Status | Evidence |
| --- | --- | --- |
| T1 scaffold | Done | `package.json`, `tsconfig*.json`, `biome.json`, CI (Node 22 and 24). The toolchain matches Comis: TypeScript 7.0.2, Biome 2.5.15. |
| T2 spike | Done | Decision below |
| T3 config | Done | `src/config.ts`; `test/unit/config.test.ts` |
| T4 index | Done | `src/index/build.ts`; fixture `test/fixtures/metadata.min.json` cut by `scripts/cut-metadata.mjs`; golden test passes on the full QA metadata |
| T5 cache | Done | `src/index/cache.ts`; `test/unit/cache.test.ts` |
| T6 output | Done | `src/output/{toon,text,shape}.ts`; `test/unit/output.test.ts` |
| T7 errors | Done | `src/errors.ts`, using the Gate's real refusal codes (`approval_pending`, `reconnect_needed`); `test/unit/errors.test.ts` |
| T8 odata | Done | `src/odata.ts`; `test/unit/odata.test.ts` |
| HTTP client | Done | `src/http.ts`: one read retry after a short 429, writes sent once, redirects not followed; `test/unit/http.test.ts` |
| CLI runtime | Done | `src/cli/{table,parse,run}.ts`: one command table drives parsing, help and usage |
| T9 fake | Done | `test/fake/priority-fake.ts`: records, a `$filter` parser (eq, ne, gt, ge, lt, le, and, or, parentheses), `$select`, `$top`, `$skip`, `$orderby`, `$expand` with options, `$since`, deep insert, 409 duplicates, required-field 400s, the QA error answers, 501 for `startswith` and `contains`, the Gate hold and reconnect, a 429, and a log of every request |
| T10 home view | Done | Live on QA, and in `test/contract/binary.test.ts` |
| T14 `refresh`, help, version | Done | Live on QA: 1,329 screens, 2,990 types and 35,878 fields from 7.3 MB in 1.9 s |
| T11 `screens`, `fields` | Done | Search over names, sub-screen titles and Hebrew descriptions; nearest-name suggestions |
| T12 `get` | Done | Limit + 1 for "more exist", `--page`, default columns, `--fields`, `--with`, `--sort`, `--where`, `--filter`, `--full` |
| T13 `show`, `changes` | Done | Compound keys through `--key F=V`; single-record sub-screens; `--since 7d`, `24h` or a date |
| T15 AXI principles | Done | `test/axi/principles.test.ts` against the real binary, source or `dist` |
| T18 live S11 | Done | Passes on QA: the shipped binary runs end to end and maps `screen_not_enabled` |
| T19, T20 `create` | Done | `--set`, `--line <SUB> F=V`, `--json-file`, `--dry-run`, type and length checks, sent once, every answer mapped |
| T22 docs and help | Done 2026-11-06 | README rewritten: administrator setup, examples (run against the fake), error codes, writes, license. `--help` reviewed: a required flag shows without brackets (`changes --since`), `create --line <SUB> <F=V>...`, the 500 and 2000 caps stated, and the create hint no longer claims an approval outside Comis. `LICENSE` (MIT) and `NOTICE` (TOON attribution, Priority trademark) ship in the package, enforced by `check-package`. Recheck the wording after T17. |
| T23 release | Done 2026-11-09 | `.github/workflows/release.yml` (tag, provenance, refuses a private repository) published 0.1.0 from the `npm` environment, which only `v*` tags can use; `scripts/check-package.mjs` in CI |
| T16 live sweep and strict | Done 2026-11-08 | The administrator enabled CUSTOMERS, SUPPLIERS, LOGPART, ORDERS, CINVOICES, CURRENCIES, plus PORDERS and FMEC_PRDISINGLE. `--sweep`: 8 of 1,328 enabled. `--strict`: 10 pass, 0 fail, 1 skip (S10), on CUSTOMERS and again on CINVOICES. Reports in `test/live/reports/` (not committed). |
| T17 act on Q1–Q3, Q8 | Done 2026-11-08 | Design §15. "More exist" stays (no `$count`). `--with` caps lines on the server. `~` refused before sending. Full metadata stays (no `GetMetadataFor`). Also: cut-off and broken-off answers are mapped, Priority's form errors (`InterfaceErrors`) are read, and S9/S11 handle compound keys. |
| T21 live creates | Done 2026-11-08 | The first two attempts were refused with 400 because QA requires `WTAXNUM` (design Q9); no record was made. The owner chose the placeholder `000000018` (it passes the Israeli check digit). Then S10 created `AXILIVE01` (201), and `priority-axi create` created `AXILIVE02`. Both were read back with `get` and `show`. Cost: 1 API transaction per record by the AXI's estimate, since Priority reports no counter; the 2 refused POSTs made no record. W1: 2 of 5 records used. Priority copies `WTAXNUM` into `VATNUM`. |
| Deep live coverage (S12) | Done 2026-11-08 | New opt-in `priority-live --deep`: the built AXI over every enabled screen (fields, paging, sort, `--fields`, `show` with single and compound keys, key, range, text and date filters, every sub-screen with `--with`, `changes`, `--full`) plus the error paths. First run: 291 AXI runs over 7 screens, one failure: `changes CURRENCIES`, fixed by mapping Priority's "$since needs BPM" answer (design Q10). Date ranges find a record's own date on every screen, although QA returns dates with +02:00 and +03:00. Every sub-screen reads. Writes, by hand under W1: a duplicate `AXILIVE01` answers 409 and maps to `already_exists`; `AXILIVE03` with one `CUSTPERSONNEL` line was created in one deep insert (2 transactions) and read back. W1: 3 of 5 records used. Second run, all 8 enabled screens (FMEC_PRDISINGLE has no records): `--strict --deep` 11 pass, 0 fail; 291 AXI runs, median 266 ms. Finding: every PORDERS read takes about 84 s on QA (S7's PORDERS probe is about 80 s too), close to the AXI's 90 s read timeout and likely beyond a Gate read limit. That is the server's cost; raise it with the administrator before relying on PORDERS. *Answered 2026-11-09 (design Q13):* without a filter Priority goes through every purchase order before it answers: one record takes 86 s, 10,000 take 89 s. A filtered read takes 1 to 3 s (by number, supplier or date range; `changes` 2 s). The read skill now filters every read of a document screen. |
| `find` and the plumber order workflow | Done 2026-11-08 (live orders sent) | The new `priority-axi find <SCREEN> <words>` keeps a local, daily catalog and searches it in Hebrew:
- **Catalog:** 37,172 parts are copied in about 35 s the first time; later searches take about 0.1 s.
- **Matching:** words match at a word start, after Hebrew prefix letters. Numbers match only whole numbers standing on their own. Inactive records are left out unless `--all`. When nothing has every word, the closest records are shown.
- **Sub-screens:** `--sub` searches sub-screen lines with their parent, so `find CUSTOMERS --sub CUSTPROJECTS` finds projects.
- **Skills:** the read skill covers `find`; the write skill turns a plumber's message into a draft order, with the catalog's sizes, lengths, classes and finishes.

**Comis-view live test:** an agent given only the skills, behind a simulated Gate that holds every create.
- Run 1 sent 2 orders to the owner's approval queue and asked the right question for the third.
- Its findings were fixed: `לבן` matched `מגולבן`, `4` matched `3/4`, plus several skill gaps.
- Run 2 retested on the updated skills. Both orders reached the approval queue, with one question message per plumber: the steel finish and plain or grooved pipe, the elbow angle, and the site name instead of a list of 19 projects.
- Run 2's last findings were also fixed:
  - search the type and size only, so the choices stay visible;
  - the steel finishes are listed;
  - a total length in metres is the quantity;
  - only-a-customer messages are handled;
  - `find --sub` now has a `matched` column (line or parent);
  - the `fields` hint is clearer.
- The live S11 now runs `find` and `find --sub`.
- **Projects screen (2026-11-08).** The administrator opened DOCUMENTS_p.
  - `find` now prefers editable descriptions and also searches a project's customer name, marking each match `own` or `customer`.
  - Cancelled, finished and closed statuses count as not in use.
  - The write skill resolves projects through `find DOCUMENTS_p`, falling back to CUSTPROJECTS.
  - On QA, the name of a large builder customer now returns 8 live projects instead of 19.
- **The Comis-view retest on the projects screen** handled a site named only by its customer, and a cancelled site. Its findings were fixed:
  - when only records not in use match, `find` now says so (`not_in_use`) instead of listing unrelated close matches;
  - the status column shows when the matches differ in status;
  - the home view's `api_screens` became `screens_read`, with a note that it lists only screens read so far;
  - the write skill searches `<type> <use> <size>` (`צינור ביוב 110`: 14 parts instead of 105) and describes the four real kinds of sewer pipe (plain orange SN4, structured SN4/SN8, thick SN8, ULTRA SN4/SN8);
  - the write skill now covers the site question, closed projects, the plumber's answers in the remarks, and one message while approval is pending.

**Sending as the owner (W2):** Priority refused the first draft order because QA had no document numbering (design Q12). After the administrator ran "הכנת תבניות מספר לתעודות", the three held orders were sent once each and read back. All three are drafts (`טיוטא`) with the project, items and remarks as sent:
- SO26000001: one project, one item line (6 pipes);
- SO26000002: another project, two item lines (10 m of steel pipe, 2 elbows);
- SO26000003: a third project, chosen after the plumber's first site was cancelled, one item line (2 pipes).

W2: 3 of 3 used. Priority stores the remarks as HTML; `show` and `get --with` now print a remarks sub-screen's TEXT as plain text, and live S12 checks it. Live `--strict --deep` on ORDERS, CUSTOMERS, LOGPART and DOCUMENTS_p: 12 stages pass, 217 AXI runs, 14 remarks sub-screens read as plain text. One read of DOCUMENTS_p > CUSTOBLIGO got Priority's own `Status(StatusCode="Unknown", Detail="EOF")` (mapped to `priority_error`); the same read passed right after. |
| T24 | Done 2026-11-09 | `priority-axi@0.1.0` is on npm with verified provenance. Live `--strict` passes on QA with the npm-installed package. |

**Test results:** 198 tests (unit, contract and AXI principles), all passing, plus one opt-in golden test. CI also runs the contract and principles tests against the built `dist`. Type-check and lint are clean.

**T2 decision: no `axi-sdk-js`.** Comis D240 rejects it for Comis's own AXI. The reasons, checked against `axi-sdk-js` 0.1.13:
- It reserves a built-in `update` command that runs `npm install -g`. A read-only image must never run that.
- It validates no flags.
- It pins `@toon-format/toon` ^2 while Comis pins 4.4.0.
- It prints errors as `error`, `code` and `help`, not Comis's `message`, `code` and `usage`.

priority-axi copies Comis's runtime instead:
- `node:util` `parseArgs`, with the fixture's refusal rules: unknown flags, repeats, extra arguments and values on boolean flags are refused, and a refusal names the flag but never its value.
- One command table.
- `@toon-format/toon` 4.4.0, pinned exactly.

**Design changes made while building**, recorded in the design doc:

| # | Change | Why |
| --- | --- | --- |
| B1 | Errors print `message`, `code` and `usage`, plus extra fields (design §8.6) | The Comis AXI fixture's error contract |
| B2 | Long text is cut at 500 code points with Comis's marker. Output fits 4,000 UTF-16 units. `--full` allows up to 262,144 bytes, then `output_too_large`. | D240 and D380 |
| B3 | At most four default columns | The fixture's list rule: three or four fields per row |
| B4 | Invisible characters are escaped visibly, not stripped. Credential-shaped values are withheld. | D380. Escaping keeps the evidence that stripping would hide. |
| B5 | Screen names are matched case-sensitively first, then by a unique case-insensitive match | QA has `DOCUMENTS_e`, `eDOCSTATS` and `DEFINETRANSqLOAD` |
| B6 | Empty values print `null` in tables; a single record drops them | TOON keeps its compact table form only when every row has the same columns |
| B7 | `--ini` and `PRIORITY_INI` refuse anything outside `[A-Za-z0-9._~-]`, including the `,3` language suffix | The Gate's named segment cannot match a comma |

Facts from the QA metadata that shape T11–T13:
- 1,203 screens have multi-field keys.
- 329 types have no key.
- 624 sub-screens hold a single record, not a list.

So `show` must accept compound keys, and `--with` must print a single-record sub-screen as one record, not a table.

### M3: read qualification on QA (needs screens enabled, master plan M1)

| ID | Task | Output and test | Size | Depends | Live |
| --- | --- | --- | --- | --- | --- |
| T16 | Run `priority-live --sweep`, then `--strict` | S7 and S9 pass; the report is archived | 0.25 | M1 | yes |
| T17 | Act on the answers to Q1 to Q3 and Q8: totals or "more exist", client-side caps inside `$expand`, `~` on or off, lazy per-screen metadata | Code and fake updated, contract tests green | 1 | T16 | no |
| T18 | Add stage S11, "AXI smoke", to `priority-live`. It runs the built `priority-axi`: home view, `screens`, `fields`, `get --limit 3`, `show`, `changes --since`, and one bad screen. It checks exit codes and the TOON shape. | S11 passes on QA | 0.5 | T15, T16 | yes |

### M4 and M5: creates and write qualification

| ID | Task | Output and test | Size | Depends | Live |
| --- | --- | --- | --- | --- | --- |
| T19 | `create`: checks before sending (fields exist, not read-only, not internal, types, lengths), deep-insert body, `--json-file`, `--dry-run`, transaction estimate | Unit and contract tests | 1.5 | T12 | no |
| T20 | Map create answers: 201, 409 with `Comis-Action`, 409 duplicate, 400, 403 with `Comis-Refusal`. Never retry. The write timeout is 120 s. | Contract tests. The fake counts POSTs, so the test proves exactly one was sent. | 0.5 | T19 | no |
| T21 | Write qualification on QA: one `priority-live --write` (S10), then one `priority-axi create`, with the owner's authorization (master plan W1) | Two records created, keys and transaction cost recorded | 0.25 | T20, M3, W1 | yes |

### M6: release 0.1.0

| ID | Task | Output and test | Size | Depends | Live |
| --- | --- | --- | --- | --- | --- |
| T22 | README, `--help` wording review (plain English), NOTICE | Review done | 0.5 | M3 | no |
| T23 | Release workflow: `npm publish --provenance` from GitHub Actions; check the provenance with the same logic as Comis's `scripts/axi-publishers.mjs` | `npm view priority-axi` shows the provenance | 0.5 | T22, Q7 | no |
| T24 | Tag 0.1.0 and rerun the live test against the published package | S1 to S11 pass | 0.25 | T23 | yes |

**Total for M2 to M6:** about 18 working days. That covers T1–T24 including the quarter-day live runs, for one developer, and excludes waiting on the administrator.

## 7. Test plan

| Layer | What it proves | Where | When | Needs |
| --- | --- | --- | --- | --- |
| Unit | Pure modules: index, query builder, literals, errors, output | `test/unit` | Every commit, in CI | nothing |
| Contract | The built binary against the fake: every command, every error kind, exactly one POST per create | `test/contract` | Every commit, in CI | nothing |
| AXI principles | The ten principles (D240) | `test/axi` | Every commit, in CI | nothing |
| **Live** | The QA system behaves as the fake assumes. The AXI works on it end to end. | `test/live/priority-live.mjs` | Each milestone gate, each release, after a Priority upgrade, and weekly while building | QA credentials. Never in public CI. |
| Comis proofs | Gate custody, approvals and refusals (design §13) | Comis `tests/integration/connectors` | Phase 2 | the Comis repository |

### 7.1 The live test

`test/live/priority-live.mjs`. It has no dependencies and needs Node 22 or later. Its output is TOON, and it writes a JSON report to `test/live/reports/`.

| Stage | Proves | Guards |
| --- | --- | --- |
| S1 config | Settings present; the service root splits | `not_connected`, `missing_setting`, F11 |
| S2 reach | DNS, TLS and the service document | `unreachable` |
| S3 auth | A 401 is empty with a Basic challenge. The probe uses a username that does not exist, so it never counts toward locking the real user. | `auth_failed`, F4 |
| S4 versions | `GetPriorityVersion()` with and without `()`; `GetLoginName` behaviour | Home view, Q5 |
| S5 company | `GETCOMPANIES`, the bad-company text, and that function calls do not check the company | F1, F2, F3 |
| S6 metadata | JSON CSDL: size, time, compression, counts, annotations; indexing time | Design §8.3, Q4 |
| S7 screen access | Which screens are in API Forms (`--screens` or `--sweep`, 4 at a time) | `screen_not_enabled`, phase-0 gate |
| S8 error mapping | 404 shape, not-enabled text in both languages, `substringof`, `/$count`, `GetMetadataFor` | F5–F9 |
| S9 query semantics | `$top`, `$select`, `$skip` paging, `$orderby`, key `eq`, row shape, dates; answers Q1, Q2, Q3, `contains`, `$since` | Design §8.4 |
| S10 one create | One POST, never retried, transaction estimate. Needs `--write`, `PRIORITY_LIVE_WRITES=1`, `--write-screen` and `--write-body`. | Design §8.5 |
| S11 AXI smoke | The built `priority-axi` against the live server: `--version`, home, `refresh`, `screens`, `fields`, `get`, `changes`, `show` when a record exists, and usage errors. Each must have empty stderr, no password in its output and default output within 4,000 units. `--axi <path>` or `--axi none` | The shipped binary |

**Verified so far:**
- S1–S8 have run against QA.
- S7 pass, S9 and S10 cannot run on QA yet, so they were run on 2026-11-05 against a local fake Priority. Plain `http` is accepted only for `localhost` and `127.0.0.1`.
- On the fake:
  - The query checks answered Q1–Q3 with fake data.
  - A write without `PRIORITY_LIVE_WRITES` is blocked.
  - A body with a read-only field is refused before sending.
  - An allowed write sends exactly one POST, with the right estimate.
  - A wrong password stops the run at S2.
- That fake grew into `test/fake/priority-fake.ts` (T9).

Exit codes:
- 0: no failures. Blocked stages are allowed.
- 1: any failure, or any blocked stage with `--strict`.
- 2: usage error.

**Safety rules:**
- Read-only by default.
- The password is never printed or stored, and the report is scrubbed before it is written.
- `--sweep` costs about 1,300 small GETs, so run it at most once a day.
- Run against QA only. A production read-only run needs the owner's go-ahead.

```sh
# test/live/.env.qa holds PRIORITY_URL, PRIORITY_COMPANY, PRIORITY_USER and PRIORITY_PASSWORD; gitignored
node --env-file=test/live/.env.qa test/live/priority-live.mjs            # daily check
node --env-file=test/live/.env.qa test/live/priority-live.mjs --sweep    # after the admin changes API Forms
node --env-file=test/live/.env.qa test/live/priority-live.mjs --strict   # milestone gate
PRIORITY_LIVE_WRITES=1 node --env-file=test/live/.env.qa test/live/priority-live.mjs \
  --write --write-screen CUSTOMERS --write-body test/live/create-customer.json   # only with W1
```

### 7.2 Keeping the fake honest

The live test's facts are the fake's specification. These values become fixtures:
- error bodies
- status codes
- empty bodies
- the challenge header
- the company text

Then:
1. Contract tests check that the fake returns the recorded bodies byte for byte.
2. The live test checks that QA still matches the same matchers.
3. If Priority changes, S3, S5 or S8 fails first, and the fake is updated in the same change.

## 8. What is not in this plan

These belong to the master plan:
- Comis connector work (design §12, C1–C8)
- Hardening (C4 updates, C6 access tokens, C2b company pinning, C5b public `--url`)
- Gate size and time limits for the 7.3 MB metadata (Q4, second half)
