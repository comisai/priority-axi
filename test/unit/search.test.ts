import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { haystack, normalize, queryTerms, rank } from '../../src/search.ts';

const KAMATZ = String.fromCodePoint(0x05b8);
const GERSHAYIM = String.fromCodePoint(0x05f4);
const GERESH = String.fromCodePoint(0x05f3);

describe('normalize', () => {
  it('folds final letters, Hebrew quote marks, points and case', () => {
    assert.equal(normalize('כתום'), normalize('כתומ'));
    assert.equal(normalize(`4${GERSHAYIM}`), '4"');
    assert.equal(normalize(`מ${GERSHAYIM}מ`), normalize('מ"מ'));
    assert.equal(normalize(`יח${GERESH}`), "יח'");
    assert.equal(normalize(`ש${KAMATZ}לום`), normalize('שלום'));
    assert.equal(normalize('PVC'), 'pvc');
    assert.equal(normalize("4''"), '4"');
  });
});

describe('queryTerms', () => {
  it('keeps numbers and words, drops one-letter words and repeats, and remembers how each was written', () => {
    const terms = queryTerms([
      `צינור 4${GERSHAYIM} pvc כתום ת`,
      'כתום',
      '1.1/2',
    ]);
    assert.deepEqual(
      terms.map((t) => [t.shown, t.number]),
      [
        ['צינור', false],
        ['4', true],
        ['pvc', false],
        ['כתום', false],
        ['1.1/2', true],
      ],
    );
  });
});

describe('haystack', () => {
  it('counts only numbers standing on their own', () => {
    const h = haystack(['צינור SN4 לביוב כתום 110 4000 מ"מ']);
    assert.ok(h.numbers.has('110'));
    assert.ok(h.numbers.has('4000'));
    assert.ok(!h.numbers.has('4'), 'the 4 of SN4 belongs to the word');
    const joined = haystack([
      'מעביר לביוב 110*200 כתום',
      'קטע תיקון "PVC 50 1.1/2',
    ]);
    for (const n of ['110', '200', '50', '1.1/2'])
      assert.ok(joined.numbers.has(n), n);
    const inch = haystack(['ברך "3/4 ו-"1.1/4']);
    assert.ok(!inch.numbers.has('4'), 'the 4 of 3/4 is not the number 4');
  });

  it('matches a word at its start, after Hebrew prefix letters only', () => {
    const t = (s: string, q: string) =>
      rank([s], (r) => haystack([r]), queryTerms([q])).all.length === 1;
    assert.ok(t('צינור SN4 לביוב כתום', 'ביוב'), 'ל is a prefix');
    assert.ok(t('צינורות לביוב', 'צינור'), 'a longer word');
    assert.ok(t('והצינור', 'צינור'), 'two prefix letters');
    assert.ok(!t('צינור סק 40 מגולבן', 'לבן'), 'מגו is not a prefix');
    assert.ok(t('צבוע לבן', 'לבן'));
    assert.ok(
      t('upvc pipe', 'pvc') === false,
      'Latin words match at the start',
    );
  });
});

describe('rank', () => {
  const rows = [
    'צינור SN4 לביוב כתום 110 1000 מ"מ',
    'צינור SN4 לביוב כתום 110 4000 מ"מ',
    'צינור SN4 לביוב כתום 160 4000 מ"מ',
    'שרוול PVC לביוב 110 כתום',
  ];
  const text = (r: string) => haystack([r]);

  it('returns the rows with every word, in order; a prefix letter does not hide a word', () => {
    const r = rank(rows, text, queryTerms(['ביוב צינור 110']));
    assert.deepEqual(r.all, [rows[0], rows[1]]);
    assert.deepEqual(r.closest, []);
    assert.deepEqual(rank(rows, text, queryTerms(['כתום 4000'])).all, [
      rows[1],
      rows[2],
    ]);
  });

  it('offers the closest rows, with the words they lack, when none has every word', () => {
    const r = rank(rows, text, queryTerms([`צינור 4${GERSHAYIM} כתום`]));
    assert.deepEqual(r.all, []);
    assert.equal(r.closest.length, 3);
    assert.deepEqual(r.closest[0]?.lacking, ['4']);
  });

  it('offers nothing when the closest rows match less than half of the words', () => {
    const r = rank(rows, text, queryTerms(['צינור ברזל מגולוון אדום']));
    assert.deepEqual(r, { all: [], closest: [] });
  });
});
