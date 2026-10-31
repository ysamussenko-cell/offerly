import { describe, it, expect } from 'vitest';
import {
  screenFor, platformOf, browserOf, canPromptInstall, installSteps, releaseLine, windowsUnavailableText, INSTALL_PATH, PLATFORM_LABEL,
} from '../src/installPage';

const UA = {
  winChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0',
  winFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0 Mobile Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
};

describe('страница установки: путь', () => {
  it('/install и варианты со слешем и регистром — страница установки, остальное — приложение', () => {
    expect(INSTALL_PATH).toBe('/install');
    expect(screenFor('/install')).toBe('install');
    expect(screenFor('/install/')).toBe('install');
    expect(screenFor('/Install')).toBe('install');
    expect(screenFor('/')).toBe('app');
    expect(screenFor('')).toBe('app');
    expect(screenFor('/installer')).toBe('app');
    expect(screenFor('/api/health')).toBe('app');
  });
});

describe('страница установки: платформа и браузер', () => {
  it('различает Windows, Mac, iPhone, Android, Linux; iPad в Safari под видом Mac выдаёт сенсорный экран', () => {
    expect(platformOf(UA.winChrome)).toBe('windows');
    expect(platformOf(UA.macSafari)).toBe('mac');
    expect(platformOf(UA.macSafari, 5)).toBe('ios');
    expect(platformOf(UA.iphone)).toBe('ios');
    expect(platformOf(UA.android)).toBe('android');
    expect(platformOf(UA.linux)).toBe('linux');
    expect(platformOf('curl/8.0')).toBe('other');
    expect(PLATFORM_LABEL.ios).toBe('iPhone и iPad');
  });
  it('браузер: Edge и Samsung раньше Chrome, Chrome раньше Safari, Firefox на iOS — Firefox', () => {
    expect(browserOf(UA.winEdge)).toBe('edge');
    expect(browserOf(UA.samsung)).toBe('samsung');
    expect(browserOf(UA.winChrome)).toBe('chrome');
    expect(browserOf(UA.iphoneChrome)).toBe('chrome');
    expect(browserOf(UA.macSafari)).toBe('safari');
    expect(browserOf(UA.winFirefox)).toBe('firefox');
    expect(browserOf('curl/8.0')).toBe('other');
  });
  it('кнопка установки возможна только в Chrome, Edge и Samsung не на iOS', () => {
    expect(canPromptInstall('windows', 'chrome')).toBe(true);
    expect(canPromptInstall('android', 'samsung')).toBe(true);
    expect(canPromptInstall('mac', 'safari')).toBe(false);
    expect(canPromptInstall('windows', 'firefox')).toBe(false);
    expect(canPromptInstall('ios', 'chrome')).toBe(false);
  });
});

describe('страница установки: шаги', () => {
  it('iPhone: Safari — «Поделиться» → «На экран „Домой“»; другой браузер — отправить в Safari', () => {
    const safari = installSteps('ios', 'safari');
    expect(safari).toHaveLength(3);
    expect(safari.join(' ')).toContain('Домой');
    expect(installSteps('ios', 'chrome')[0]).toContain('Safari');
  });
  it('Android: с кнопкой — нажать её, без кнопки — меню Chrome; Firefox — своё меню', () => {
    expect(installSteps('android', 'chrome', true)[0]).toContain('Установить приложение');
    expect(installSteps('android', 'chrome')[0]).not.toContain('выше');
    expect(installSteps('android', 'chrome').join(' ')).toContain('Добавить на главный экран');
    expect(installSteps('android', 'firefox').join(' ')).toContain('Firefox');
  });
  it('компьютер: Chrome/Edge — кнопка или значок в адресной строке; Firefox — в Chrome или Edge; Safari на Mac — в Dock', () => {
    expect(installSteps('windows', 'chrome', true)[0]).toContain('«Установить приложение» выше');
    expect(installSteps('windows', 'chrome')[0]).toContain('адресной строке');
    expect(installSteps('windows', 'chrome').join(' ')).not.toContain('выше');
    expect(installSteps('windows', 'firefox')[0]).toContain('Chrome или Edge');
    expect(installSteps('mac', 'safari')[0]).toContain('Dock');
    expect(installSteps('linux', 'chrome')).toEqual(installSteps('windows', 'chrome'));
  });
});

describe('страница установки: установщик Windows', () => {
  it('строка релиза с датой по-русски и без даты', () => {
    expect(releaseLine({ ok: true, available: true, version: '0.23.0', publishedAt: '2026-11-03T06:30:00.000Z', notes: null, windows: { url: 'https://x/a.exe', name: 'a.exe', signed: true }, releasesUrl: 'https://x' })).toBe('Версия 0.23.0 · 3 ноября 2026 г.');
    expect(releaseLine({ ok: true, available: true, version: '0.23.0', publishedAt: null, notes: null, windows: { url: 'https://x/a.exe', name: 'a.exe', signed: true }, releasesUrl: 'https://x' })).toBe('Версия 0.23.0');
  });
  it('тексты без установщика: готовится / релиз без Windows / не удалось проверить', () => {
    expect(windowsUnavailableText({ ok: true, available: false, reason: 'none', detail: null, releasesUrl: 'https://x' })).toContain('готовится');
    expect(windowsUnavailableText({ ok: true, available: false, reason: 'no_windows', detail: 'версия 0.5.0 без сборки для Windows', releasesUrl: 'https://x' })).toContain('0.5.0');
    expect(windowsUnavailableText({ ok: true, available: false, reason: 'error', detail: 'HTTP 500', releasesUrl: 'https://x' })).toContain('HTTP 500');
  });
});
