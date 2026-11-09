#!/usr/bin/env node

// priority-live: live qualification of a Priority REST endpoint for priority-axi.
//
// Read-only by default. The one create (--write) also needs PRIORITY_LIVE_WRITES=1.
// No dependencies. Node 22 or later. Never prints or stores the password.
//
// Settings (environment):
//   PRIORITY_URL       origin (https://host[:port]) or a full service root
//                      (https://host/odata/Priority/<ini>/<company>)
//   PRIORITY_INI       ini segment, default tabula.ini
//   PRIORITY_COMPANY   company code
//   PRIORITY_USER      API username
//   PRIORITY_PASSWORD  password
//
// Exit: 0 no failures (blocked stages allowed unless --strict), 1 failures, 2 usage.

import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const VERSION = '0.1.0';
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCREENS =
  'CUSTOMERS,SUPPLIERS,LOGPART,PART,ORDERS,PORDERS,CINVOICES,AINVOICES,DOCUMENTS_D,DOCUMENTS_p,ACCOUNTS,CURRENCIES,COUNTRIES';

/**
 * A screen name as Priority spells it: exact first, then a unique match that
 * ignores case. Names are case-sensitive (DOCUMENTS_p is projects, DOCUMENTS_P
 * another screen), so they are never simply uppercased.
 */
function screenName(input, sets) {
  const name = String(input || '').trim();
  if (!sets || sets.includes(name)) return name;
  const same = sets.filter((s) => s.toLowerCase() === name.toLowerCase());
  return same.length === 1 ? same[0] : name;
}
// Priority's "API cannot be run for this screen", default language and the ",3" English form.
const NOT_ENABLED = [
  /לא ניתן להפעיל API למסך זה/,
  /API cannot be run for this (form|screen)/i,
];
// Priority's "the company name sent is wrong, or switching company failed".
const BAD_COMPANY = [/שם החברה שנשלח לא תקין/, /problem changing companies/i];
// A username that cannot exist, so auth probes never count against the real API user's lockout.
const BOGUS_USER = 'priority-live-no-such-user';
const BOGUS_COMPANY = 'zzlive0';
const BOGUS_SCREEN = 'PRIORITYLIVENOSUCHSCREEN';
// Entity sets that answer without being in Limited Access/API Forms and ignore query options.
const VIRTUAL_SETS = new Set(['GETCOMPANIES']);

const USAGE = `usage: priority-live [--screens A,B] [--sweep] [--query-screen S] [--strict] [--report <path>]
                     [--axi <path>|none] [--deep] [--write --write-screen S --write-body <file.json>]
Live checks of a Priority REST endpoint, read-only unless --write. Settings come from
PRIORITY_URL, PRIORITY_INI, PRIORITY_COMPANY, PRIORITY_USER and PRIORITY_PASSWORD.
  --screens       screens to probe for API access (default: 12 common screens)
  --sweep         probe every screen in the metadata (about 1,300 small reads, 4 at a time)
  --query-screen  screen for the query checks (default: the first enabled screen)
  --strict        count blocked stages as failures (the phase-0 exit gate)
  --report        JSON report path (default: test/live/reports/<time>.json)
  --axi           priority-axi entry for S11 (default dist/bin/priority-axi.js, else the source); none skips
  --deep          S12: run priority-axi over every enabled screen: paging, sorting, filters,
                  show, every sub-screen, changes, --full and the error paths (read-only)
  --write         send ONE create; needs PRIORITY_LIVE_WRITES=1, --write-screen and --write-body
exit: 0 no failures, 1 failures (or blocked with --strict), 2 usage`;

// ---------- output helpers (TOON) ----------

function cell(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (
    s === '' ||
    /[,:"\\\n\r\t[\]{}]|^\s|\s$|^-/.test(s) ||
    /^(true|false|null|-?\d+(\.\d+)?([eE][+-]?\d+)?)$/.test(s)
  ) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
  }
  return s;
}

function usageError(message) {
  console.log(`error: usage\nmessage: ${cell(message)}\n${USAGE}`);
  process.exit(2);
}

// ---------- arguments and settings ----------

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
      screens: { type: 'string' },
      sweep: { type: 'boolean' },
      'query-screen': { type: 'string' },
      strict: { type: 'boolean' },
      report: { type: 'string' },
      write: { type: 'boolean' },
      'write-screen': { type: 'string' },
      'write-body': { type: 'string' },
      axi: { type: 'string' },
      deep: { type: 'boolean' },
    },
  }));
} catch (e) {
  usageError(e.message);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
if (args.version) {
  console.log(VERSION);
  process.exit(0);
}
if (args.write && !(args['write-screen'] && args['write-body'])) {
  usageError('--write needs --write-screen and --write-body');
}

function readConfig(env) {
  let origin = (env.PRIORITY_URL || '').trim().replace(/\/+$/, '');
  let ini = env.PRIORITY_INI || '';
  let company = env.PRIORITY_COMPANY || '';
  const m = origin.match(
    /^(https?:\/\/[^/]+)\/odata\/Priority\/([^/]+)\/([^/]+)$/i,
  );
  if (m) {
    origin = m[1];
    ini ||= m[2];
    company ||= m[3];
  }
  return {
    origin,
    ini: ini || 'tabula.ini',
    company,
    user: env.PRIORITY_USER || '',
    password: env.PRIORITY_PASSWORD || '',
  };
}

const cfg = readConfig(process.env);

function scrub(text) {
  const s = String(text);
  return cfg.password.length >= 4
    ? s.split(cfg.password).join('[redacted]')
    : s;
}

// ---------- HTTP ----------

const basic = (user, password) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const qs = (params) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
const rowsOf = (r) => (Array.isArray(r?.json?.value) ? r.json.value : null);

// Priority's form errors: JSON {FORM:{InterfaceErrors:{text}}} or the XML form.
function formErrors(json, text) {
  const found = json?.FORM?.InterfaceErrors;
  if (found !== undefined) {
    return (Array.isArray(found) ? found : [found])
      .flatMap((i) => (Array.isArray(i?.text) ? i.text : [i?.text ?? i]))
      .map((t) => (t && typeof t === 'object' ? t['#text'] : t))
      .filter((t) => typeof t === 'string' && t.trim())
      .join(' ');
  }
  const block = /<InterfaceErrors\b[^>]*>([\s\S]*?)<\/InterfaceErrors>/i.exec(
    text || '',
  );
  if (!block) return undefined;
  return [...block[1].matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)]
    .map((m) =>
      m[1]
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .trim(),
    )
    .join(' ');
}

