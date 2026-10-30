/** Отправка писем через Resend. Без ключа RESEND_API_KEY писем нет — API честно сообщает об этом. */

export interface MailEnv { RESEND_API_KEY?: string; MAIL_FROM?: string; APP_NAME: string }

export const DEFAULT_FROM = 'Offerly <onboarding@resend.dev>';

export function loginCodeMail(code: string, ttlMinutes: number, appName = 'Offerly') {
  const subject = `${code} — код входа в ${appName}`;
  const text = [
    `Код входа в ${appName}: ${code}`,
    '',
    `Он действует ${ttlMinutes} минут. Если вы не запрашивали вход, просто не обращайте внимания на это письмо.`,
  ].join('\n');
  const html = `<!doctype html><html lang="ru"><body style="margin:0;background:#F6F3EE;font-family:Inter,Arial,sans-serif;color:#1C2433">
<div style="max-width:480px;margin:0 auto;padding:40px 24px">
  <div style="font-family:Manrope,Inter,Arial,sans-serif;font-weight:800;font-size:20px;color:#141C2B;margin-bottom:24px">${appName}</div>
  <div style="background:#FFFFFF;border:1px solid #E6E1D8;border-radius:16px;padding:24px">
    <p style="margin:0 0 12px;color:#6B7280">Код входа</p>
    <p style="margin:0 0 16px;font-family:'JetBrains Mono',Consolas,monospace;font-size:32px;letter-spacing:.2em;color:#141C2B">${code}</p>
    <p style="margin:0;color:#6B7280;font-size:14px">Действует ${ttlMinutes} минут. Если вы не запрашивали вход, просто не обращайте внимания на это письмо.</p>
  </div>
</div></body></html>`;
  return { subject, text, html };
}

export type SendResult = { sent: true; id?: string } | { sent: false; reason: 'not_configured' | 'provider_error'; detail?: string };

export async function sendMail(env: MailEnv, to: string, msg: { subject: string; text: string; html: string }, fetchFn: typeof fetch = fetch): Promise<SendResult> {
  if (!env.RESEND_API_KEY) return { sent: false, reason: 'not_configured' };
  const r = await fetchFn('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: env.MAIL_FROM || DEFAULT_FROM, to: [to], subject: msg.subject, text: msg.text, html: msg.html }),
  });
  if (!r.ok) return { sent: false, reason: 'provider_error', detail: `Resend ${r.status}: ${(await r.text()).slice(0, 300)}` };
  const j: any = await r.json().catch(() => ({}));
  return { sent: true, id: j.id };
}
