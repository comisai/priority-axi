// Settings come from the environment and from flags; flags win. The password
// is only ever read from PRIORITY_PASSWORD, which inside Comis holds a
// placeholder that the Gate swaps for the real one.

import { AxiError, usage } from './errors.ts';

export interface Settings {
  origin: string;
  ini: string;
  company: string;
  user: string;
  password: string;
}

export interface SettingFlags {
  company?: string | undefined;
  user?: string | undefined;
  ini?: string | undefined;
}

// The Gate's named path segment: [A-Za-z0-9._~-]+. A segment outside it, such
// as "tabula.ini,3", would not match any Gate rule.
const SEGMENT = /^[A-Za-z0-9._~-]+$/;
const SERVICE_ROOT =
  /^(https?:\/\/[^/]+)\/odata\/Priority\/([^/]+)\/([^/]+)\/?$/i;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1)$/;

function originOf(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw usage(
      'PRIORITY_URL is not a URL. Use https://host or the full service root https://host/odata/Priority/<ini>/<company>.',
    );
  }
  if (url.username || url.password) {
    throw usage('PRIORITY_URL must not contain a username or password.');
  }
  const plainLocal = url.protocol === 'http:' && LOCAL_HOST.test(url.hostname);
  if (url.protocol !== 'https:' && !plainLocal) {
    throw usage('PRIORITY_URL must use https.');
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw usage(
      'PRIORITY_URL must be https://host or the full service root https://host/odata/Priority/<ini>/<company>.',
    );
  }
  return url.origin;
}

function segment(value: string, name: string): string {
  if (!SEGMENT.test(value)) {
    throw usage(
      `${name} may contain only letters, digits and . _ ~ - (no commas or slashes).`,
    );
  }
  return value;
}

export function readSettings(
  env: NodeJS.ProcessEnv,
  flags: SettingFlags = {},
): Settings {
  const rawUrl = (env.PRIORITY_URL ?? '').trim();
  const password = env.PRIORITY_PASSWORD ?? '';
  if (!rawUrl || !password) {
    const missing = !rawUrl ? 'PRIORITY_URL' : 'PRIORITY_PASSWORD';
    throw new AxiError(
      'not_connected',
      `Priority is not connected: ${missing} is not set. Ask the owner to run \`comis connect priority\`.`,
    );
  }

  let fromUrl: { ini?: string; company?: string } = {};
  let origin: string;
  const root = SERVICE_ROOT.exec(rawUrl);
  if (root?.[1] && root[2] && root[3]) {
    origin = originOf(root[1]);
    fromUrl = { ini: root[2], company: root[3] };
  } else {
    origin = originOf(rawUrl.replace(/\/+$/, ''));
  }

  const ini = flags.ini || env.PRIORITY_INI || fromUrl.ini || 'tabula.ini';
  const company =
    flags.company || env.PRIORITY_COMPANY || fromUrl.company || '';
  const user = flags.user || env.PRIORITY_USER || '';
  if (!company) {
    throw new AxiError(
      'missing_setting',
      'No Priority company code. Ask the owner for it, then pass --company <code>.',
    );
  }
  if (!user) {
    throw new AxiError(
      'missing_setting',
      'No Priority API username. Ask the owner for it, then pass --user <name>.',
    );
  }
  // Basic authentication cannot carry a colon in the username.
  if (user.includes(':') || /\p{Cc}/u.test(user)) {
    throw usage(
      'The username (--user or PRIORITY_USER) must not contain a colon or control characters.',
    );
  }
  return {
    origin,
    ini: segment(ini, 'The ini (--ini or PRIORITY_INI)'),
    company: segment(company, 'The company (--company or PRIORITY_COMPANY)'),
    user,
    password,
  };
}

export function serviceRoot(settings: Settings): string {
  return `${settings.origin}/odata/Priority/${settings.ini}/${settings.company}`;
}
