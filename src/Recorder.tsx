import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText, type Speech } from './api';
import { canRecord, decodedToWav, formatSeconds, mediaErrorKey, MAX_SECONDS, pickMimeType, VOICE_ERRORS } from './voice';

export type RecorderState = 'idle' | 'recording' | 'processing';

export type Recorder = {
  state: RecorderState;
  /** Секунд записано — для счётчика на экране. */
  seconds: number;
  error: string | null;
  /** Запись голоса возможна в этом браузере. */
  available: boolean;
  start: () => void;
  stop: () => void;
  toggle: () => void;
};

/** Запись в WAV 16 кГц моно; если декодер браузера не справился — исходная запись как есть. */
async function toUpload(blob: Blob): Promise<{ audio: Blob; name: string }> {
  try {
    const Ctx = (window as any).AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctx) throw new Error('no AudioContext');
    const ctx = new Ctx();
    try {
      const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
      return { audio: new Blob([decodedToWav(decoded)], { type: 'audio/wav' }), name: 'answer.wav' };
    } finally { ctx.close?.().catch?.(() => {}); }
  } catch {
    const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mpeg') ? 'mp3' : 'webm';
    return { audio: blob, name: `answer.${ext}` };
  }
}

/** Запись с микрофона → сервер → расшифровка. onResult получает запись речи (текст и мерки).
 *  Остановка — повторным нажатием, отпусканием пробела или по пределу MAX_SECONDS. */
export function useRecorder(onResult: (s: Speech) => void): Recorder {
  const [state, setState] = useState<RecorderState>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<number | null>(null);
  const startedAt = useRef(0);
  /** Идёт запрос к микрофону — повторный старт (автоповтор пробела) не нужен. */
  const starting = useRef(false);
  const latest = useRef(onResult);
  latest.current = onResult;
  const available = canRecord();

  const cleanup = () => {
    if (timer.current != null) { window.clearInterval(timer.current); timer.current = null; }
    stream.current?.getTracks().forEach(t => t.stop());
    stream.current = null;
    rec.current = null;
  };

  const stop = useCallback(() => {
    const r = rec.current;
    if (!r || r.state === 'inactive') return;
    try { r.stop(); } catch { /* уже остановлен */ }
  }, []);

  const start = useCallback(async () => {
    if (rec.current || starting.current || state !== 'idle') return;
    if (!available) { setError(VOICE_ERRORS.unsupported); return; }
    setError(null);
    starting.current = true;
    let s: MediaStream;
    try { s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }); }
    catch (e) { starting.current = false; setError(VOICE_ERRORS[mediaErrorKey(e)]); return; }
    const mime = pickMimeType(t => MediaRecorder.isTypeSupported(t));
    let r: MediaRecorder;
    try { r = mime ? new MediaRecorder(s, { mimeType: mime }) : new MediaRecorder(s); }
    catch { starting.current = false; s.getTracks().forEach(t => t.stop()); setError(VOICE_ERRORS.unsupported); return; }
    starting.current = false;
    chunks.current = [];
    r.ondataavailable = e => { if (e.data.size > 0) chunks.current.push(e.data); };
    r.onerror = () => { setError(VOICE_ERRORS.decode); cleanup(); setState('idle'); };
    r.onstop = async () => {
      const blob = new Blob(chunks.current, { type: r.mimeType || mime || 'audio/webm' });
      const took = (Date.now() - startedAt.current) / 1000;
      cleanup();
      if (blob.size < 1024 || took < 0.6) { setState('idle'); setError(took < 0.6 ? null : VOICE_ERRORS.decode); return; }
      setState('processing');
      try {
        const up = await toUpload(blob);
        const res = await api.transcribe(up.audio, up.name);
        latest.current(res.speech);
      } catch (e) { setError(errorText(e)); }
      finally { setState('idle'); }
    };
    stream.current = s; rec.current = r;
    startedAt.current = Date.now();
    setSeconds(0); setState('recording');
    r.start(1000);
    timer.current = window.setInterval(() => {
      const t = (Date.now() - startedAt.current) / 1000;
      setSeconds(t);
      if (t >= MAX_SECONDS) stop();
    }, 250);
  }, [available, state, stop]);

  const toggle = useCallback(() => { if (rec.current) stop(); else void start(); }, [start, stop]);

  useEffect(() => () => { try { rec.current?.stop(); } catch { /* размонтирование */ } cleanup(); }, []);

  return { state, seconds, error, available, start: () => { void start(); }, stop, toggle };
}

const MicIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /><path d="M8 21h8" />
  </svg>
);

const StopIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
);

type MicProps = { rec: Recorder; disabled?: boolean; /** Что записываем — для подписи рядом. */ what?: string };

/** Кнопка-микрофон у поля ответа: нажать — запись, нажать снова — стоп и распознавание. Счётчик и ошибки — рядом. */
export function MicButton({ rec, disabled, what = 'ответ' }: MicProps) {
  if (!rec.available) return null;
  const recording = rec.state === 'recording';
  const processing = rec.state === 'processing';
  return (
    <div className="mic-row">
      <button type="button" className={`mic ${rec.state}`} onClick={rec.toggle} disabled={disabled || processing} aria-pressed={recording} aria-keyshortcuts="Space">
        {recording ? <StopIcon /> : <MicIcon />}
        <span>{processing ? 'Распознаю речь…' : recording ? `Остановить · ${formatSeconds(rec.seconds)}` : `Сказать ${what} голосом`}</span>
      </button>
      {recording && <span className="rec-note"><span className="rec-dot" aria-hidden="true" />Говорите по-английски. Остановить — той же кнопкой или отпустив пробел; предел {formatSeconds(MAX_SECONDS)}.</span>}
      {processing && <span className="muted hint" style={{ margin: 0 }}>Whisper переводит речь в текст — до полуминуты. Текст можно будет поправить.</span>}
      {rec.error && <span className="error" role="alert">{rec.error}</span>}
    </div>
  );
}

type SpeakProps = { text: string; label?: string; className?: string };

/** Озвучка реплики тренера: первая кнопка просит MP3 у MeloTTS, дальше звук играется из памяти. */
export function SpeakButton({ text, label = 'Озвучить', className = 'link' }: SpeakProps) {
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle');
  const [error, setError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const cached = useRef<{ text: string; url: string } | null>(null);

  useEffect(() => () => { audio.current?.pause(); if (cached.current) URL.revokeObjectURL(cached.current.url); }, []);
  useEffect(() => { if (cached.current && cached.current.text !== text) { URL.revokeObjectURL(cached.current.url); cached.current = null; } audio.current?.pause(); setState('idle'); }, [text]);

  async function play() {
    if (state === 'playing') { audio.current?.pause(); setState('idle'); return; }
    if (state === 'loading') return;
    setError(null);
    try {
      if (!cached.current) {
        setState('loading');
        const blob = await api.speak(text);
        cached.current = { text, url: URL.createObjectURL(blob) };
      }
      const a = new Audio(cached.current.url);
      audio.current = a;
      a.onended = () => setState('idle');
      a.onerror = () => { setState('idle'); setError('Браузер не смог воспроизвести звук.'); };
      await a.play();
      setState('playing');
    } catch (e) { setState('idle'); setError(errorText(e)); }
  }

  if (typeof Audio === 'undefined') return null;
  return (
    <span className="speak">
      <button type="button" className={className} onClick={play} disabled={state === 'loading'} aria-pressed={state === 'playing'}>
        {state === 'loading' ? 'Озвучиваю…' : state === 'playing' ? 'Остановить' : label}
      </button>
      {error && <span className="error" role="alert" style={{ marginLeft: 8 }}>{error}</span>}
    </span>
  );
}
