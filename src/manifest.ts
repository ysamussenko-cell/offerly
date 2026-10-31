/**
 * Манифест PWA — один источник для vite.config.ts (vite-plugin-pwa) и тестов. Ссылки быстрого доступа (6.1):
 * долгое нажатие на значок на Android и в Windows открывает занятие дня, репетицию или настройки сразу —
 * адреса те же, что разбирает src/nav.ts (?screen=…).
 */
import { hrefFor, type ScreenName } from './nav';

const ICON_192 = { src: '/icon-192.png', sizes: '192x192', type: 'image/png' };

export interface Shortcut { name: string; short_name: string; description: string; url: string; icons: typeof ICON_192[] }

export const SHORTCUTS: readonly (Shortcut & { screen: ScreenName })[] = [
  { screen: 'lesson', name: 'Занятие дня', short_name: 'Занятие', description: 'Разминка, письмо и повтор карточек по программе', url: hrefFor('lesson'), icons: [ICON_192] },
  { screen: 'rehearsal', name: 'Репетиция интервью', short_name: 'Репетиция', description: 'Пять вопросов по целевой позиции и разбор', url: hrefFor('rehearsal'), icons: [ICON_192] },
  { screen: 'settings', name: 'Настройки', short_name: 'Настройки', description: 'Свой ключ модели, время уведомлений, копия данных', url: hrefFor('settings'), icons: [ICON_192] },
];

export const MANIFEST = {
  name: 'Offerly — тренер английского для собеседования',
  short_name: 'Offerly',
  description: 'Личный ИИ-тренер подготовки к собеседованию на английском',
  lang: 'ru',
  dir: 'ltr',
  theme_color: '#141C2B',
  background_color: '#F6F3EE',
  display: 'standalone',
  display_override: ['standalone', 'minimal-ui'],
  start_url: '/',
  id: '/',
  scope: '/',
  orientation: 'any',
  categories: ['education', 'productivity'],
  prefer_related_applications: false,
  icons: [
    ICON_192,
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
  ],
  shortcuts: SHORTCUTS.map(({ screen: _screen, ...s }) => s),
} as const;
