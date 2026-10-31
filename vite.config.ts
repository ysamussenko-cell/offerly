import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'],
      manifest: {
        name: 'Offerly — тренер английского для собеседования',
        short_name: 'Offerly',
        description: 'Личный ИИ-тренер подготовки к собеседованию на английском',
        lang: 'ru',
        theme_color: '#141C2B',
        background_color: '#F6F3EE',
        display: 'standalone',
        start_url: '/',
        id: '/',
        scope: '/',
        orientation: 'any',
        categories: ['education', 'productivity'],
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }
        ]
      },
      workbox: {
        // Оболочка приложения в предкэше; /api — только по сети (ответы и проверка офлайн не ходят, см. src/offline.ts).
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Web Push (4.5): обработчики push и клика по уведомлению — отдельный скрипт из public/, подключается в sw.js.
        importScripts: ['push-sw.js'],
        runtimeCaching: [
          { urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i, handler: 'StaleWhileRevalidate', options: { cacheName: 'google-fonts-css', expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365 } } },
          { urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i, handler: 'CacheFirst', options: { cacheName: 'google-fonts-files', expiration: { maxEntries: 24, maxAgeSeconds: 60 * 60 * 24 * 365 }, cacheableResponse: { statuses: [0, 200] } } },
        ],
      }
    })
  ],
  server: { proxy: { '/api': 'http://localhost:8788' } }
});
