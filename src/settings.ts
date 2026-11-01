/** Тексты экрана настроек — чистые функции без DOM, чтобы проверять их тестами. */
import { ApiError, ERRORS, type Settings } from './api';
import { longDateAt } from './text';

/** Строка о ключе: встроенная модель или свой провайдер с моделью, подсказкой ключа и итогом проверки. */
export function keyStatusText(s: Settings['provider']): string {
  const k = s.key;
  if (!k) return `Работает встроенная модель — ${s.builtin}. Ключи не нужны.`;
  if (!k.readable) return `Сохранён ключ ${k.short} (${k.hint}), но он не читается: мастер-ключ сервера сменился. Введите ключ заново или уберите его.`;
  const model = k.custom ? `модель ${k.model}` : `модель по умолчанию ${k.model}`;
  const check = !k.checkNote ? 'ещё не проверялся'
    : k.checkNote === 'ok' ? `проверен ${k.checkedAt ? longDateAt(k.checkedAt) : ''}`.trim()
    : `последняя проверка не прошла: ${k.checkNote.replace(/^error:/, '')}`;
  return `Задания и проверку делает ${k.providerName}, ${model}, ключ ${k.hint} — ${check}${check.endsWith('.') ? '' : '.'}`;
}

/** Строка об уведомлениях: оба канала выключены, одно время или разные. */
export function notificationsText(n: Settings['notifications']): string {
  const { mail, push } = n;
  if (!mail.enabled && !push.enabled) return `Уведомления выключены. Включите письмо или напоминание — время по умолчанию ${n.defaultAt}.`;
  const parts: string[] = [];
  if (mail.enabled) parts.push(`письмо в ${mail.at}`);
  if (push.enabled) parts.push(`напоминание в ${push.at}`);
  const same = mail.enabled && push.enabled && mail.at === push.at;
  const head = same ? `Письмо и напоминание в ${mail.at}` : parts.join(', ').replace(/^./, c => c.toUpperCase());
  return `${head} (${n.tz}, сейчас там ${n.localTime}). Окно отправки — ${n.windowMinutes / 60} часа после назначенного времени.`;
}

/** Сводка данных для карточки экспорта. */
export function countsText(c: Settings['data']['counts']): string {
  const items = [
    [c.assessments, 'тест', 'теста', 'тестов'], [c.lessons, 'занятие', 'занятия', 'занятий'], [c.rehearsals, 'репетиция', 'репетиции', 'репетиций'],
    [c.cards, 'карточка', 'карточки', 'карточек'], [c.programDays, 'день программы', 'дня программы', 'дней программы'], [c.speeches, 'запись речи', 'записи речи', 'записей речи'],
  ] as const;
  const pl = (n: number, one: string, few: string, many: string) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many; };
  return items.filter(([n]) => n > 0).map(([n, a, b, c]) => `${n} ${pl(n, a, b, c)}`).join(', ') || 'пока только профиль и анкета';
}

/** Отказы при сохранении ключа — по причине. */
export const KEY_REFUSALS: Record<string, string> = {
  provider: 'Выберите провайдера из списка — встроенной модели ключ не нужен.',
  key: 'Ключ — одна строка без пробелов, от 8 до 512 знаков.',
  prefix: 'Ключ этого провайдера начинается иначе — проверьте, что скопировали его целиком и у нужного провайдера.',
  model: 'Имя модели — буквы, цифры и знаки «.-_:/», до 120 знаков; оставьте поле пустым для модели по умолчанию.',
};

export const keyErrorText = (e: unknown) => {
  if (e instanceof ApiError && e.code === 'key_invalid') return KEY_REFUSALS[String(e.body?.reason)] ?? ERRORS.key_invalid;
  if (e instanceof ApiError && e.code === 'key_check_failed') return `${ERRORS.key_check_failed}${typeof e.body?.detail === 'string' ? ` Ответ провайдера: ${e.body.detail}` : ''}`;
  const base = (e instanceof ApiError && ERRORS[e.code]) || ERRORS.request_failed;
  return base;
};

/** Подпись к полю ключа: префикс, если известен. */
export const keyPlaceholder = (prefix: string | null) => (prefix ? `${prefix}…` : 'ключ провайдера');

/** Проверка на клиенте перед отправкой — те же правила, что на сервере, чтобы не гонять запрос зря. */
export function validateKeyInput(provider: { id: string; prefix: string | null } | undefined, apiKey: string, model: string): string | null {
  if (!provider) return KEY_REFUSALS.provider;
  const k = apiKey.trim();
  if (k.length < 8 || k.length > 512 || /\s/.test(k)) return KEY_REFUSALS.key;
  if (provider.prefix && !k.startsWith(provider.prefix)) return KEY_REFUSALS.prefix;
  const m = model.trim();
  if (m && (m.length > 120 || !/^[\w.\-:/]+$/.test(m))) return KEY_REFUSALS.model;
  return null;
}
