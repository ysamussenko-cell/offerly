import { defineConfig } from 'vitest/config';

/** Сценарии Playwright (e2e/*.e2e.ts): каждый файл поднимает свой стенд и браузер — файлы идут по очереди,
 *  сценарии внутри файла — в порядке записи (общее состояние стенда). Нужен собранный dist: `npm run build`. */
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    bail: 0,
  },
});
