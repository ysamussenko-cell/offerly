/** Голос на клиенте — чистые функции без DOM, чтобы их можно было проверить тестами.
 *  Запись идёт через MediaRecorder в том формате, который умеет браузер (WebM/Opus в Chrome и Firefox, MP4/AAC
 *  в Safari), затем перекодируется в WAV 16 кГц моно 16 бит через AudioContext.decodeAudioData — Whisper на Workers AI
 *  принимает его без оговорок, а размер предсказуем (32 КБ/с). Если перекодировать не удалось, запись уходит как есть.
 *  Мерки речи считает сервер (functions/_lib/voice.ts); здесь — только их подпись для экрана. */

/** Частота WAV для распознавания. */
export const TARGET_RATE = 16000;
/** Предел записи, секунд (как MAX_SECONDS на сервере). */
export const MAX_SECONDS = 120;
/** Порядок предпочтения форматов MediaRecorder. */
export const MIME_PREFERENCE = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/mpeg', 'audio/wav'];

export type SpeechMetrics = { words: number; duration: number; wpm: number; pauses: number; longestPause: number; fillers: number; fluency: number };

/** Какой формат отдать MediaRecorder; '' — пусть браузер выберет сам. */
export function pickMimeType(isSupported: (type: string) => boolean): string {
  for (const t of MIME_PREFERENCE) { try { if (isSupported(t)) return t; } catch { /* старые браузеры бросают на незнакомом типе */ } }
  return '';
}

/** Можно ли писать голос в этом окружении: нужен getUserMedia и MediaRecorder (в тестах — подставные объекты). */
export function canRecord(nav: { mediaDevices?: { getUserMedia?: unknown } } | undefined = typeof navigator !== 'undefined' ? navigator : undefined, Recorder: unknown = typeof MediaRecorder !== 'undefined' ? MediaRecorder : undefined): boolean {
  return Boolean(nav?.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function' && typeof Recorder === 'function');
}

/** Несколько каналов → один (среднее). */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (const ch of channels) s += ch[i] ?? 0; out[i] = s / channels.length; }
  return out;
}

/** Передискретизация линейной интерполяцией: достаточно для речи, идущей в распознавание. */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to || samples.length === 0) return samples;
  const ratio = from / to;
  const n = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos), i1 = Math.min(samples.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

/** WAV PCM 16 бит моно из отсчётов −1…1. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/** Минимальный интерфейс декодированного звука — AudioBuffer без DOM. */
export type DecodedAudio = { sampleRate: number; numberOfChannels: number; getChannelData(i: number): Float32Array };

/** Декодированная запись → WAV 16 кГц моно. */
export function decodedToWav(a: DecodedAudio, rate = TARGET_RATE): ArrayBuffer {
  const channels: Float32Array[] = [];
  for (let i = 0; i < a.numberOfChannels; i++) channels.push(a.getChannelData(i));
  return encodeWav(resample(mixToMono(channels), a.sampleRate, rate), rate);
}

/** «0:07», «1:12». */
export function formatSeconds(n: number): string {
  const s = Math.max(0, Math.floor(n));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Подпись мерок речи одной строкой: темп, паузы, заполнители, беглость. */
export function speechLine(m: SpeechMetrics): string {
  const parts = [`темп ${m.wpm} слов/мин`, `${formatSeconds(m.duration)} записи`, `пауз ${m.pauses}${m.longestPause >= 2 ? ` (до ${m.longestPause.toFixed(1).replace('.', ',')} с)` : ''}`];
  if (m.fillers > 0) parts.push(`заполнителей ${m.fillers}`);
  parts.push(`беглость ${m.fluency}`);
  return parts.join(' · ');
}

/** Тон подписи по беглости: мята от 50, янтарь от 25, иначе коралл. */
export function fluencyTone(f: number): 'ok' | 'warn' | 'bad' {
  return f >= 50 ? 'ok' : f >= 25 ? 'warn' : 'bad';
}

/** Подставить расшифровку в поле: пустое — заменить, иначе дописать через пробел. */
export function mergeTranscript(current: string, transcript: string): string {
  const t = transcript.trim();
  const c = current.trim();
  return c ? `${c} ${t}` : t;
}

/** Тексты отказов записи на клиенте — одной строкой; ответы сервера (audio_*, stt_failed, tts_failed) — в ERRORS api.ts. */
export const VOICE_ERRORS: Record<string, string> = {
  unsupported: 'Запись голоса в этом браузере недоступна. Ответьте текстом или откройте приложение в Chrome, Safari или Firefox.',
  denied: 'Микрофон не разрешён. Разрешите доступ в адресной строке браузера и нажмите снова.',
  nodevice: 'Микрофон не найден. Подключите его или ответьте текстом.',
  busy: 'Микрофон занят другим приложением.',
  decode: 'Запись не удалось обработать. Попробуйте ещё раз.',
};

/** Код ошибки getUserMedia → ключ VOICE_ERRORS. */
export function mediaErrorKey(e: unknown): keyof typeof VOICE_ERRORS {
  const name = (e as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'nodevice';
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') return 'busy';
  return 'unsupported';
}
