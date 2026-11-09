// Priority stores the text of its remarks sub-screens (ORDERSTEXT and the
// like) as HTML: a <style> block, then <p dir=rtl> paragraphs. People and
// agents read it as plain text, so paragraphs and line breaks become lines,
// tags are dropped and character references are decoded. Pure: no I/O.
// visible() still runs on the result, so a decoded control character is
// shown escaped like any other.

import type { ScreenType } from '../index/build.ts';

/** Blocks whose content is never text. */
const DROPPED = /<(style|script|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
/** Tags that end a line. */
const LINE_END = /<br\b[^>]*>|<\/(?:p|div|li|tr|h[1-6]|table|ul|ol)\s*>/gi;
const TAG = /<!--[\s\S]*?-->|<\/?[a-z][^>]*>/gi;
const HAS_TAG = /<!--[\s\S]*?-->|<\/?[a-z][^>]*>/i;
const REFERENCE = /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi;
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function character(code: number, written: string): string {
  const valid =
    code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
  return valid ? String.fromCodePoint(code) : written;
}

/**
 * A sub-screen of Priority's remarks kind: one record with TEXT, APPEND and
 * SIGNATURE (all 450 such sub-screens on QA). Line lists that have a TEXT
 * field hold short plain text instead.
 */
export function isTextForm(type: ScreenType): boolean {
  return ['TEXT', 'APPEND', 'SIGNATURE'].every((name) =>
    type.fields.some((f) => f.name === name),
  );
}

/** The text of Priority's HTML: one line per paragraph, at most one blank line in a row. */
export function plainText(html: string): string {
  if (!HAS_TAG.test(html)) return html;
  const text = html
    .replace(DROPPED, '')
    .replace(LINE_END, '\n')
    .replace(TAG, '')
    .replace(REFERENCE, (written, dec, hex, name) => {
      if (dec) return character(Number(dec), written);
      if (hex) return character(Number.parseInt(hex, 16), written);
      return NAMED[String(name).toLowerCase()] ?? written;
    });
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (line || (lines.length && lines[lines.length - 1] !== ''))
      lines.push(line);
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
