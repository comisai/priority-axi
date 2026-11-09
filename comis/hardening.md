# M9 hardening proposals

Each item changes the Comis Gate or CLI, a high-risk area under AGENTS.md §6. So each one needs its own decision record, threat note and failure-mode tests before any code. This file is input for those records. It is not a decision.

## C4: `update` through a typed OData key segment

**Need.** Priority updates a record with `PATCH /odata/Priority/<ini>/<company>/ORDERS('SO1')`. A named Gate segment (`[A-Za-z0-9._~-]+`) cannot match `ORDERS('SO1')`, so today the final `* *` rule refuses every update.

**Proposal.** A typed segment `{screen:odata}` that matches `NAME` or `NAME(<key>)`. The key grammar is strict:
- a quoted string with `'` doubled
- an integer
- `F=v` pairs joined by `,`

Never allowed: `/`, `%`, `..`, an unbalanced parenthesis, or a raw quote.

**Failure-mode tests:**
- quote escapes: `'O''Brien'`
- a parenthesis inside a value: `'A(1)'`
- traversal: `ORDERS('..')`, `ORDERS('a/b')`
- encoded forms: `%27`, `%2F`
- compound keys: `F1='a',F2=2`
- whitespace
- a key longer than the field allows
- a method-override header

**AXI work after it lands:**
- `priority-axi update <SCREEN> <key> --set F=V [--dry-run]`, with the same checks as `create`;
- reads still never put a key in the path.

## C6: personal access tokens

**Need.** A Priority personal access token is sent as Basic `<token>:PAT`. The secret sits in the username, which the Gate's `inject: basic` keeps. Owners should be able to revoke a token without changing the API user's password.

**Proposal.**
- A Gate Basic mode `basic-user` with a fixed password, `PAT`.
- The placeholder moves to the username. `PRIORITY_USER` becomes the placeholder and `PRIORITY_PASSWORD` is the literal `PAT`.

**Tests:**
- substitution happens only in the username;
- a request with any other username is refused for the host;
- the response-custody check covers the token.

## C2b: pin the user and company in the connection

**Need.** In v1 the skill asks the owner for the username and company, and the session passes them as flags. A session could name another company the API user can reach.

**Proposal.**
- `comis connect priority` also stores the username and company.
- The Gate pins `credential.user` and writes the literal company into every rule in place of `{company}`.

**Tests:**
- a request for another company is refused;
- a username other than the pinned one is refused.

**Trigger.** Do this when a second company or user appears (design Q6).

## C5b: `comis connect priority --url` for a public host

**Need.** The owner's Priority server is partner-hosted on a public address. `--url` is admitted only on the owner's network today (D968), so C5a is a manual template.

**Proposal.** Admit `--url https://<host>` for a catalog entry that declares a custom public host. The rules:
- HTTPS only
- public addresses only (private ones keep the owner-network form)
- WebPKI trust
- exactly one host

**Tests:**
- `http://` is refused;
- a private address is refused;
- an IP literal is refused;
- a second host is refused;
- a certificate failure is refused;
- DNS rebinding to a private address is refused.

## C9: who approves plumbers' draft orders

**Need.** Plumbers send order requests all day. Today the Gate's catalog entry answers `ask` for every `POST {screen}`, so the owner approves each draft order in Comis. The office then reviews the same draft again in Priority, where a new sales order arrives as a draft.

**Options for the owner:**
1. **Keep `ask`** (today). Every order waits for the owner in Comis. This is the safest choice, but slow when many plumbers write.
2. **A narrow `allow` for draft orders.** `POST {ORDERS}` would go straight through, with the office confirming the draft in Priority. Every other screen keeps `ask`. This needs a Gate decision outcome that does not exist today (the decisions are `deny`, `ask` and `owner`), so it needs a decision record with a threat note:
   - a prompt-injected or confused worker could create many draft orders;
   - limit it with a per-hour budget;
   - require the remarks (ORDERSTEXT) to carry the plumber's message;
   - have the office review drafts daily.
3. **Delegated approval.** An office user approves in Comis instead of the owner. This also needs Comis support.

**Recommendation.** Keep `ask` while the workflow is new, then decide from how many orders a day arrive.

