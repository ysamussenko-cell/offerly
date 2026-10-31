import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, errorText, type User } from '../api';
import { useHotkeys } from '../KeyHints';

type Step = { kind: 'email' } | { kind: 'code'; email: string; echoCode?: string };

const RESEND_AFTER_SEC = 60;

export default function Login({ onLogin }: { onLogin: (user: User, isNew: boolean) => void }) {
  const [step, setStep] = useState<Step>({ kind: 'email' });
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn(s => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  useEffect(() => { if (step.kind === 'code') codeRef.current?.focus(); }, [step.kind]);
  // Esc на шаге кода — вернуться к вводу почты. Enter отправляет формы сам браузер.
  useHotkeys({ cancel: step.kind === 'code' && !busy, busy }, { onCancel: () => { setStep({ kind: 'email' }); setError(null); } });

  async function requestCode(target: string) {
    setBusy(true); setError(null);
    try {
      const r = await api.requestCode(target);
      setStep({ kind: 'code', email: target.trim().toLowerCase(), echoCode: r.code });
      setCode('');
      setResendIn(RESEND_AFTER_SEC);
    } catch (e) {
      setError(errorText(e));
    } finally { setBusy(false); }
  }

  async function submitEmail(e: FormEvent) {
    e.preventDefault();
    await requestCode(email);
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (step.kind !== 'code') return;
    setBusy(true); setError(null);
    try {
      const r = await api.verifyCode(step.email, code);
      onLogin(r.user, r.isNew);
    } catch (err) {
      setError(errorText(err));
    } finally { setBusy(false); }
  }

  if (step.kind === 'email') {
    return (
      <section className="card login">
        <h2>Вход</h2>
        <p className="muted">Пароля нет. Введите почту — пришлём шестизначный код, он действует десять минут.</p>
        <form onSubmit={submitEmail} className="stack">
          <label className="field">
            <span>Почта</span>
            <input type="email" name="email" autoComplete="email" inputMode="email" required autoFocus
              value={email} onChange={e => setEmail(e.target.value)} placeholder="name@company.com" />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="btn" type="submit" disabled={busy || !email}>{busy ? 'Отправляю…' : 'Получить код'}</button>
        </form>
      </section>
    );
  }

  return (
    <section className="card login">
      <h2>Код из письма</h2>
      <p className="muted">Отправили на <span className="mono">{step.email}</span>. Если письма нет пару минут — загляните в спам.</p>
      {step.echoCode && <p className="muted">Режим разработки: почта не настроена, код — <span className="mono">{step.echoCode}</span>.</p>}
      <form onSubmit={submitCode} className="stack">
        <label className="field">
          <span>Шесть цифр</span>
          <input ref={codeRef} className="mono code-input" name="code" inputMode="numeric" autoComplete="one-time-code"
            pattern="[0-9 ]*" maxLength={7} required value={code}
            onChange={e => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} placeholder="000000" />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row">
          <button className="btn" type="submit" disabled={busy || code.length !== 6}>{busy ? 'Проверяю…' : 'Войти'}</button>
          <button className="btn secondary" type="button" disabled={busy || resendIn > 0} onClick={() => requestCode(step.email)}>
            {resendIn > 0 ? `Отправить снова через ${resendIn} с` : 'Отправить снова'}
          </button>
          <button className="link" type="button" disabled={busy} onClick={() => { setStep({ kind: 'email' }); setError(null); }} aria-keyshortcuts="Escape">Другой адрес</button>
        </div>
      </form>
    </section>
  );
}
