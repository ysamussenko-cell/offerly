import { describe, it, expect } from 'vitest';
import { PROVIDERS, chat } from '../functions/_lib/providers';

describe('providers', () => {
  it('has a free default provider first', () => {
    expect(PROVIDERS[0].id).toBe('workers-ai');
    expect(PROVIDERS[0].free).toBe(true);
  });
  it('every external provider has url and key page', () => {
    for (const p of PROVIDERS.filter(p => p.id !== 'workers-ai')) {
      expect(p.url).toMatch(/^https:\/\//);
      expect(p.keyUrl).toMatch(/^https:\/\//);
    }
  });
  it('calls Workers AI binding and returns response text', async () => {
    const env: any = { AI: { run: async () => ({ response: 'Hello, engineer.' }) }, DB: null, APP_NAME: 'Offerly' };
    const text = await chat(env, [{ role: 'user', content: 'hi' }]);
    expect(text).toBe('Hello, engineer.');
  });
  it('refuses external provider without a key', async () => {
    const env: any = { AI: null, DB: null, APP_NAME: 'Offerly' };
    await expect(chat(env, [{ role: 'user', content: 'hi' }], { provider: 'groq' })).rejects.toThrow();
  });
});
