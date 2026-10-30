import { describe, it, expect, vi } from 'vitest';
import { createApp, type Env } from '../functions/_lib/app';
import { memoryStore } from './helpers/memoryStore';
import { loginCodeMail, sendMail } from '../functions/_lib/mail';
import { makeDocx, makePdf, SAMPLE_RESUME } from './helpers/fixtures';

function makeApp(envExtra: Partial<Env> = {}, aiRun: (...a: any[]) => Promise<any> = async () => ({ response: 'hi' })) {
  const mem = memoryStore();
  const env = { DB: null, AI: { run: aiRun }, APP_NAME: 'Offerly', ...envExtra } as unknown as Env;
  const app = createApp('test', () => mem.store);
  const call = (path: string, init: RequestInit = {}) => app.request(`https://offerly.test/api${path}`, init, env);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { app, env, mem, call, post };
}

describe('API входа', () => {
  it('без почтового ключа в проде отвечает 503 и не раскрывает код', async () => {
    const { post, mem } = makeApp();
    const r = await post('/auth/request', { email: 'a@b.cc' });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ ok: false, error: 'mail_not_configured' });
    expect(mem.codes).toHaveLength(1);
  });

  it('в режиме DEV_ECHO_CODE проходит полный цикл: код → cookie → /me → выход', async () => {
    const { post, call } = makeApp({ DEV_ECHO_CODE: '1' });
    const r1 = await post('/auth/request', { email: 'Yuriy@Example.com' });
    expect(r1.status).toBe(200);
    const j1: any = await r1.json();
    expect(j1.delivery).toBe('echo');

    expect((await call('/me')).status).toBe(401);

    const bad = await post('/auth/verify', { email: 'yuriy@example.com', code: '000000' === j1.code ? '000001' : '000000' });
    expect(bad.status).toBe(401);

    const r2 = await post('/auth/verify', { email: 'yuriy@example.com', code: j1.code });
    expect(r2.status).toBe(200);
    const j2: any = await r2.json();
    expect(j2.user.email).toBe('yuriy@example.com');
    const cookie = r2.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^offerly_session=[0-9a-f]{64};/);
    expect(cookie).toContain('Secure');
    const token = cookie.split(';')[0];

    const me = await call('/me', { headers: { cookie: token } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as any).user.email).toBe('yuriy@example.com');

    const out = await post('/auth/logout', {}, { cookie: token });
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await call('/me', { headers: { cookie: token } })).status).toBe(401);
  });

  it('отправляет письмо через Resend, когда ключ задан', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { post } = makeApp({ RESEND_API_KEY: 're_test' });
      const r = await post('/auth/request', { email: 'a@b.cc' });
      expect(r.status).toBe(200);
      expect(((await r.json()) as any).delivery).toBe('email');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init]: any = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.resend.com/emails');
      const body = JSON.parse(init.body);
      expect(body.to).toEqual(['a@b.cc']);
      expect(body.subject).toMatch(/^\d{6} — код входа/);
      expect(init.headers.authorization).toBe('Bearer re_test');
    } finally { vi.unstubAllGlobals(); }
  });

  it('ошибка Resend даёт 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { post } = makeApp({ RESEND_API_KEY: 're_test' });
      expect((await post('/auth/request', { email: 'a@b.cc' })).status).toBe(502);
    } finally { vi.unstubAllGlobals(); errSpy.mockRestore(); }
  });

  it('плохой адрес — 400, лимит кодов — 429', async () => {
    const { post } = makeApp({ DEV_ECHO_CODE: '1' });
    expect((await post('/auth/request', { email: 'x' })).status).toBe(400);
    for (let i = 0; i < 3; i++) await post('/auth/request', { email: 'a@b.cc' });
    expect((await post('/auth/request', { email: 'a@b.cc' })).status).toBe(429);
  });

  it('health сообщает о почте', async () => {
    const { call } = makeApp();
    const j: any = await (await call('/health')).json();
    expect(j.mail).toBe('missing');
    expect(j.version).toBe('test');
  });
});

const PROFILE_JSON = JSON.stringify({
  specialty: 'инженер-теплоэнергетик', industry: 'энергетика', years: 15, target_role: null,
  keywords: ['boiler efficiency', 'energy audit', 'steam turbine'], summary: 'Вы инженер-теплоэнергетик с опытом пятнадцать лет.',
});

/** Вход тестового пользователя: возвращает заголовок cookie. */
async function signIn(post: ReturnType<typeof makeApp>['post'], email = 'yuriy@example.com') {
  const j1: any = await (await post('/auth/request', { email })).json();
  const r2 = await post('/auth/verify', { email, code: j1.code });
  return { cookie: r2.headers.get('set-cookie')!.split(';')[0] };
}

