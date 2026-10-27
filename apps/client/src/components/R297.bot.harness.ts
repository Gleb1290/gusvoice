import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as shared from '@gusvoice/shared';
import { React, load, sourceOf, reactProps } from './R171.phoneHarness';

export { React, load, sourceOf, reactProps };
export { environment, mutate } from './R171.phoneHarness';
export const readClient = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
export const bot: shared.BotInfo = { id: 'test-bot', username: 'test_bot', displayName: 'Бот 1', avatarUrl: null,
  description: 'Описание бота', about: 'Помощник', public: false, createdAt: '2026-01-01T00:00:00Z',
  tokenCreatedAt: '2026-01-01T00:00:00Z', disabledAt: null, webhook: null };
export const tick = async () => { await React.act(async () => { await new Promise<void>(resolve => setImmediate(resolve)); }); };
export async function click(button: HTMLButtonElement) { await React.act(async () => { button.click(); }); await tick(); }
export function button(host: ParentNode, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].filter(b => b.textContent?.trim() === label);
  assert.equal(found.length, 1, `кнопка «${label}» единственная`); return found[0];
}
export async function input(field: HTMLInputElement, value: string) {
  await React.act(async () => { reactProps(field).onChange({ target: { value } }); });
}
export function uiDependencies(store: unknown) {
  const back = load<typeof import('../androidBack')>(readClient('../androidBack.ts'), {
    './hotkeys': { isAndroid: () => false }, './store': { useStore: store },
  }, { HTMLElement, Element, KeyboardEvent, setTimeout, clearTimeout });
  const chrome = load<typeof import('../dialogChrome')>(readClient('../dialogChrome.ts'), { './androidBack': back }, { setTimeout, clearTimeout });
  const icons = load<typeof import('./Icon')>(sourceOf('Icon'), {});
  const lite = load<typeof import('../liteMode')>(readClient('../liteMode.ts'), {});
  const avatar = load<typeof import('./Avatar')>(sourceOf('Avatar'), { '../liteMode': lite,
    '../windowCovered': { useWindowMotion: () => ({ covered: false, gameFg: false }) },
    '../firstFrame': { useFirstFrame: () => null } });
  const toggle = load<typeof import('./Toggle')>(sourceOf('Toggle'), {});
  return { '@gusvoice/shared': shared, '../androidBack': back, '../dialogChrome': chrome, './Icon': icons,
    './Avatar': avatar, './Toggle': toggle, '../store': { useStore: store } };
}
export function assertion(message: string, actual: unknown, expected: unknown) {
  return (error: unknown) => error instanceof assert.AssertionError && error.code === 'ERR_ASSERTION'
    && error.message.split(/\r?\n/)[0] === message && error.operator === 'strictEqual'
    && error.actual === actual && error.expected === expected;
}
