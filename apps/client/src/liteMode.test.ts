import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const saved = new Map<string, string>();
const classes = new Set<string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value); },
  },
});
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { documentElement: { classList: { toggle: (name: string, on: boolean) => on ? classes.add(name) : classes.delete(name) } } },
});

const { applyLiteMode, avatarShowsStill, liteModeDefault, liteModeEnabled, setLiteModeEnabled } = await import('./liteMode.js');

describe('оптимизированный режим', () => {
  it('по умолчанию выключен и синхронно пишет хранилище с классом документа', () => {
    // Ловит режим, который сам включился у всех, и расхождение состояния с CSS.
    assert.equal(liteModeDefault(), false);
    assert.equal(liteModeEnabled(), false);
    setLiteModeEnabled(true);
    assert.equal(saved.get('gv_lite_mode'), '1');
    assert.equal(classes.has('gv-lite'), true);
    setLiteModeEnabled(false);
    assert.equal(saved.get('gv_lite_mode'), '0');
    assert.equal(classes.has('gv-lite'), false);
  });

  it('ошибка хранилища не мешает применить режим к документу', () => {
    // Ловит падение настройки в приватном режиме браузера.
    const storage = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } } });
    assert.doesNotThrow(() => setLiteModeEnabled(true));
    assert.equal(classes.has('gv-lite'), true);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
    setLiteModeEnabled(false);
    applyLiteMode();
  });

  it('аватар замирает только по полной матрице видимости и наведения', () => {
    // Ловит декодирование GIF под игрой и, с другой стороны, неподвижный обычный аватар без причины.
    const base = { hasAnimation: true, covered: false, gameFg: false, lite: false, hover: false };
    assert.equal(avatarShowsStill({ ...base, hasAnimation: false, covered: true, lite: true }), false);
    assert.equal(avatarShowsStill({ ...base, covered: true }), true);
    assert.equal(avatarShowsStill(base), false);
    assert.equal(avatarShowsStill({ ...base, lite: true }), true);
    assert.equal(avatarShowsStill({ ...base, lite: true, hover: true }), false);
    assert.equal(avatarShowsStill({ ...base, lite: true, hover: true, gameFg: true }), true);
  });
});
