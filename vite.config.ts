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
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }
        ]
      },
      workbox: { navigateFallbackDenylist: [/^\/api\//] }
    })
  ],
  server: { proxy: { '/api': 'http://localhost:8788' } }
});
