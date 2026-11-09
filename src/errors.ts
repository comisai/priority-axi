// The closed set of error codes and the classifier for HTTP answers from
// Priority and from the Comis Gate in front of it.

export type ErrorCode =
  | 'usage'
  | 'not_connected'
  | 'missing_setting'
  | 'auth_failed'
  | 'company_not_found'
  | 'screen_not_enabled'
  | 'reconnect_needed'
  | 'held_for_approval'
  | 'refused'
  | 'not_found'
  | 'already_exists'
  | 'priority_rejected'
  | 'unsupported_query'
  | 'rate_limited'
  | 'priority_error'
  | 'unreachable'
  | 'output_too_large'
  | 'internal_error';

export type ErrorFields = Record<string, string | number>;

export class AxiError extends Error {
  readonly code: ErrorCode;
  readonly fields: ErrorFields;

  constructor(code: ErrorCode, message: string, fields: ErrorFields = {}) {
    super(message);
    this.name = 'AxiError';
    this.code = code;
    this.fields = fields;
  }

  get exitCode(): 1 | 2 {
    return this.code === 'usage' ? 2 : 1;
  }
}

export const usage = (message: string): AxiError =>
  new AxiError('usage', message);

// Priority's "API cannot be run for this screen", in the server's default
// language (Hebrew here) and in English (the ",3" language suffix).
export const NOT_ENABLED: readonly RegExp[] = [
  /לא ניתן להפעיל API למסך זה/,
  /API cannot be run for this (form|screen)/i,
];

// Priority's "the company name sent is wrong, or switching company failed".
// Priority's "$since is supported only for screens with BPM" (QA, 23.1).
export const SINCE_NEEDS_BPM: readonly RegExp[] = [
  /\$since[\s\S]*BPM/i,
  /BPM[\s\S]*\$since/i,
];

export const BAD_COMPANY: readonly RegExp[] = [
  /שם החברה שנשלח לא תקין/,
  /problem changing companies/i,
];

export interface HttpAnswer {
  status: number;
  headers: Headers;
  json: unknown;
  /** The start of a body that is not JSON, such as Priority's XML errors. */
  text?: string;
}

export interface ClassifyContext {
  screen?: string;
  company?: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function xmlText(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
      const code =
        name[1] === 'x' || name[1] === 'X'
          ? Number.parseInt(name.slice(2), 16)
          : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    });
}

/** Texts inside Priority's InterfaceErrors, in JSON ({text} or [{text}]) or XML. */
function interfaceErrors(json: unknown, text: string | undefined): string[] {
  const form = (json as { FORM?: { InterfaceErrors?: unknown } } | undefined)
    ?.FORM;
  const found = form?.InterfaceErrors;
  if (found !== undefined) {
    const items = Array.isArray(found) ? found : [found];
    return items
      .flatMap((item) => {
        const t =
          item && typeof item === 'object'
            ? (item as { text?: unknown }).text
            : item;
        return Array.isArray(t) ? t : [t];
      })
      .map((t) =>
        typeof t === 'object' && t ? (t as { '#text'?: unknown })['#text'] : t,
      )
      .filter((t): t is string => typeof t === 'string' && !!t.trim())
      .map((t) => t.trim());
  }
  const block =
    text && /<InterfaceErrors\b[^>]*>([\s\S]*?)<\/InterfaceErrors>/i.exec(text);
  if (!block?.[1]) return [];
  return [...block[1].matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)]
    .map((m) => xmlText(m[1] ?? '').trim())
    .filter(Boolean);
}

/** Priority's own words: an OData error message, or its form errors. */
export function priorityMessage(
  json: unknown,
  text?: string,
): string | undefined {
  const error =
    json && typeof json === 'object'
      ? (json as { error?: unknown }).error
      : undefined;
  const message =
    error && typeof error === 'object'
      ? (error as { message?: unknown }).message
      : undefined;
  if (typeof message === 'string' && message.trim()) return message.trim();
  const form = interfaceErrors(json, text);
  return form.length ? form.join(' ') : undefined;
}

