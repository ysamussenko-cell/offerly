/** Банк заданий (2.4) и журнал ошибок (3.3): справочник, сводка, просмотр, пополнение, карточки. */
import { generateItems, parseGenerateBody, publicItem, KINDS, KIND_LABELS, LEVELS, TOPICS, DEFAULT_COUNT, MAX_COUNT, STATUSES, type Kind, type Level, type Status } from '../items';
import { publicCard, CARD_TOPICS } from '../cards';
import { area, bodyOf, domainOf, requireAuth } from './context';

export function itemRoutes() {
  const r = area();

  /** Справочник банка: уровни, виды и темы — для формы пополнения. */
  r.get('/items/topics', (c) => c.json({
    ok: true, levels: LEVELS, kinds: KINDS.map(id => ({ id, label: KIND_LABELS[id] })), topics: TOPICS, defaultCount: DEFAULT_COUNT, maxCount: MAX_COUNT,
  }));

  /** Сводка: сколько заданий в банке по уровню, виду и статусу. */
  r.get('/items/stats', requireAuth, async (c) => c.json({ ok: true, stats: await c.get('store').bankStats() }));

  /** Задания банка с ключами и заметками проверки — для просмотра владельцем. Фильтры: level, topic, kind, status, limit. */
  r.get('/items/bank', requireAuth, async (c) => {
    const q = (k: string) => c.req.query(k) || undefined;
    const level = q('level'), kind = q('kind'), status = q('status');
    if (level && !(LEVELS as readonly string[]).includes(level)) return c.json({ ok: false, error: 'items_invalid', field: 'level' }, 400);
    if (kind && !(KINDS as readonly string[]).includes(kind)) return c.json({ ok: false, error: 'items_invalid', field: 'kind' }, 400);
    if (status && !(STATUSES as readonly string[]).includes(status)) return c.json({ ok: false, error: 'items_invalid', field: 'status' }, 400);
    const items = await c.get('store').listItems({ level: level as Level, kind: kind as Kind, status: status as Status, topic: q('topic'), limit: Number(q('limit') ?? 50) || 50 });
    return c.json({ ok: true, items: items.map(publicItem) });
  });

  /** Пополнение банка: модель пишет задания по теме и уровню в домене пользователя, второй прогон проверяет каждое. */
  r.post('/items/generate', requireAuth, async (c) => {
    const body = await bodyOf(c);
    const v = parseGenerateBody(body);
    if (!v.ok) return c.json({ ok: false, error: 'items_invalid', field: v.field }, 400);
    const domain = await domainOf(c);
    try {
      const g = await generateItems(c.env, c.get('store'), { kind: v.kind, level: v.level, topic: v.topic, count: v.count, domain });
      const verified = g.items.filter(i => i.status === 'verified').length;
      return c.json({ ok: true, requested: v.count, verified, rejected: g.items.length - verified, dropped: g.dropped, items: g.items.map(publicItem) });
    } catch (e) {
      const detail = String(e instanceof Error ? e.message : e).slice(0, 300);
      console.error('item generation failed', detail);
      return c.json({ ok: false, error: 'items_failed', detail }, 502);
    }
  });

  /** Карточки ошибок пользователя: к повтору — первыми, погашенные — в конце. Создание из ошибок и повторы по FSRS — 3.3. */
  r.get('/cards', requireAuth, async (c) => {
    const cards = await c.get('store').listCards(c.get('auth')!.user.id);
    return c.json({ ok: true, topics: CARD_TOPICS.map(({ id, label }) => ({ id, label })), cards: cards.map(publicCard) });
  });

  return r;
}
