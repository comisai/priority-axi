// Text search over a local copy of a screen's catalog. Priority answers 501
// to contains() and startswith(), so `find` matches here instead. Pure: no I/O.
//
// Matching is forgiving about how people and imports write Hebrew: points
// (niqqud) are ignored, final letters match their plain forms, and the Hebrew
// geresh and gershayim match ' and ". Every query word must appear: numbers
// as whole numbers standing on their own (4 matches neither 4000, SN4 nor
// 3/4), other words at the start of a word, after any Hebrew prefix letters.

/** Hebrew points and cantillation marks. */
const POINTS = /[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/g;
const FINALS: Record<string, string> = {
  '\u05DA': '\u05DB',
  '\u05DD': '\u05DE',
  '\u05DF': '\u05E0',
  '\u05E3': '\u05E4',
  '\u05E5': '\u05E6',
};
const FINAL = /[\u05DA\u05DD\u05DF\u05E3\u05E5]/g;
const DOUBLE_QUOTES = /[\u05F4\u201C\u201D\u201E]|''/g;
const SINGLE_QUOTES = /[\u05F3\u2018\u2019`]/g;
/**
 * A number standing on its own: 4, 110, 1.5, 1/2, 1.1/2, or 110 in 110*200.
 * Digits joined to letters, such as the 4 in SN4, are part of a word instead.
 */
const NUMBER = /(?<![\p{L}\d.\/])\d+(?:[./]\d+)*(?![\p{L}\d])/gu;
const IS_NUMBER = /^\d+(?:[./]\d+)*$/;
/** Words: runs of letters and digits, with the number punctuation inside them. */
const TERM = /[\p{L}\p{N}]+(?:[./][\p{N}]+)*/gu;

export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(POINTS, '')
    .replace(FINAL, (c) => FINALS[c] ?? c)
    .replace(DOUBLE_QUOTES, '"')
    .replace(SINGLE_QUOTES, "'")
    .toLowerCase();
}

export interface Term {
  /** Normalized, for matching. */
  text: string;
  /** As written (points removed), for messages. */
  shown: string;
  number: boolean;
}

/** The terms of a query. One-letter words are dropped; numbers are kept. */
export function queryTerms(words: readonly string[]): Term[] {
  const out: Term[] = [];
  for (const word of words) {
    // Normalizing keeps letters, digits and their order, so the terms of the
    // normalized word line up one to one with the terms as written.
    const written = [
      ...word
        .normalize('NFKC')
        .replace(POINTS, '')
        .toLowerCase()
        .matchAll(TERM),
    ].map((m) => m[0]);
    [...normalize(word).matchAll(TERM)].forEach((m, i) => {
      const text = m[0];
      const number = IS_NUMBER.test(text);
      if (!number && [...text].length < 2) return;
      if (!out.some((t) => t.text === text))
        out.push({ text, shown: written[i] ?? text, number });
    });
  }
  return out;
}

/** A searchable text: the normalized string and its whole numbers. */
export interface Haystack {
  /** Normalized words (runs of letters and digits). */
  words: string[];
  /** Whole numbers standing on their own, as written: 110, 4000, 3/4, 1.1/2. */
  numbers: Set<string>;
}

export function haystack(parts: readonly unknown[]): Haystack {
  const text = normalize(
    parts.filter((p) => p !== null && p !== undefined).join(' '),
  );
  return {
    words: [...text.matchAll(TERM)].map((m) => m[0]),
    numbers: new Set([...text.matchAll(NUMBER)].map((m) => m[0])),
  };
}

/** Letters that join the front of a Hebrew word: and, the, in, as, to, from, that. */
const PREFIX = /[\u05D5\u05D4\u05D1\u05DB\u05DC\u05DE\u05E9]/;

/**
 * A query word matches the start of a word, after up to three Hebrew prefix
 * letters: ביוב matches לביוב and צינור matches צינורות, but לבן does not
 * match מגולבן.
 */
function startsWord(word: string, term: string): boolean {
  for (let i = 0; i <= 3; i++) {
    if (word.startsWith(term, i)) return true;
    if (!PREFIX.test(word[i] ?? '')) return false;
  }
  return false;
}

/** The terms a haystack lacks. */
export function missing(terms: readonly Term[], hay: Haystack): Term[] {
  return terms.filter((t) =>
    t.number
      ? !hay.numbers.has(t.text)
      : !hay.words.some((w) => startsWord(w, t.text)),
  );
}

export interface Ranked<T> {
  /** Rows with every term, in catalog order. */
  all: T[];
  /** When no row has every term: the closest rows, best first, with what they lack. */
  closest: Array<{ row: T; lacking: string[] }>;
}

/**
 * Rows matching every term. If none does, the rows matching most terms, as
 * long as they match at least half of them (and at least one).
 */
export function rank<T>(
  rows: readonly T[],
  text: (row: T) => Haystack,
  terms: readonly Term[],
): Ranked<T> {
  const all: T[] = [];
  const near: Array<{ row: T; lacking: Term[]; i: number }> = [];
  rows.forEach((row, i) => {
    const lacking = missing(terms, text(row));
    if (!lacking.length) all.push(row);
    else if (lacking.length < terms.length) near.push({ row, lacking, i });
  });
  if (all.length || !near.length) return { all, closest: [] };
  const fewest = Math.min(...near.map((n) => n.lacking.length));
  const enough = terms.length - fewest >= Math.ceil(terms.length / 2);
  return {
    all,
    closest: enough
      ? near
          .filter((n) => n.lacking.length === fewest)
          .sort((a, b) => a.i - b.i)
          .map((n) => ({ row: n.row, lacking: n.lacking.map((t) => t.shown) }))
      : [],
  };
}