describe('API резюме и профиля', () => {
  it('без сессии — 401', async () => {
    const { call, post } = makeApp();
    expect((await call('/profile')).status).toBe(401);
    expect((await post('/resume', { text: 'x' })).status).toBe(401);
    expect((await post('/resume/analyze', {})).status).toBe(401);
  });

  it('до загрузки профиль пуст', async () => {
    const { call, post } = makeApp({ DEV_ECHO_CODE: '1' });
    const { cookie } = await signIn(post);
    const j: any = await (await call('/profile', { headers: { cookie } })).json();
    expect(j).toEqual({ ok: true, profile: null });
  });

  it('DOCX → текст → профиль через модель', async () => {
    const aiRun = vi.fn(async (_model: string, input: any) => {
      expect(input.messages[1].content).toContain('Thermal Power Engineer');
      return { response: PROFILE_JSON };
    });
    const { call, post, mem } = makeApp({ DEV_ECHO_CODE: '1' }, aiRun);
    const { cookie } = await signIn(post);
    const fd = new FormData();
    fd.append('file', new File([makeDocx(SAMPLE_RESUME) as BlobPart], 'resume.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
    const r = await call('/resume', { method: 'POST', headers: { cookie }, body: fd });
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.profile.specialty).toBe('инженер-теплоэнергетик');
    expect(j.profile.years).toBe(15);
    expect(j.profile.keywords).toEqual(['boiler efficiency', 'energy audit', 'steam turbine']);
    expect(j.profile.resumeName).toBe('resume.docx');
    expect(j.profile.analyzed).toBe(true);
    expect(j.profile.resumeText).toBeUndefined();
    expect(aiRun).toHaveBeenCalledTimes(1);
    const stored = [...mem.profiles.values()][0];
    expect(stored.resumeText).toContain('energy audit');
  });

  it('PDF и вставленный текст тоже принимаются', async () => {
    const { call, post } = makeApp({ DEV_ECHO_CODE: '1' }, async () => ({ response: PROFILE_JSON }));
    const { cookie } = await signIn(post);
    const fd = new FormData();
    fd.append('file', new File([makePdf(SAMPLE_RESUME) as BlobPart], 'cv.pdf', { type: 'application/pdf' }));
    expect((await call('/resume', { method: 'POST', headers: { cookie }, body: fd })).status).toBe(200);
    const r = await post('/resume', { text: SAMPLE_RESUME.join('\n') }, { cookie });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).profile.resumeName).toBe('текст');
  });

  it('ошибки файла — понятные коды', async () => {
    const { call, post } = makeApp({ DEV_ECHO_CODE: '1' });
    const { cookie } = await signIn(post);
    const send = async (name: string, bytes: Uint8Array, type?: string) => {
      const fd = new FormData();
      fd.append('file', new File([bytes as BlobPart], name, type ? { type } : undefined));
      const r = await call('/resume', { method: 'POST', headers: { cookie }, body: fd });
      return { status: r.status, error: ((await r.json()) as any).error };
    };
    const junk = new Uint8Array(400); for (let i = 0; i < junk.length; i++) junk[i] = (i * 7) % 5;
    expect(await send('cv.dat', junk)).toEqual({ status: 415, error: 'resume_unsupported' });
    expect(await send('scan.pdf', makePdf([]))).toEqual({ status: 422, error: 'resume_no_text' });
    expect(await send('cv.txt', new TextEncoder().encode('коротко'), 'text/plain')).toEqual({ status: 400, error: 'resume_too_short' });
    expect((await post('/resume', { text: 'коротко' }, { cookie })).status).toBe(400);
    const empty = new FormData(); empty.append('other', 'x');
    expect((await call('/resume', { method: 'POST', headers: { cookie }, body: empty })).status).toBe(400);
  });

  it('модель не ответила JSON — 502, текст сохранён, повтор через /resume/analyze', async () => {
    let calls = 0;
    const aiRun = async () => ({ response: ++calls <= 2 ? 'I am not able to help.' : PROFILE_JSON });
    const { call, post, mem } = makeApp({ DEV_ECHO_CODE: '1' }, aiRun);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { cookie } = await signIn(post);
      const r = await post('/resume', { text: SAMPLE_RESUME.join('\n') }, { cookie });
      expect(r.status).toBe(502);
      const j: any = await r.json();
      expect(j.error).toBe('profile_failed');
      expect(j.profile.analyzed).toBe(false);
      expect(j.profile.resumeChars).toBeGreaterThan(200);
      expect([...mem.profiles.values()][0].resumeText).toContain('Almaty');

      const r2 = await post('/resume/analyze', {}, { cookie });
      expect(r2.status).toBe(200);
      expect(((await r2.json()) as any).profile.industry).toBe('энергетика');
      expect(calls).toBe(3);
    } finally { errSpy.mockRestore(); }
  });

  it('повторный разбор без резюме — 400', async () => {
    const { post } = makeApp({ DEV_ECHO_CODE: '1' });
    const { cookie } = await signIn(post);
    expect((await post('/resume/analyze', {}, { cookie })).status).toBe(400);
  });
});

describe('письмо с кодом', () => {
  it('содержит код в теме и теле, без эмодзи', () => {
    const m = loginCodeMail('482913', 10);
    expect(m.subject).toContain('482913');
    expect(m.text).toContain('482913');
    expect(m.html).toContain('482913');
    expect(m.text + m.subject).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });
  it('без ключа не делает запросов', async () => {
    const f = vi.fn();
    expect(await sendMail({}, 'a@b.cc', loginCodeMail('1', 1), f as any)).toEqual({ sent: false, reason: 'not_configured' });
    expect(f).not.toHaveBeenCalled();
  });
});
