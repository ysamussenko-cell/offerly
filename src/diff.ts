/** Подсветка изменений между «как написано» и «как надо»: разница по словам (наибольшая общая подпоследовательность).
 *  Слова сравниваются без учёта регистра и знаков препинания по краям, чтобы точка или заглавная буква
 *  не красили всё предложение; выводятся слова в исходном написании. */

export type DiffOp = { type: 'same' | 'del' | 'ins'; text: string };

const tokens = (s: string) => s.split(/\s+/).filter(Boolean);
const key = (w: string) => w.toLowerCase().replace(/[’`]/g, "'").replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '');

/** Операции diff: same — слово на месте, del — убрано из написанного, ins — добавлено в правильном. */
export function wordDiff(from: string, to: string): DiffOp[] {
  const a = tokens(from), b = tokens(to);
  const n = a.length, m = b.length;
  // Длины общей подпоследовательности для суффиксов — O(n·m), предложения короткие.
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    L[i][j] = key(a[i]) === key(b[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const out: DiffOp[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (key(a[i]) === key(b[j])) { out.push({ type: 'same', text: b[j] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++; }
    else { out.push({ type: 'ins', text: b[j] }); j++; }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'ins', text: b[j++] });
  return merge(out);
}

/** Соседние слова одного типа склеиваются в один фрагмент. */
function merge(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (last && last.type === op.type) last.text += ` ${op.text}`;
    else out.push({ ...op });
  }
  return out;
}

/** Сколько слов изменилось: замена одного слова другим считается одним изменением — берётся большее
 *  из числа убранных и добавленных слов. «Одно слово» или «переписано целиком». */
export function changedWords(ops: DiffOp[]): number {
  const count = (t: DiffOp['type']) => ops.filter(o => o.type === t).reduce((s, o) => s + tokens(o.text).length, 0);
  return Math.max(count('del'), count('ins'));
}
