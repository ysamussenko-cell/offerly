import { describe, it, expect, expectTypeOf } from 'vitest';
import type { Attempt, WritingError } from '../functions/_lib/types';
import type { AttemptPatch } from '../functions/_lib/assessment';
import type { WritingEval } from '../functions/_lib/scoring';
import type { CardDraft } from '../functions/_lib/cards';
import { draftsFromWriting } from '../functions/_lib/cards';

/** Общие типы оценивания: контракт между тестом, оценкой и журналом. Проверки типов срабатывают при проверке
 *  типов тестов; проверка во время выполнения — что ошибка письма из types.ts проходит путь до черновика карточки. */
describe('types.ts — общие типы оценивания', () => {
  it('Attempt — то, что правит AttemptPatch, и то, что хранит оценка письма', () => {
    expectTypeOf<AttemptPatch>().toMatchTypeOf<Partial<Attempt>>();
    expectTypeOf<WritingEval['errors'][number]>().toEqualTypeOf<WritingError>();
    expectTypeOf<Attempt['detail']>().toEqualTypeOf<string | null>();
  });

  it('ошибка письма из types.ts становится черновиком карточки журнала без потерь', () => {
    const error: WritingError = { original: 'I have went there', corrected: 'I went there', note: 'Past Simple для законченного действия.', topic: 'tenses' };
    const drafts: CardDraft[] = draftsFromWriting([error], 'attempt:A1', null);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ topic: 'tenses', example: 'I have went there', correction: 'I went there', rule: 'Past Simple для законченного действия.', origin: 'attempt:A1:w1' });
  });
});
