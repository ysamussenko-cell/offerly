import { describe, it, expect } from 'vitest';
import { wordDiff, changedWords } from '../src/diff';

describe('подсветка изменений по словам', () => {
  it('одно слово заменено — остальное на месте; регистр и знаки по краям не считаются изменением', () => {
    const ops = wordDiff('The turbine have been inspected twice.', 'the turbine has been inspected twice');
    expect(ops).toEqual([
      { type: 'same', text: 'the turbine' }, { type: 'del', text: 'have' }, { type: 'ins', text: 'has' }, { type: 'same', text: 'been inspected twice' },
    ]);
    expect(changedWords(ops)).toBe(1);
  });
  it('вставка и удаление без замены', () => {
    expect(wordDiff('We installed boilers in 2020.', 'We installed the boilers in 2020.')).toEqual([
      { type: 'same', text: 'We installed' }, { type: 'ins', text: 'the' }, { type: 'same', text: 'boilers in 2020.' },
    ]);
    expect(wordDiff('We have installed boilers.', 'We installed boilers.')).toEqual([
      { type: 'same', text: 'We' }, { type: 'del', text: 'have' }, { type: 'same', text: 'installed boilers.' },
    ]);
  });
  it('одинаковые тексты — один фрагмент same; пустые — пусто; совсем разные — del и ins целиком', () => {
    expect(wordDiff('a b c', 'a b c')).toEqual([{ type: 'same', text: 'a b c' }]);
    expect(wordDiff('', '')).toEqual([]);
    expect(wordDiff('one two', 'three four')).toEqual([{ type: 'del', text: 'one two' }, { type: 'ins', text: 'three four' }]);
    expect(changedWords(wordDiff('one two', 'three four'))).toBe(2);
    expect(changedWords(wordDiff('a b c', 'a c'))).toBe(1);
  });
  it('апострофы и типографские кавычки считаются одним словом', () => {
    expect(wordDiff("it’s ready", "it's ready")).toEqual([{ type: 'same', text: "it's ready" }]);
  });
});
