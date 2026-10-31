import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { MANIFEST } from './src/manifest';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'],
      // Манифест — src/manifest.ts (один источник для сборки и тестов; ссылки быстрого доступа — 6.1).
      manifest: MANIFEST,
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
