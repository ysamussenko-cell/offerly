import { describe, it, expect } from 'vitest';
import {
  pickMimeType, canRecord, mixToMono, resample, encodeWav, decodedToWav, formatSeconds, speechLine, fluencyTone, mergeTranscript, mediaErrorKey,
  VOICE_ERRORS, TARGET_RATE, MIME_PREFERENCE,
} from '../src/voice';
import { hotkeyHints, interpretKey } from '../src/hotkeys';

describe('запись на клиенте', () => {
  it('pickMimeType: первый поддерживаемый из списка предпочтений; ничего — пусто; бросающий isTypeSupported не роняет', () => {
    expect(pickMimeType(t => t === 'audio/mp4')).toBe('audio/mp4');
    expect(pickMimeType(() => true)).toBe(MIME_PREFERENCE[0]);
    expect(pickMimeType(() => false)).toBe('');
    expect(pickMimeType(t => { if (t.includes('webm')) throw new Error('x'); return t === 'audio/mp4'; })).toBe('audio/mp4');
  });
  it('canRecord: нужны getUserMedia и MediaRecorder', () => {
    expect(canRecord({ mediaDevices: { getUserMedia: () => {} } }, function () {})).toBe(true);
    expect(canRecord({ mediaDevices: {} }, function () {})).toBe(false);
    expect(canRecord({ mediaDevices: { getUserMedia: () => {} } }, undefined)).toBe(false);
    expect(canRecord(undefined, undefined)).toBe(false);
  });
  it('mixToMono: среднее каналов; один канал — как есть', () => {
    const a = new Float32Array([1, 0, -1]), b = new Float32Array([0, 1, -1]);
    expect(Array.from(mixToMono([a, b]))).toEqual([0.5, 0.5, -1]);
    expect(mixToMono([a])).toBe(a);
    expect(mixToMono([]).length).toBe(0);
  });
  it('resample: 48 кГц → 16 кГц втрое короче, значения интерполируются; та же частота — без копии', () => {
    const src = new Float32Array(48000).map((_, i) => Math.sin(i / 50));
    const out = resample(src, 48000, 16000);
    expect(out.length).toBe(16000);
    expect(out[0]).toBeCloseTo(src[0], 5);
    expect(out[100]).toBeCloseTo(src[300], 3);
    expect(resample(src, 48000, 48000)).toBe(src);
    expect(Array.from(resample(new Float32Array([0, 1]), 2, 4))).toEqual([0, 0.5, 1, 1]);
  });
  it('encodeWav: заголовок RIFF/WAVE, 16 бит моно, нужная частота, отсчёты в пределах', () => {
    const buf = encodeWav(new Float32Array([0, 0.5, -0.5, 2, -2]), TARGET_RATE);
    const v = new DataView(buf);
    const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    expect(buf.byteLength).toBe(44 + 10);
    expect(tag(0)).toBe('RIFF'); expect(tag(8)).toBe('WAVE'); expect(tag(12)).toBe('fmt '); expect(tag(36)).toBe('data');
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(10);
    expect(v.getInt16(44, true)).toBe(0);
    expect(v.getInt16(46, true)).toBe(Math.trunc(0.5 * 0x7fff));
    expect(v.getInt16(48, true)).toBe(-0x4000);
    expect(v.getInt16(50, true)).toBe(0x7fff);
    expect(v.getInt16(52, true)).toBe(-0x8000);
  });
  it('decodedToWav: стерео 44,1 кГц → WAV 16 кГц моно', () => {
    const n = 44100;
    const l = new Float32Array(n).fill(0.2), r = new Float32Array(n).fill(0.4);
    const decoded = { sampleRate: 44100, numberOfChannels: 2, getChannelData: (i: number) => (i === 0 ? l : r) };
    const buf = decodedToWav(decoded);
    const v = new DataView(buf);
    expect(v.getUint32(24, true)).toBe(TARGET_RATE);
    expect(v.getUint32(40, true)).toBe(16000 * 2);
    expect(v.getInt16(44, true)).toBe(Math.trunc(0.3 * 0x7fff));
  });
  it('formatSeconds, speechLine, fluencyTone, mergeTranscript', () => {
    expect(formatSeconds(7)).toBe('0:07');
    expect(formatSeconds(72.9)).toBe('1:12');
    expect(formatSeconds(-1)).toBe('0:00');
    const line = speechLine({ words: 60, duration: 35, wpm: 103, pauses: 2, longestPause: 2.4, fillers: 1, fluency: 48 });
    expect(line).toBe('темп 103 слов/мин · 0:35 записи · пауз 2 (до 2,4 с) · заполнителей 1 · беглость 48');
    expect(speechLine({ words: 60, duration: 30, wpm: 120, pauses: 0, longestPause: 0.8, fillers: 0, fluency: 61 })).toBe('темп 120 слов/мин · 0:30 записи · пауз 0 · беглость 61');
    expect(fluencyTone(61)).toBe('ok'); expect(fluencyTone(30)).toBe('warn'); expect(fluencyTone(10)).toBe('bad');
    expect(mergeTranscript('', '  Hello there. ')).toBe('Hello there.');
    expect(mergeTranscript('First part.', 'Second part.')).toBe('First part. Second part.');
  });
  it('mediaErrorKey: отказ в доступе, нет устройства, занят, прочее', () => {
    expect(mediaErrorKey({ name: 'NotAllowedError' })).toBe('denied');
    expect(mediaErrorKey({ name: 'NotFoundError' })).toBe('nodevice');
    expect(mediaErrorKey({ name: 'NotReadableError' })).toBe('busy');
    expect(mediaErrorKey(new Error('x'))).toBe('unsupported');
    expect(mediaErrorKey(null)).toBe('unsupported');
    for (const k of ['unsupported', 'denied', 'nodevice', 'busy', 'decode']) expect(VOICE_ERRORS[k]).toMatch(/\.$/);
  });
  it('горячие клавиши: с recordable пробел вне поля начинает запись, keyup — останавливает; подсказка показывает пробел', () => {
    const ctx = { submit: true, cancel: true, recordable: true };
    expect(interpretKey({ type: 'keydown', key: ' ' }, ctx)).toEqual({ type: 'record-start' });
    expect(interpretKey({ type: 'keydown', key: ' ', targetTag: 'TEXTAREA' }, ctx)).toBeNull();
    expect(interpretKey({ type: 'keyup', key: ' ' }, ctx)).toEqual({ type: 'record-stop' });
    expect(interpretKey({ type: 'keydown', key: ' ' }, { ...ctx, recordable: false })).toBeNull();
    expect(hotkeyHints(ctx, { textEntry: true }).map(h => h.label)).toEqual(['отправить', 'удерживать — запись голоса', 'отмена']);
  });
});
