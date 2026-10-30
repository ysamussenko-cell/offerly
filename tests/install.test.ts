import { describe, it, expect } from 'vitest';
import { manualHint } from '../src/install';

describe('подсказка по ручной установке PWA', () => {
  it('различает iOS, Safari на Mac, Firefox и остальных', () => {
    expect(manualHint('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toContain('Домой');
    expect(manualHint('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15')).toContain('Dock');
    expect(manualHint('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0')).toContain('Chrome или Edge');
    expect(manualHint('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')).toContain('Установить Offerly');
  });
});
