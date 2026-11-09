# Security Policy

priority-axi handles ERP credentials and business data, so we take security reports seriously.

## Supported versions

Security fixes go to `main` and to the next `0.x` release on npm. Only the latest release is supported.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub:

1. Go to the [Security tab](https://github.com/comisai/priority-axi/security/advisories/new).
2. Choose **Report a vulnerability**.

Include:

- what the problem is and what an attacker could do with it;
- the commit or version affected;
- the steps to reproduce it, ideally against the fake Priority in `test/fake/`.

Never include real passwords, server addresses or customer data. The maintainers will acknowledge your report, keep you informed while they work on a fix, and agree the disclosure with you.

## Scope

**In scope:**

- A password or token appearing in output, errors, logs or cache files.
- A bypass of the text-safety layer: invisible or bidirectional characters, or credential-like values, passing through unescaped.
- A request sent to a host, path or company other than the configured one.
- A write that is retried, or that differs from what `--dry-run` showed.
- Injection through screen names, field names or values into OData queries or paths.

**Out of scope:**

- Vulnerabilities in Priority ERP itself; report those to Priority Software.
- Vulnerabilities in Comis; report those to the Comis maintainers.