// Gate refusal codes with a sentence the agent can act on. Others fall back to
// a generic sentence that still carries the code.
const GATE_REFUSALS: Record<string, string> = {
  secret_response:
    "The Gate withheld Priority's answer because it carried a credential.",
  body_forgotten:
    'The Gate no longer holds the body of this request. Run the command again only if the owner asks.',
  out_of_budget:
    'The Gate refused this request: the spending budget is used up.',
};

export function classify(
  answer: HttpAnswer,
  ctx: ClassifyContext = {},
): AxiError | null {
  const { status, headers, json } = answer;
  const refusal = headers.get('comis-refusal');
  const action = headers.get('comis-action')?.split(';')[0]?.trim();
  if (status >= 200 && status < 300) return null;
  const screen = ctx.screen ? { screen: ctx.screen } : {};

  if (refusal === 'approval_pending' || (status === 409 && action)) {
    const id = action || 'unknown';
    return new AxiError(
      'held_for_approval',
      `The owner has an approval card for this request. Do not retry. Run \`comis action wait ${id}\`.`,
      { action: id },
    );
  }
  if (refusal === 'reconnect_needed') {
    return new AxiError(
      'reconnect_needed',
      'Priority refused the stored credential. Ask the owner to reconnect Priority.',
    );
  }
  if (refusal) {
    return new AxiError(
      'refused',
      GATE_REFUSALS[refusal] ?? `The Gate refused this request (${refusal}).`,
      { refusal, ...screen },
    );
  }

  const message = priorityMessage(json, answer.text);
  if (status === 401) {
    return new AxiError(
      'auth_failed',
      'Priority rejected the username or password. Check PRIORITY_USER and PRIORITY_PASSWORD.',
    );
  }
  if (status === 400 && message && NOT_ENABLED.some((rx) => rx.test(message))) {
    const name = ctx.screen ?? 'this screen';
    return new AxiError(
      'screen_not_enabled',
      `Priority does not allow API access to ${name}. Ask the owner to have the Priority administrator add ${name} to Limited Access/API Forms.`,
      { ...screen, priority: message },
    );
  }
  if (
    status === 400 &&
    message &&
    SINCE_NEEDS_BPM.some((rx) => rx.test(message))
  ) {
    const name = ctx.screen ?? 'This screen';
    return new AxiError(
      'unsupported_query',
      `${name} has no status workflow (BPM) in Priority, and Priority tracks changes only on screens that have one. Use \`priority-axi get ${ctx.screen ?? '<SCREEN>'}\` with --where on a date field instead; \`priority-axi fields ${ctx.screen ?? '<SCREEN>'}\` lists them.`,
      { ...screen, priority: message },
    );
  }
  if (status === 400 && message && BAD_COMPANY.some((rx) => rx.test(message))) {
    return new AxiError(
      'company_not_found',
      `Priority does not know company ${ctx.company ?? 'given'}. Check the company code with the owner.`,
      { priority: message },
    );
  }
  if (status === 404) {
    return new AxiError(
      'not_found',
      ctx.screen
        ? `Priority has no ${ctx.screen}. Check the name with \`priority-axi screens\`.`
        : 'Priority answered 404 Not Found.',
      screen,
    );
  }
  if (status === 409) {
    return new AxiError(
      'already_exists',
      'Priority says this record already exists. Read it instead of creating it.',
      { ...screen, ...(message ? { priority: message } : {}) },
    );
  }
  if (status === 429) {
    return new AxiError(
      'rate_limited',
      'Priority is limiting requests. Wait a minute, then try again.',
    );
  }
  if (status === 501) {
    return new AxiError(
      'unsupported_query',
      `Priority cannot run this query: ${message ?? 'not supported'}. Use the --where operators =, !=, >, >=, < and <=.`,
      screen,
    );
  }
  if (status >= 400 && status < 500) {
    return new AxiError(
      'priority_rejected',
      message ?? `Priority answered ${status} with no message.`,
      { ...screen, status },
    );
  }
  return new AxiError(
    'priority_error',
    message ?? `Priority answered ${status} with no message.`,
    { ...screen, status },
  );
}
