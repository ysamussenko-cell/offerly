/** Стенд для сценариев Playwright: статический dist плюс API на том же порту.
 *  /api/* идёт в createApp с хранилищем в памяти (memoryStore) — без D1, без модели (см. StandAi) и без почты:
 *  код входа возвращается в ответе (DEV_ECHO_CODE), задания берутся из банка, который сценарий засеивает
 *  через служебный маршрут /__e2e/seed. Любой другой путь без расширения отдаёт index.html — как Pages. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, type Env } from '../functions/_lib/app';
import { memoryStore } from '../tests/helpers/memoryStore';
import { seedUser, type SeedOptions } from './seed';

export const E2E_VERSION = 'e2e';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

export interface Stand {
  url: string;
  port: number;
  memory: ReturnType<typeof memoryStore>;
  ai: StandAi;
  close(): Promise<void>;
}

/** Модель стенда. По умолчанию недоступна: любой вызов падает с понятной ошибкой — сценарии не зависят от неё,
 *  а экраны показывают путь сбоя (встроенный сценарий, «Разобрать снова», «Оценить письмо снова»).
 *  Сценарий может положить заготовленный ответ экзаменатора: reply(match, json) — он уйдёт первому вызову, у которого
 *  системная подсказка содержит match, один раз. Это ответ «модели», а не эталон: эталоны и рубрики остаются в банке,
 *  и сервер проверяет ответ так же, как настоящий (цитаты, которых нет в тексте ученика, отбрасываются). */
export interface StandAi {
  reply(match: string, body: unknown): void;
  /** Все вызовы модели: системная подсказка, запрос и чем кончился вызов. */
  calls: { system: string; user: string; answered: boolean }[];
  /** Заготовки, которые ещё никто не забрал. */
  pending(): number;
}

function standAi(): StandAi & { run(model: string, input: { messages?: { role: string; content: string }[] }): Promise<{ response: string }> } {
  const queue: { match: string; body: string }[] = [];
  const calls: StandAi['calls'] = [];
  return {
    calls,
    reply(match, body) { queue.push({ match, body: typeof body === 'string' ? body : JSON.stringify(body) }); },
    pending: () => queue.length,
    async run(_model, input) {
      const msgs = input?.messages ?? [];
      const system = msgs.filter(m => m.role === 'system').map(m => m.content).join('\n');
      const user = msgs.filter(m => m.role === 'user').map(m => m.content).join('\n');
      const i = queue.findIndex(q => system.includes(q.match));
      calls.push({ system, user, answered: i >= 0 });
      if (i < 0) throw new Error('на стенде e2e модель отключена');
      return { response: queue.splice(i, 1)[0].body };
    },
  };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function toRequest(req: IncomingMessage, origin: string, body: Buffer): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    if (Array.isArray(v)) for (const x of v) headers.append(k, x); else headers.set(k, v);
  }
  const method = req.method ?? 'GET';
  return new Request(origin + (req.url ?? '/'), { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(body) });
}

async function send(res: ServerResponse, r: Response) {
  const headers: Record<string, string | string[]> = {};
  r.headers.forEach((v, k) => { headers[k] = k === 'set-cookie' ? r.headers.getSetCookie() : v; });
  res.writeHead(r.status, headers);
  res.end(Buffer.from(await r.arrayBuffer()));
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** Поднимает стенд на свободном порту (или заданном). dist — собранная оболочка (`npm run build`). */
export async function startStand(opts: { dist?: string; port?: number } = {}): Promise<Stand> {
  const dist = opts.dist ?? join(process.cwd(), 'dist');
  const memory = memoryStore();
  const ai = standAi();
  // RELEASE_URL задаётся после старта: адрес стенда, который отвечает 404 — страница установки показывает «готовится» без похода на GitHub.
  const env = { DB: null, AI: ai, APP_NAME: 'Offerly', DEV_ECHO_CODE: '1' } as unknown as Env & { RELEASE_URL?: string };
  const app = createApp(E2E_VERSION, () => memory.store);
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const index = await readFile(join(dist, 'index.html'));

  const server: Server = createServer(async (req, res) => {
    const origin = `http://${req.headers.host ?? 'localhost'}`;
    const path = new URL(req.url ?? '/', origin).pathname;
    try {
      if (path.startsWith('/api/')) {
        const body = await readBody(req);
        return await send(res, await app.fetch(toRequest(req, origin, body), env, ctx));
      }
      if (path === '/__e2e/seed' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}') as SeedOptions;
        const result = await seedUser(memory, body);
        return json(res, result ? 200 : 404, result ? { ok: true, ...result } : { ok: false, error: 'user_not_found' });
      }
      const ext = extname(path);
      if (ext && TYPES[ext]) {
        const file = normalize(join(dist, path));
        if (file.startsWith(dist) && (await stat(file).catch(() => null))?.isFile()) {
          res.writeHead(200, { 'content-type': TYPES[ext], 'cache-control': 'no-store' });
          return res.end(await readFile(file));
        }
        res.writeHead(404); return res.end();
      }
      res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' });
      res.end(index);
    } catch (e) {
      json(res, 500, { ok: false, error: 'stand_failed', detail: String(e instanceof Error ? e.message : e) });
    }
  });

  await new Promise<void>(resolve => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  env.RELEASE_URL = `http://127.0.0.1:${port}/__e2e/no-release.json`;
  return {
    url: `http://127.0.0.1:${port}`, port, memory, ai,
    close: () => new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve()))),
  };
}