async function call(path, o = {}) {
  const ini = o.ini ?? cfg.ini;
  const company = o.company ?? cfg.company;
  const url = `${cfg.origin}/odata/Priority/${ini}/${company}/${path}`;
  const shown = url.slice(cfg.origin.length);
  const headers = {
    Accept: 'application/json',
    'OData-Version': '4.0',
    'User-Agent': `priority-live/${VERSION}`,
  };
  if (o.auth !== false)
    headers.Authorization = basic(
      o.user ?? cfg.user,
      o.password ?? cfg.password,
    );
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: o.method || 'GET',
      headers,
      body: o.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(o.timeout || 90_000),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return {
      path: shown,
      status: res.status,
      ms: Math.round(performance.now() - t0),
      bytes: buf.length,
      headers: res.headers,
      json,
      message: json?.error?.message ?? formErrors(json, text),
      // For a failure that is not JSON, keep its start for the report (scrubbed).
      ...(res.status >= 400 && json === undefined && text
        ? { snippet: text.slice(0, 400) }
        : {}),
    };
  } catch (e) {
    return {
      path: shown,
      status: 0,
      ms: Math.round(performance.now() - t0),
      bytes: 0,
      headers: new Headers(),
      error:
        e.name === 'TimeoutError'
          ? 'timeout'
          : String(e.cause?.code || e.cause?.message || e.message),
    };
  }
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(size, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

// ---------- metadata index ----------

function buildIndex(m) {
  const nsName = Object.keys(m).find((k) => !k.startsWith('$'));
  const ns = m[nsName] || {};
  const container = ns[(m.$EntityContainer || '').split('.').pop()] || {};
  const sets = new Map();
  for (const [k, v] of Object.entries(container)) {
    if (v?.$Collection && v.$Type) sets.set(k, v.$Type.split('.').pop());
  }
  const types = new Map();
  let fields = 0;
  let navs = 0;
  const annotations = {};
  for (const [name, t] of Object.entries(ns)) {
    if (t?.$Kind !== 'EntityType') continue;
    const screen = { key: t.$Key || [], fields: [], subs: [] };
    for (const [f, d] of Object.entries(t)) {
      if (f.startsWith('$') || f.startsWith('@') || !d || typeof d !== 'object')
        continue;
      if (d.$Kind === 'NavigationProperty') {
        navs++;
        screen.subs.push({
          name: f,
          type: (d.$Type || '').split('.').pop(),
          many: d.$Collection === true,
        });
        continue;
      }
      fields++;
      for (const a of Object.keys(d))
        if (a.startsWith('@')) annotations[a] = (annotations[a] || 0) + 1;
      screen.fields.push({
        name: f,
        type: (d.$Type || 'Edm.String').replace(/^Edm\./, ''),
        readOnly: d['@Org.OData.Core.V1.Permissions'] === 'Read',
        internalId: d['@Priority.OData.AutoUnique'] === true,
        dateType: d['@Priority.OData.DateType'],
      });
    }
    types.set(name, screen);
  }
  return {
    sets,
    types,
    fields,
    navs,
    annotations,
    screen: (setName) => types.get(sets.get(setName) || setName),
  };
}

// ---------- stage runner ----------

const ctx = {
  abort: null,
  sets: [],
  index: null,
  enabled: [],
  notEnabled: [],
  sample: null,
  version: null,
  companyTitle: null,
};
const results = [];

function checks() {
  const list = [];
  const c = (name, ok, got) => {
    list.push({
      name,
      ok: Boolean(ok),
      ...(got !== undefined ? { got: scrub(got) } : {}),
    });
    return Boolean(ok);
  };
  c.list = list;
  c.result = (detail, facts = {}) => {
    const failed = list.filter((x) => !x.ok);
    return {
      status: failed.length ? 'fail' : 'pass',
      detail: failed.length
        ? `failed: ${failed.map((x) => x.name).join('; ')}`
        : detail,
      checks: list,
      facts,
    };
  };
  return c;
}

async function stage(id, name, fn) {
  if (ctx.abort) {
    results.push({
      id,
      name,
      status: 'skip',
      detail: `skipped: ${ctx.abort}`,
      ms: 0,
      checks: [],
      facts: {},
    });
    return;
  }
  const t0 = performance.now();
  let r;
  try {
    r = await fn();
  } catch (e) {
    r = { status: 'fail', detail: `crashed: ${e.message}` };
  }
  results.push({
    id,
    name,
    status: r.status,
    detail: scrub(r.detail ?? ''),
    ms: Math.round(performance.now() - t0),
    checks: r.checks || [],
    facts: r.facts || {},
  });
}

// ---------- stages ----------

const startedAt = new Date();

await stage('S1', 'config', async () => {
  const c = checks();
  const missing = [
    ['PRIORITY_URL', cfg.origin],
    ['PRIORITY_COMPANY', cfg.company],
    ['PRIORITY_USER', cfg.user],
    ['PRIORITY_PASSWORD', cfg.password],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  c(
    'settings present',
    missing.length === 0,
    missing.length ? `missing ${missing.join(' ')}` : 'all',
  );
  // Plain http is allowed only for a local fake server.
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(cfg.origin);
  c(
    'origin is https://host[:port]',
    local || /^https:\/\/[^/\s]+$/.test(cfg.origin),
    cfg.origin || '(empty)',
  );
  const r = c.result(
    `${cfg.origin} · ${cfg.ini} · ${cfg.company} · user ${cfg.user}`,
  );
  if (r.status === 'fail') ctx.abort = 'settings incomplete';
  return r;
});

await stage('S2', 'reach', async () => {
  const r = await call('');
  if (r.status === 0) {
    ctx.abort = 'endpoint unreachable';
    return { status: 'fail', detail: `unreachable: ${r.error}` };
  }
  if (r.status === 401) {
    ctx.abort = 'credentials rejected';
    return {
      status: 'fail',
      detail: '401: Priority rejected the username or password',
    };
  }
  const c = checks();
  c('service document 200', r.status === 200, r.status);
  const value = rowsOf(r) || [];
  const sets = value.filter((x) => x.kind === 'EntitySet').map((x) => x.name);
  const fns = value
    .filter((x) => x.kind === 'FunctionImport')
    .map((x) => x.name);
  c('lists screens', sets.length > 0, sets.length);
  ctx.sets = sets;
  const out = c.result(
    `service document in ${r.ms} ms: ${sets.length} screens, ${fns.length} functions`,
    {
      service_ms: r.ms,
      screens_listed: sets.length,
      functions: fns.join(' '),
      server: r.headers.get('server') || '',
    },
  );
  if (out.status === 'fail') ctx.abort = 'service document unusable';
  return out;
});

await stage('S3', 'auth', async () => {
  const c = checks();
  const bad = await call('GetPriorityVersion()', {
    user: BOGUS_USER,
    password: 'x',
  });
  const challenge = bad.headers.get('www-authenticate') || '';
  c('unknown user → 401', bad.status === 401, bad.status);
  c('401 offers Basic', /basic/i.test(challenge), challenge || '(none)');
  const none = await call('GetPriorityVersion()', { auth: false });
  c('no credentials → 401', none.status === 401, none.status);
  return c.result(
    `401 with WWW-Authenticate: ${challenge || '?'}; body ${bad.bytes ? `${bad.bytes} B` : 'empty'}`,
    {
      auth_401_body_bytes: bad.bytes,
    },
  );
});

await stage('S4', 'versions', async () => {
  const c = checks();
  const v = await call('GetPriorityVersion()');
  c(
    'GetPriorityVersion() 200',
    v.status === 200 && typeof v.json?.value === 'string',
    v.status,
  );
  const bare = await call('GetPriorityVersion');
  c('GetPriorityVersion without () 200', bare.status === 200, bare.status);
  const od = await call('GetODataVersion()');
  const bin = await call('GetBinVersion()');
  const login = await call('GetLoginName()');
  return c.result(`Priority ${v.json?.value ?? '?'} in ${v.ms} ms`, {
    priority_version: v.json?.value ?? null,
    odata_version: od.json?.value ?? `status ${od.status}`,
    bin_version: bin.json?.value ?? `status ${bin.status}`,
    get_login_name:
      login.status === 200 ? login.json?.value : `status ${login.status}`,
    version_ms: v.ms,
  });
});

await stage('S5', 'company', async () => {
  const c = checks();
  const list = await call('GETCOMPANIES');
  const rows = rowsOf(list) || [];
  const mine = rows.find((x) => x.NAME === cfg.company);
  c('GETCOMPANIES 200', list.status === 200, list.status);
  c(
    `company ${cfg.company} listed`,
    Boolean(mine),
    rows.map((x) => x.NAME).join(' ') || '(none)',
  );
  const bogus = await call('GETCOMPANIES', { company: BOGUS_COMPANY });
  c('unknown company → 400', bogus.status === 400, bogus.status);
  c(
    'unknown-company message recognised',
    BAD_COMPANY.some((rx) => rx.test(bogus.message || '')),
    bogus.message ?? '',
  );
  const trap = await call('GetPriorityVersion()', { company: BOGUS_COMPANY });
  const out = c.result(`${cfg.company}: ${mine?.TITLE ?? '?'}`, {
    companies: rows.map((x) => x.NAME).join(' '),
    company_title: mine?.TITLE ?? null,
    version_call_checks_company: trap.status !== 200,
    bad_company_message: bogus.message ?? null,
  });
  if (list.status === 200 && !mine)
    ctx.abort = `company ${cfg.company} not found`;
  return out;
});

await stage('S6', 'metadata', async () => {
  const c = checks();
  const r = await call('$metadata?$format=json', { timeout: 180_000 });
  c('$metadata?$format=json 200', r.status === 200 && r.json, r.status);
  if (r.status !== 200 || !r.json) return c.result('');
  const t0 = performance.now();
  const idx = buildIndex(r.json);
  const indexMs = Math.round(performance.now() - t0);
  ctx.index = idx;
  const mb = (r.bytes / 2 ** 20).toFixed(1);
  c('CSDL version 4.0', r.json.$Version === '4.0', r.json.$Version);
  c(
    'screens match the service document',
    idx.sets.size === ctx.sets.length,
    `${idx.sets.size} vs ${ctx.sets.length}`,
  );
  c(
    'field descriptions present',
    (idx.annotations['@Priority.OData.Description'] || 0) > 0,
    idx.annotations['@Priority.OData.Description'] || 0,
  );
  c('size under 32 MB', r.bytes < 32 * 2 ** 20, `${mb} MB`);
  return c.result(
    `${mb} MB in ${(r.ms / 1000).toFixed(1)} s; ${idx.sets.size} screens, ${idx.types.size} types, ${idx.fields} fields`,
    {
      metadata_bytes: r.bytes,
      metadata_ms: r.ms,
      metadata_index_ms: indexMs,
      metadata_encoding: r.headers.get('content-encoding') || 'identity',
      types: idx.types.size,
      fields: idx.fields,
      subform_links: idx.navs,
      annotations: Object.entries(idx.annotations)
        .map(([k, v]) => `${k.replace(/^@/, '')}=${v}`)
        .join(' '),
    },
  );
});

await stage('S7', 'screen access', async () => {
  const wanted = args.sweep
    ? [...ctx.sets]
    : (args.screens || process.env.PRIORITY_LIVE_SCREENS || DEFAULT_SCREENS)
        .split(',')
        .map((s) => screenName(s, ctx.sets))
        .filter(Boolean);
  const absent = ctx.index ? wanted.filter((s) => !ctx.index.sets.has(s)) : [];
  const probe = wanted.filter(
    (s) => !absent.includes(s) && !VIRTUAL_SETS.has(s),
  );
  const out = await pool(probe, 4, async (s) => ({
    s,
    r: await call(`${s}?$top=1`),
  }));
  const other = [];
  for (const { s, r } of out) {
    if (r.status === 200) ctx.enabled.push(s);
    else if (
      r.status === 400 &&
      NOT_ENABLED.some((rx) => rx.test(r.message || ''))
    )
      ctx.notEnabled.push(s);
    else other.push(`${s}:${r.status || r.error}`);
  }
  const facts = {
    probed: probe.length,
    enabled: ctx.enabled.join(' ') || 'none',
    not_enabled: ctx.notEnabled.length,
    other: other.join(' ') || 'none',
    absent_from_metadata: absent.join(' ') || 'none',
  };
  if (other.some((x) => /:(401|0|timeout)/.test(x))) {
    return {
      status: 'fail',
      detail: `unexpected answers: ${other.join(' ')}`,
      facts,
    };
  }
  if (!ctx.enabled.length) {
    return {
      status: 'blocked',
      detail: `0 of ${probe.length} screens enabled; they are not in Limited Access/API Forms`,
      facts,
    };
  }
  return {
    status: 'pass',
    detail: `${ctx.enabled.length} of ${probe.length} enabled: ${ctx.enabled.join(' ')}`,
    facts,
  };
});

await stage('S8', 'error mapping', async () => {
  const c = checks();
  const facts = {};
  const unknown = await call(`${BOGUS_SCREEN}?$top=1`);
  c('unknown screen → 404', unknown.status === 404, unknown.status);
  facts.unknown_screen = `${unknown.status}, ${unknown.bytes} B, ${unknown.ms} ms`;
  const ne = ctx.notEnabled[0];
  if (ne) {
    const he = await call(`${ne}?$top=1`);
    c(
      'not-enabled message recognised (default language)',
      he.status === 400 && NOT_ENABLED.some((rx) => rx.test(he.message || '')),
      he.message ?? he.status,
    );
    const en = await call(`${ne}?$top=1`, { ini: `${cfg.ini},3` });
    c(
      'not-enabled message recognised (",3" English)',
      en.status === 400 && NOT_ENABLED.some((rx) => rx.test(en.message || '')),
      en.message ?? en.status,
    );
    facts.not_enabled_message = he.message ?? null;
    facts.not_enabled_message_en = en.message ?? null;
  }
  const sub = await call(
    `GETCOMPANIES?${qs({ $filter: "substringof('a',NAME)" })}`,
  );
  c('substringof → 400', sub.status === 400, sub.status);
  const count = await call('GETCOMPANIES/$count');
  facts.path_count = `${count.status}${count.message ? ` ${count.message.slice(0, 60)}` : ''}`;
  const probeScreen = ctx.enabled[0] || ne || 'CUSTOMERS';
  const gmf = await call(`GetMetadataFor(entity='${probeScreen}')`);
  facts.get_metadata_for = `${probeScreen}: ${gmf.status}${gmf.message ? ` ${gmf.message}` : ` ${gmf.bytes} B`}`;
  return c.result('error shapes match the AXI error table', facts);
});

await stage('S9', 'query semantics', async () => {
  const s = screenName(args['query-screen'], ctx.sets) || ctx.enabled[0];
  if (!s)
    return {
      status: 'blocked',
      detail: 'no API-enabled screen to query; Q1 to Q3 stay open',
    };
  const meta = ctx.index?.screen(s);
  if (!meta?.key.length)
    return {
      status: 'fail',
      detail: `${s} is not in the metadata or has no key`,
    };
  const key = meta.key[0];
  // The whole key goes in every $select: QA cuts an $expand answer off when
  // part of a compound key is missing (see expand_without_full_key below).
  const keyList = meta.key;
  const keySel = keyList.join(',');
  const litFor = (name, v) => {
    const field = meta.fields.find((f) => f.name === name);
    return field && field.type !== 'String'
      ? String(v)
      : `'${String(v).replace(/'/g, "''")}'`;
  };
  const lit = (v) => litFor(key, v);
  const keyFilter = (row) =>
    keyList.map((k) => `${k} eq ${litFor(k, row[k])}`).join(' and ');
  const get = (params) => call(`${s}?${qs(params)}`);
  const c = checks();
  const facts = { query_screen: s, query_key: keySel };

  const top = await get({ $select: keySel, $top: 3 });
  const rows = rowsOf(top);
  c(
    '$top=3 → at most 3 rows',
    top.status === 200 && rows && rows.length <= 3,
    `${top.status} ${rows?.length ?? top.message ?? ''}`,
  );
  if (!rows || rows.length === 0) {
    return {
      status: top.status === 200 ? 'blocked' : 'fail',
      detail:
        top.status === 200
          ? `${s} has no records; choose another with --query-screen`
          : `${s}: ${top.status} ${top.message ?? ''}`,
      checks: c.list,
      facts,
    };
  }
  c(
    '$select returns only the key',
    rows.every((o) =>
      Object.keys(o).every((k) => keyList.includes(k) || k.startsWith('@')),
    ),
    Object.keys(rows[0]).join(' '),
  );

  const p1 = await get({ $select: key, $orderby: key, $top: 2 });
  const p2 = await get({ $select: key, $orderby: key, $top: 2, $skip: 2 });
  const k1 = (rowsOf(p1) || []).map((o) => o[key]);
  const k2 = (rowsOf(p2) || []).map((o) => o[key]);
  c(
    '$skip pages do not overlap',
    p1.status === 200 && p2.status === 200 && !k1.some((k) => k2.includes(k)),
    `${k1.join('|')} / ${k2.join('|')}`,
  );

  const desc = await get({ $select: key, $orderby: `${key} desc`, $top: 1 });
  facts.orderby_desc =
    desc.status !== 200
      ? `error ${desc.status}`
      : rows.length > 1 && rowsOf(desc)?.[0]?.[key] !== k1[0]
        ? 'honoured'
        : 'unclear';

  const k0 = rows[0][key];
  ctx.sample = {
    screen: s,
    key: k0,
    keys: Object.fromEntries(keyList.map((k) => [k, rows[0][k]])),
  };
  const eq = await get({ $filter: keyFilter(rows[0]) });
  const eqRows = rowsOf(eq);
  c(
    'eq filter on the key → that record',
    eq.status === 200 && eqRows?.length === 1 && eqRows[0][key] === k0,
    `${eq.status} ${eqRows?.length ?? eq.message ?? ''}`,
  );
  if (eqRows?.[0]) {
    const vals = Object.entries(eqRows[0]).filter(([k]) => !k.startsWith('@'));
    facts.row_fields = vals.length;
    facts.row_nulls = vals.filter(([, v]) => v === null).length;
    facts.row_empty_strings = vals.filter(([, v]) => v === '').length;
    const d = meta.fields.find((f) => f.dateType && eqRows[0][f.name]);
    if (d)
      facts.date_sample = `${d.name} (${d.dateType}) = ${eqRows[0][d.name]}`;
  }

  const cnt = await get({ $select: key, $top: 1, $count: 'true' });
  facts.q1_count =
    cnt.status !== 200
      ? `error ${cnt.status}`
      : '@odata.count' in (cnt.json || {})
        ? `supported (${cnt.json['@odata.count']})`
        : 'ignored';
  const sw = await get({
    $select: key,
    $top: 3,
    $filter: `startswith(${key},${lit(String(k0).slice(0, 2))})`,
  });
  facts.q3_startswith =
    sw.status === 200
      ? 'supported'
      : `error ${sw.status} ${sw.message ?? ''}`.trim();
  const ct = await get({
    $select: key,
    $top: 3,
    $filter: `contains(${key},${lit(String(k0).slice(-2))})`,
  });
  facts.contains =
    ct.status === 200
      ? 'supported'
      : `error ${ct.status} ${ct.message ?? ''}`.trim();
  const since = new Date(Date.now() - 30 * 864e5)
    .toISOString()
    .replace(/\.\d+Z$/, 'Z');
  const sn = await get({ $select: key, $top: 3, $since: since });
  facts.since =
    sn.status === 200
      ? `supported (${rowsOf(sn)?.length} of max 3 in 30 days)`
      : `error ${sn.status} ${sn.message ?? ''}`.trim();

  // Q2: $select, $top and $orderby inside $expand, on a record with 2+ lines.
  const sub = meta.subs.find((x) => x.many);
  const subMeta = sub && ctx.index.types.get(sub.type);
  const pick =
    subMeta &&
    (subMeta.key.find((k) => subMeta.fields.some((f) => f.name === k)) ??
      subMeta.fields.find((f) => !f.internalId)?.name);
  if (sub && pick) {
    facts.q2_sub = sub.name;
    ctx.sample.sub = sub.name.replace(/_SUBFORM$/, '');
    const e0 = await get({
      $select: keySel,
      $top: 20,
      $expand: `${sub.name}($select=${pick})`,
    });
    const recs = rowsOf(e0) || [];
    const linesOf = (r) => (Array.isArray(r?.[sub.name]) ? r[sub.name] : []);
    const anyLines = recs.some((r) => linesOf(r).length);
    facts.q2_expand_select =
      e0.status !== 200
        ? `error ${e0.status} ${e0.message ?? ''}`.trim()
        : !anyLines
          ? `unclear (no lines in ${recs.length} records)`
          : recs.every((r) =>
                linesOf(r).every((l) =>
                  Object.keys(l).every((k) => k === pick || k.startsWith('@')),
                ),
              )
            ? 'honoured'
            : 'ignored';
    const rec = recs.find((r) => linesOf(r).length >= 2);
    if (!rec) {
      facts.q2_expand_top = `unclear (no record with 2 lines in ${recs.length})`;
    } else {
      const all = linesOf(rec).map((l) => l[pick]);
      const e1 = await get({
        $select: keySel,
        $filter: keyFilter(rec),
        $expand: `${sub.name}($select=${pick};$top=1)`,
      });
      const l1 = rowsOf(e1)?.[0]?.[sub.name];
      facts.q2_expand_top =
        e1.status !== 200
          ? `error ${e1.status} ${e1.message ?? ''}`.trim()
          : !Array.isArray(l1)
            ? 'no array returned'
            : l1.length === 1
              ? 'honoured'
              : `ignored (${l1.length} of ${all.length} lines)`;
      const e2 = await get({
        $select: keySel,
        $filter: keyFilter(rec),
        $expand: `${sub.name}($select=${pick};$orderby=${pick} desc)`,
      });
      const l2 = (rowsOf(e2)?.[0]?.[sub.name] || []).map((l) => l[pick]);
      const max = all.reduce((a, b) => (b > a ? b : a));
      facts.q2_expand_orderby =
        e2.status !== 200
          ? `error ${e2.status} ${e2.message ?? ''}`.trim()
          : all[0] === max
            ? 'unclear (lines already descending)'
            : l2[0] === max
              ? 'honoured'
              : 'ignored';
    }
    if (keyList.length > 1) {
      const cut = await get({
        $select: key,
        $top: 1,
        $expand: `${sub.name}($select=${pick})`,
      });
      facts.expand_without_full_key =
        cut.status === 200 && cut.json === undefined && cut.bytes > 0
          ? `answer cut off (${cut.bytes} B)`
          : cut.status === 200
            ? 'complete'
            : `error ${cut.status || cut.error}`;
    }
  }
  return c.result(`${s} (key ${keySel})`, facts);
});

await stage('S10', 'one create (opt-in)', async () => {
  if (!args.write)
    return {
      status: 'skip',
      detail: 'read-only run; pass --write to send one create',
    };
  if (process.env.PRIORITY_LIVE_WRITES !== '1') {
    return {
      status: 'blocked',
      detail: 'set PRIORITY_LIVE_WRITES=1 to allow one create',
    };
  }
  const s = screenName(args['write-screen'], ctx.sets);
  const meta = ctx.index?.screen(s);
  if (!meta) return { status: 'fail', detail: `${s} is not in the metadata` };
  if (!ctx.enabled.includes(s)) {
    const pr = await call(`${s}?$top=1`);
    if (pr.status !== 200)
      return {
        status: 'blocked',
        detail: `${s} is not API-enabled (${pr.status})`,
      };
  }
  let body;
  try {
    body = JSON.parse(readFileSync(args['write-body'], 'utf8'));
  } catch (e) {
    return { status: 'fail', detail: `bad --write-body: ${e.message}` };
  }
  const bad = Object.keys(body).filter(
    (f) =>
      !f.endsWith('_SUBFORM') &&
      !meta.fields.some((x) => x.name === f && !x.readOnly && !x.internalId),
  );
  if (bad.length)
    return {
      status: 'fail',
      detail: `unknown, read-only or internal fields: ${bad.join(' ')}`,
    };
  const transactions =
    1 +
    Object.entries(body)
      .filter(([k, v]) => k.endsWith('_SUBFORM') && Array.isArray(v))
      .reduce((n, [, v]) => n + v.length, 0);
  // Sent once. A write is never retried, whatever the answer.
  const r = await call(s, {
    method: 'POST',
    body: JSON.stringify(body),
    timeout: 120_000,
  });
  const ok = r.status === 200 || r.status === 201;
  const newKey = r.json?.[meta.key[0]] ?? null;
  return {
    status: ok ? 'pass' : 'fail',
    detail: ok
      ? `created ${s} ${newKey ?? ''}`.trim()
      : `${r.status} ${r.message ?? r.error ?? ''}`.trim(),
    facts: {
      write_screen: s,
      write_status: r.status,
      ...(ok ? {} : { write_refusal: r.message ?? r.snippet ?? null }),
      write_key: newKey,
      write_transactions_estimate: transactions,
    },
  };
});

// S11 runs the shipped priority-axi itself against the live server, read-only.
function axiPath() {
  if (args.axi === 'none') return null;
  if (args.axi) return args.axi;
  const dist = join(HERE, '..', '..', 'dist', 'bin', 'priority-axi.js');
  return existsSync(dist)
    ? dist
    : join(HERE, '..', '..', 'src', 'bin', 'priority-axi.ts');
}

function runAxi(entry, argv, cache) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [entry, ...argv],
      {
        timeout: 180_000,
        maxBuffer: 1 << 20,
        env: {
          PATH: process.env.PATH ?? '',
          PRIORITY_URL: `${cfg.origin}/odata/Priority/${cfg.ini}/${cfg.company}`,
          PRIORITY_USER: cfg.user,
          PRIORITY_PASSWORD: cfg.password,
          XDG_CACHE_HOME: cache,
          ...(process.env.HTTPS_PROXY
            ? { HTTPS_PROXY: process.env.HTTPS_PROXY, NODE_USE_ENV_PROXY: '1' }
            : {}),
          ...(process.env.NODE_EXTRA_CA_CERTS
            ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }
            : {}),
        },
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
    child.stdin?.end();
  });
}

