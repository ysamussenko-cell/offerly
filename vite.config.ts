import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
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
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
        ]
      },
      workbox: { navigateFallbackDenylist: [/^\/api\//] }
    })
  ],
  server: { proxy: { '/api': 'http://localhost:8788' } }
});