await stage('S11', 'axi smoke', async () => {
  const entry = axiPath();
  if (!entry) return { status: 'skip', detail: '--axi none' };
  if (!existsSync(entry))
    return {
      status: 'fail',
      detail: `no priority-axi at ${entry}; run npm run build`,
    };
  const cache = mkdtempSync(join(tmpdir(), 'priority-live-axi-'));
  const c = checks();
  const seen = {};
  const facts = Object.assign({}, ...results.map((r) => r.facts));
  const step = async (label, argv, expect) => {
    const r = await runAxi(entry, argv, cache);
    seen[label] = r.code;
    c(
      `${label}: exit ${expect.code}`,
      r.code === expect.code,
      `${r.code} ${r.stdout.split('\n')[0] ?? ''}`.slice(0, 160),
    );
    c(`${label}: stderr empty`, r.stderr === '', r.stderr.slice(0, 120));
    c(
      `${label}: no password in output`,
      !cfg.password || !r.stdout.includes(cfg.password),
    );
    if (!expect.full)
      c(
        `${label}: within 4,000 units`,
        r.stdout.length <= 4000,
        r.stdout.length,
      );
    for (const rx of expect.match ?? [])
      c(
        `${label}: ${rx.source.slice(0, 50)}`,
        rx.test(r.stdout),
        r.stdout.slice(0, 160),
      );
    return r;
  };
  try {
    await step('--version', ['--version'], {
      code: 0,
      match: [/^\d+\.\d+\.\d+\n$/],
    });
    await step('home', [], {
      code: 0,
      match: [
        new RegExp(
          `\\nversion: "${String(facts.priority_version ?? '').replace(/\./g, '\\.')}"\\n`,
        ),
        /\ncompany: /,
        /\nhelp\[\d\]:\n {2}Run `priority-axi /,
      ],
    });
    await step('refresh', ['refresh'], {
      code: 0,
      match: [new RegExp(`\\nscreens: ${ctx.sets.length}\\n`)],
    });
    await step('screens', ['screens', 'order'], {
      code: 0,
      match: [/^summary: "?\d+ screens? match order/],
    });
    const screen =
      ctx.sample?.screen ?? ctx.enabled[0] ?? (ctx.notEnabled[0] || 'ORDERS');
    await step('fields', ['fields', screen], {
      code: 0,
      match: [new RegExp(`^screen: ${screen}\\n`)],
    });
    const enabled =
      ctx.enabled.includes(screen) || ctx.sample?.screen === screen;
    const read = enabled
      ? {
          code: 0,
          match: [new RegExp(`^summary: "?\\d+ records? from ${screen}`)],
        }
      : {
          code: 1,
          match: [
            /\ncode: screen_not_enabled\n/,
            new RegExp(`add ${screen} to Limited Access/API Forms`),
          ],
        };
    await step('get', ['get', screen, '--limit', '3'], read);
    await step(
      'changes',
      ['changes', screen, '--since', '30d', '--limit', '3'],
      read,
    );
    if (enabled && ctx.sample?.screen === screen) {
      const parts = Object.entries(ctx.sample.keys ?? {});
      const keyArgs =
        parts.length > 1
          ? parts.flatMap(([k, v]) => ['--key', `${k}=${v}`])
          : [String(ctx.sample.key)];
      await step('show', ['show', screen, ...keyArgs], {
        code: 0,
        match: [new RegExp(`^screen: ${screen}\\nrecord:\\n`)],
      });
      if (ctx.sample.sub)
        await step(
          'get --with',
          ['get', screen, '--limit', '3', '--with', ctx.sample.sub],
          {
            code: 0,
            match: [new RegExp(`^summary: "?\\d+ records? from ${screen}`)],
          },
        );
    }
    if (ctx.enabled.includes('CUSTOMERS')) {
      // find: the local catalog and Hebrew search, on the small CUSTOMERS screen.
      const sample = rowsOf(
        await call(`CUSTOMERS?${qs({ $select: 'CUSTNAME,CUSTDES', $top: 1 })}`),
      )?.[0];
      const word = String(sample?.CUSTDES ?? '')
        .split(/\s+/)
        .find((w) => [...w].length > 2 && /^[\p{L}]+$/u.test(w));
      if (word) {
        await step('find', ['find', 'CUSTOMERS', word], {
          code: 0,
          match: [/^summary: "?[1-9]\d* records? from CUSTOMERS match /],
        });
        await step(
          'find --sub',
          ['find', 'CUSTOMERS', '--sub', 'CUSTPROJECTS', word, '--all'],
          {
            code: 0,
            match: [/^summary: "?\d+ lines? from CUSTOMERS > CUSTPROJECTS/],
          },
        );
      }
    }
    await step('unknown screen', ['get', 'PRIORITYLIVENOSUCH'], {
      code: 2,
      match: [/\ncode: usage\n/],
    });
    await step('unknown flag', ['get', screen, '--password=live-probe-value'], {
      code: 2,
      match: [/Unknown flag --password/],
    });
    const home2 = await runAxi(entry, [], cache);
    c(
      'home records what reads saw',
      enabled
        ? /screens_read/.test(home2.stdout)
        : new RegExp(`not_enabled\\[\\d+\\]: [^\\n]*${screen}`).test(
            home2.stdout,
          ),
      home2.stdout.slice(0, 200),
    );
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
  return c.result(smokeDetail(seen), {
    axi_entry: relative(process.cwd(), entry) || entry,
    axi_reads:
      seen.get === 0
        ? 'records read'
        : seen.get === 1
          ? 'blocked: screen_not_enabled, mapped correctly'
          : `exit ${seen.get}`,
  });
});

// S12 (--deep): the shipped priority-axi over every enabled screen, read-only.
await stage('S12', 'axi coverage (opt-in)', async () => {
  if (!args.deep)
    return {
      status: 'skip',
      detail: 'pass --deep to run priority-axi over every enabled screen',
    };
  const entry = axiPath();
  if (!entry || !existsSync(entry))
    return { status: 'fail', detail: 'no priority-axi; run npm run build' };
  const screens = ctx.enabled.filter((s) => ctx.index?.screen(s));
  if (!screens.length)
    return { status: 'blocked', detail: 'no API-enabled screen' };
  const cache = mkdtempSync(join(tmpdir(), 'priority-live-deep-'));
  const c = checks();
  const facts = { deep_screens: screens.join(' ') };
  const subsRefused = [];
  const noSince = [];
  const textForms = [];
  const findings = [];
  let steps = 0;
  const summaryRx = (s, atLeastOne) =>
    new RegExp(
      `^summary: "?${atLeastOne ? '[1-9]\\d*' : '\\d+'} records? from ${s}`,
    );
  const times = [];
  const step = async (label, argv, expect) => {
    steps++;
    const t0 = performance.now();
    const r = await runAxi(entry, argv, cache);
    times.push([label, Math.round(performance.now() - t0)]);
    const codeLine = /\ncode: ([a-z_]+)\n/.exec(`\n${r.stdout}`)?.[1];
    const okCode = Array.isArray(expect.code)
      ? expect.code.includes(r.code)
      : r.code === expect.code;
    c(
      `${label}: exit ${expect.code}`,
      okCode,
      `${r.code} ${codeLine ?? ''} ${r.stdout.split('\n')[0]}`.slice(0, 160),
    );
    if (expect.errorCode)
      c(
        `${label}: code ${expect.errorCode}`,
        codeLine === expect.errorCode,
        codeLine ?? r.stdout.slice(0, 120),
      );
    if (r.stderr) c(`${label}: stderr empty`, false, r.stderr.slice(0, 120));
    if (cfg.password && r.stdout.includes(cfg.password))
      c(`${label}: no password in output`, false);
    if (!expect.full && r.stdout.length > 4000)
      c(`${label}: within 4,000 units`, false, r.stdout.length);
    if (codeLine === 'internal_error')
      c(`${label}: no internal_error`, false, r.stdout.slice(0, 160));
    for (const rx of expect.match ?? [])
      c(
        `${label}: ${rx.source.slice(0, 60)}`,
        rx.test(r.stdout),
        r.stdout.slice(0, 160),
      );
    return { ...r, codeLine };
  };
  try {
    await step('refresh', ['refresh'], { code: 0 });
    for (const s of screens) {
      const meta = ctx.index.screen(s);
      const keys = meta.key;
      const k0 = keys[0];
      const candidates = meta.fields
        .filter((f) => !f.internalId && !keys.includes(f.name))
        .slice(0, 12);
      const sample = await call(
        `${s}?${qs({ $select: [...keys, ...candidates.map((f) => f.name)].join(','), $top: 4, $orderby: keys.join(',') })}`,
      );
      const rows = rowsOf(sample) || [];
      if (!rows.length) {
        findings.push(`${s}: no records`);
        await step(`${s} get (empty)`, ['get', s, '--limit', '3'], {
          code: 0,
          match: [summaryRx(s, false)],
        });
        continue;
      }
      const row = rows[0];
      const keyArgs = (r) =>
        keys.length > 1
          ? keys.flatMap((k) => ['--key', `${k}=${r[k]}`])
          : [String(r[k0])];
      const keyWhere = (r) => keys.flatMap((k) => ['--where', `${k}=${r[k]}`]);
      const text = candidates.find(
        (f) =>
          f.type === 'String' &&
          typeof row[f.name] === 'string' &&
          row[f.name].trim() &&
          row[f.name] === row[f.name].trim(),
      );
      const date = meta.fields.find(
        (f) =>
          f.dateType &&
          typeof row[f.name] === 'string' &&
          /^\d{4}-\d{2}-\d{2}T/.test(row[f.name]),
      );

      await step(`${s} fields`, ['fields', s], {
        code: 0,
        match: [new RegExp(`^screen: ${s}\\n`)],
      });
      await step(`${s} get`, ['get', s, '--limit', '3'], {
        code: 0,
        match: [summaryRx(s, true)],
      });
      if (rows.length >= 3)
        await step(
          `${s} get --page 2`,
          ['get', s, '--limit', '2', '--page', '2'],
          {
            code: 0,
            match: [
              summaryRx(s, true),
              new RegExp(
                String(rows[2][k0]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
              ),
            ],
          },
        );
      await step(
        `${s} get --sort desc`,
        ['get', s, '--sort', `${k0}:desc`, '--limit', '2'],
        { code: 0, match: [summaryRx(s, true)] },
      );
      if (text)
        await step(
          `${s} get --fields`,
          ['get', s, '--fields', text.name, '--limit', '2'],
          {
            code: 0,
            match: [new RegExp(`\\{[^}]*${text.name}[^}]*\\}:`)],
          },
        );
      await step(`${s} show`, ['show', s, ...keyArgs(row)], {
        code: 0,
        match: [new RegExp(`^screen: ${s}\\nrecord:\\n`)],
      });
      await step(`${s} get --where key`, ['get', s, ...keyWhere(row)], {
        code: 0,
        match: [summaryRx(s, true)],
      });
      if (rows.length >= 2)
        await step(
          `${s} get key range`,
          [
            'get',
            s,
            '--where',
            `${k0}>=${row[k0]}`,
            '--where',
            `${k0}<=${rows[1][k0]}`,
            '--limit',
            '5',
          ],
          {
            code: 0,
            match: [summaryRx(s, true)],
          },
        );
      if (text)
        await step(
          `${s} get --where text`,
          [
            'get',
            s,
            '--where',
            `${text.name}=${row[text.name]}`,
            '--limit',
            '2',
          ],
          {
            code: 0,
            match: [summaryRx(s, true)],
          },
        );
      if (date) {
        // A record's own date must match a range of that same day.
        const day = row[date.name].slice(0, 10);
        const r = await step(
          `${s} get date range`,
          [
            'get',
            s,
            ...keyWhere(row),
            '--where',
            `${date.name}>=${day}`,
            '--where',
            `${date.name}<=${day}`,
          ],
          {
            code: 0,
          },
        );
        c(
          `${s} date ${date.name}>=${day} and <=${day} finds the record dated ${row[date.name]}`,
          summaryRx(s, true).test(r.stdout),
          r.stdout.split('\n')[0],
        );
      }
      // $since works only on screens with a BPM status workflow (CURRENCIES has none).
      const ch = await step(
        `${s} changes`,
        ['changes', s, '--since', '30d', '--limit', '3'],
        { code: [0, 1] },
      );
      if (ch.code === 0)
        c(
          `${s} changes: summary`,
          summaryRx(s, false).test(ch.stdout),
          ch.stdout.split('\n')[0],
        );
      else {
        c(
          `${s} changes: unsupported_query`,
          ch.codeLine === 'unsupported_query',
          ch.codeLine,
        );
        noSince.push(s);
      }
      await step(`${s} get --full`, ['get', s, '--limit', '1', '--full'], {
        code: 0,
        full: true,
        match: [summaryRx(s, true)],
      });
      for (const sub of meta.subs) {
        const name = sub.name.replace(/_SUBFORM$/, '');
        // Remarks sub-screens (TEXT, APPEND, SIGNATURE) hold HTML in Priority;
        // the AXI prints them as plain text. Read more records to meet some text.
        const subFields = ctx.index.types.get(sub.type)?.fields ?? [];
        const textForm =
          !sub.many &&
          ['TEXT', 'APPEND', 'SIGNATURE'].every((n) =>
            subFields.some((f) => f.name === n),
          );
        const r = await step(
          `${s} --with ${name}`,
          ['get', s, '--limit', textForm ? '20' : '1', '--with', name],
          { code: [0, 1] },
        );
        if (r.code !== 0) subsRefused.push(`${s}>${name}:${r.codeLine}`);
        else if (textForm) {
          textForms.push(`${s}>${name}`);
          c(
            `${s} --with ${name}: plain text`,
            !/<(?:style|p|div|br|span|font)\b/i.test(r.stdout),
            r.stdout.slice(0, 160),
          );
        }
      }
    }

    // Error paths, on the first screen with a text field.
    const s =
      screens.find((x) =>
        ctx.index
          .screen(x)
          .fields.some(
            (f) =>
              f.type === 'String' && !ctx.index.screen(x).key.includes(f.name),
          ),
      ) ?? screens[0];
    const meta = ctx.index.screen(s);
    const textName =
      meta.fields.find(
        (f) =>
          f.type === 'String' && !meta.key.includes(f.name) && !f.internalId,
      )?.name ?? meta.key[0];
    await step('unknown field', ['get', s, '--where', 'PRIORITYLIVENOSUCH=1'], {
      code: 2,
      errorCode: 'usage',
    });
    await step('~ refused', ['get', s, '--where', `${textName}~a`], {
      code: 2,
      errorCode: 'usage',
    });
    await step(
      'raw contains',
      ['get', s, '--filter', `contains(${textName},'a')`],
      { code: 1, errorCode: 'unsupported_query' },
    );
    await step('bad company', ['get', s, '--company', BOGUS_COMPANY], {
      code: 1,
      errorCode: 'company_not_found',
    });
    if (meta.key.length === 1)
      await step('unknown key', ['show', s, 'PRIORITYLIVENOSUCHKEY'], {
        code: 1,
        errorCode: 'not_found',
      });
    await step('limit too large', ['get', s, '--limit', '501'], {
      code: 2,
      errorCode: 'usage',
    });
    await step(
      'unknown sort field',
      ['get', s, '--sort', 'PRIORITYLIVENOSUCH'],
      { code: 2, errorCode: 'usage' },
    );
    await step(
      'quotes in a value',
      ['get', s, '--where', `${textName}=O'Brien "x"`],
      { code: 0, match: [summaryRx(s, false)] },
    );
    await step(
      'since a UTC time',
      ['changes', s, '--since', '2026-11-01T00:00:00Z', '--limit', '2'],
      { code: 0, match: [summaryRx(s, false)] },
    );
    const closed = ctx.notEnabled.find(
      (x) => ctx.index?.screen(x) && !VIRTUAL_SETS.has(x),
    );
    if (closed)
      await step('screen not enabled', ['get', closed, '--limit', '1'], {
        code: 1,
        errorCode: 'screen_not_enabled',
      });
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
  facts.deep_steps = steps;
  facts.deep_subs_refused = subsRefused.join(' ') || 'none';
  facts.deep_changes_without_bpm = noSince.join(' ') || 'none';
  facts.deep_text_forms = textForms.join(' ') || 'none';
  const ms = times.map(([, v]) => v).sort((a, b) => a - b);
  facts.deep_ms_median = ms[Math.floor(ms.length / 2)] ?? 0;
  facts.deep_slowest = times
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([l, v]) => `${l} ${v} ms`)
    .join('; ');
  if (findings.length) facts.deep_findings = findings.join('; ');
  return c.result(
    `${steps} priority-axi runs over ${screens.length} screens`,
    facts,
  );
});

function smokeDetail(seen) {
  return seen.get === 0
    ? 'priority-axi read records end to end'
    : 'priority-axi ran end to end; reads stop at API Forms and are reported as screen_not_enabled';
}

// ---------- report ----------

const finishedAt = new Date();
const count = (st) => results.filter((r) => r.status === st).length;
const summary = {
  pass: count('pass'),
  fail: count('fail'),
  blocked: count('blocked'),
  skip: count('skip'),
};
const facts = Object.assign({}, ...results.map((r) => r.facts));

const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
const reportPath = args.report || join(HERE, 'reports', `${stamp}.json`);
const report = {
  tool: 'priority-live',
  version: VERSION,
  started_at: startedAt.toISOString(),
  finished_at: finishedAt.toISOString(),
  target: {
    origin: cfg.origin,
    ini: cfg.ini,
    company: cfg.company,
    user: cfg.user,
  },
  options: {
    sweep: Boolean(args.sweep),
    strict: Boolean(args.strict),
    write: Boolean(args.write),
  },
  summary,
  stages: results,
  facts,
  lists: { enabled: ctx.enabled, not_enabled: ctx.notEnabled },
};
let reportNote = '';
try {
  mkdirSync(dirname(reportPath), { recursive: true });
  const tmp = `${reportPath}.tmp`;
  writeFileSync(tmp, `${scrub(JSON.stringify(report, null, 2))}\n`);
  renameSync(tmp, reportPath);
  const rel = relative(process.cwd(), reportPath);
  reportNote = rel && !rel.startsWith('..') ? rel : reportPath;
} catch (e) {
  reportNote = `not written: ${e.message}`;
}

const lines = [];
lines.push(
  `priority_live: ${cell(`${cfg.origin} · ${cfg.ini} · ${cfg.company} · user ${cfg.user}`)}`,
);
lines.push(`stages[${results.length}]{id,stage,status,ms,detail}:`);
for (const r of results)
  lines.push(
    `  ${[r.id, r.name, r.status, r.ms, r.detail].map(cell).join(',')}`,
  );
const failedChecks = results.flatMap((r) =>
  r.checks.filter((x) => !x.ok).map((x) => ({ id: r.id, ...x })),
);
if (failedChecks.length) {
  lines.push(`failed_checks[${failedChecks.length}]{stage,check,got}:`);
  for (const f of failedChecks)
    lines.push(`  ${[f.id, f.name, f.got ?? ''].map(cell).join(',')}`);
}
const shownFacts = Object.entries(facts).filter(([, v]) => v !== undefined);
if (shownFacts.length) {
  lines.push('facts:');
  for (const [k, v] of shownFacts) lines.push(`  ${k}: ${cell(v)}`);
}
lines.push(
  `summary: ${summary.pass} pass, ${summary.fail} fail, ${summary.blocked} blocked, ${summary.skip} skip`,
);
lines.push(`report: ${cell(reportNote)}`);
const help = [];
if (results[0]?.status === 'fail') {
  help.push(
    'Set PRIORITY_URL, PRIORITY_COMPANY, PRIORITY_USER and PRIORITY_PASSWORD, for example in a local env file passed with node --env-file',
  );
}
const blockedAccess = results.find(
  (r) => r.id === 'S7' && r.status === 'blocked',
);
if (blockedAccess) {
  help.push(
    'Ask the Priority administrator to add the needed screens to Limited Access/API Forms (start with CUSTOMERS, LOGPART, ORDERS), then run again',
  );
  if (!args.sweep) help.push('Run with --sweep to probe every screen');
}
if (summary.fail) help.push('See failed_checks above and the JSON report');
if (!args.write && !ctx.abort)
  help.push(
    'Writes were not tested; --write sends one create after the owner authorizes it',
  );
if (help.length) {
  lines.push(`help[${help.length}]:`);
  for (const h of help) lines.push(`  ${h}`);
}
console.log(scrub(lines.join('\n')));

process.exit(summary.fail || (args.strict && summary.blocked) ? 1 : 0);
