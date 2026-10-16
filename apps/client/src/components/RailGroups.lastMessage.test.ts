import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as railRules from '../railRules';
import * as configRules from '../configRules';
import * as inviteRules from '../inviteCheckRules';
import * as serverRules from '../serverRowRules';
import * as dmRules from '../dmRowRules';
import * as groupRules from '../groupChatRules';

const source = readFileSync(new URL('./RailGroups.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const createdAt = '2026-01-02T12:34:00.000Z';
type Options = { closed?: boolean; last?: 'missing' | 'null' | 'other' | 'self'; unread?: number; mentions?: number };
async function scene(options: Options, check: (row: HTMLButtonElement) => void, raw = source) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const last = options.last ?? 'other';
  const server = { id: 's', name: 'Сервер', ownerId: 'owner', createdAt,
    ...(last === 'missing' ? {} : { lastMessage: last === 'null' ? null : {
      id: 'm', authorId: last === 'self' ? 'me' : 'other', authorName: 'Автор', text: 'Последняя реплика',
      attachments: 0, createdAt, channelId: 'ch', channelName: 'Общий',
    } }),
  };
  const state = { servers: [server], currentServerId: null, view: 'dm', closedServers: options.closed ? { s: true } : {},
    unreadServers: { s: options.unread ?? 5 }, mentionServers: { s: options.mentions ?? 1 }, pushMutedServers: [], user: { id: 'me' }, switching: false };
  const unavailable = () => { throw new Error('побочный эффект вне rows fixture'); };
  const deps: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx,
    '../api': { api: { fedMyGuest: unavailable } },
    '../bgGateways': { bgUnread: () => ({}), onBgUnread: () => () => {} },
    '../config': { activeInstanceId: () => 'home', instances: () => [{ id: 'home', name: 'Дом', apiUrl: 'http://localhost', presenceWs: 'ws://localhost', token: null, order: 0 }] },
    '../federationClient': { useFederationEnabled: () => false },
    '../guestJoin': { ensureGuestSession: unavailable, GuestJoinError: class extends Error {}, openInstance: unavailable },
    '../inviteCheckRules': inviteRules, '../railRules': railRules, '../configRules': configRules,
    '../pendingOpen': { setPendingOpen: unavailable }, '../store': { useStore: (pick: (s: typeof state) => unknown) => pick(state) },
    '../toast': { toast: unavailable, toastError: unavailable },
    './Avatar': { Avatar: ({ name, size }: { name: string; size: number }) => React.createElement('span', { 'data-avatar': name, 'data-size': size }) },
    './Icon': { Icon: ({ name }: { name: string }) => React.createElement('i', { 'data-icon': name }) },
    '../serverRowRules': serverRules, '../dmRowRules': dmRules, '../groupChatRules': groupRules,
  };
  const module = { exports: {} as typeof import('./RailGroups') };
  try {
    runInNewContext(ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
      { module, exports: module.exports, require: (id: string) => { if (!Object.hasOwn(deps, id)) throw new Error(`неописанный импорт ${id}`); return deps[id]; } });
    await React.act(async () => root.render(React.createElement(module.exports.RailGroups, { rows: true, onOpenLive: unavailable, onMenu: unavailable })));
    assert.equal(host.querySelectorAll('.srv-row').length, 1);
    check(host.querySelector('.srv-row') as HTMLButtonElement);
  } finally {
    try { await React.act(async () => root.unmount()); } finally {
      host.remove(); await GlobalRegistrator.unregister();
      if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous); else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    }
  }
}
const text = (row: Element, selector: string) => row.querySelector(selector)?.textContent ?? null;
function preview(row: HTMLButtonElement, own = false) {
  assert.equal(text(row, '.dm-from'), own ? 'Вы: ' : 'Автор: ', 'автор превью');
  assert.equal(text(row, '.dm-preview'), `${own ? 'Вы' : 'Автор'}: Последняя реплика`);
  assert.equal(row.querySelector('.dm-time')?.getAttribute('datetime'), createdAt);
  assert.equal(text(row, '.dm-when'), dmRules.dmRowTime(createdAt)!.label);
  assert.equal(row.classList.contains('srv-solo'), false);
}
function closed(row: HTMLButtonElement) {
  assert.equal(text(row, '.dm-preview'), 'Закрыт держателем', 'закрытый сервер не раскрывает реплику');
  assert.equal(!!row.querySelector('.dm-from'), false);
  assert.equal(!!row.querySelector('.dm-when'), false);
  assert.equal(!!row.querySelector('.dm-badge'), false);
  assert.equal(!!row.querySelector('[data-icon="at"]'), false);
  assert.equal(row.textContent!.includes('Последняя реплика'), false);
  assert.equal(row.classList.contains('rail-closed'), true);
}
it('R180 открытая строка показывает чужого автора, текст и время последнего сообщения', async () => {
  // Класс ошибки: потерянная связь полей последнего сообщения с DOM.
  await scene({}, row => preview(row));
});
it('R180 своё сообщение подписано Вы, а чужое сохраняет имя автора', async () => {
  // Класс ошибки: неверная идентификация автора.
  for (const own of [false, true]) await scene({ last: own ? 'self' : 'other' }, row => preview(row, own));
});
it('R180 ноль и одно упоминание переключают знак @ без изменения общего непрочитанного', async () => {
  // Класс ошибки: счётчик упоминаний подменяет общее число либо @ появляется при нуле.
  for (const mentions of [0, 1]) await scene({ mentions }, row => {
    preview(row); assert.equal(!!row.querySelector('[data-icon="at"]'), mentions > 0);
    assert.equal(text(row, '.dm-badge'), '5');
  });
});
it('R180 закрытая строка скрывает последнее сообщение даже при наличии автора и счётчиков', async () => {
  // Класс ошибки: раскрытие сообщения закрытого сервера.
  for (const last of ['other', 'self', 'missing', 'null'] as const) await scene({ closed: true, last }, closed);
});
it('R180 отсутствующее и null сообщение оставляют прежнюю подпись и приоритет упоминаний', async () => {
  // Класс ошибки: несовместимость старого ответа сервера и прежних счётчиков.
  for (const last of ['missing', 'null'] as const) for (const mentions of [0, 1]) await scene({ last, mentions }, row => {
    assert.equal(text(row, '.dm-preview'), mentions ? 'Упоминаний: 1 · Новых сообщений: 4' : 'Новых сообщений: 5');
    assert.equal(text(row, '.dm-badge'), mentions ? '1' : '5');
    assert.equal(!!row.querySelector('.dm-when'), false); assert.equal(!!row.querySelector('.dm-from'), false);
    assert.equal(!!row.querySelector('[data-icon="at"]'), false);
    assert.equal(row.querySelector('.dm-badge')?.classList.contains('muted'), !mentions);
  });
});
it('R180 пустая строка без сообщения центрирует имя, но сообщение при нулевых счётчиках остаётся', async () => {
  // Класс ошибки: исчезновение превью из-за отсутствия непрочитанного.
  for (const last of ['missing', 'null', 'other'] as const) await scene({ last, unread: 0, mentions: 0 }, row => {
    assert.equal(!!row.querySelector('.dm-badge'), false);
    if (last === 'other') preview(row); else {
      assert.equal(text(row, '.dm-preview'), null); assert.equal(row.classList.contains('srv-solo'), true);
    }
  });
});
it('R180 контрфакт раскрытия закрытого сообщения отвергается приватностью строки', async () => {
  // Класс ошибки: мутант обхода закрытого членства.
  await scene({ closed: true }, closed);
  const anchor = 'const last = !s.closed ? (full?.lastMessage ?? null) : null;'; assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(scene({ closed: true }, closed, source.replace(anchor, 'const last = full?.lastMessage ?? null;')),
    e => e instanceof assert.AssertionError && e.message.includes('закрытый сервер не раскрывает'));
});
it('R180 контрфакт потери собственного автора отвергается подписью Вы', async () => {
  // Класс ошибки: мутант идентификации собственного сообщения.
  const check = (row: HTMLButtonElement) => preview(row, true); await scene({ last: 'self' }, check);
  const anchor = 'groupPreviewAuthor(last, meId)'; assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(scene({ last: 'self' }, check, source.replace(anchor, 'groupPreviewAuthor(last, undefined)')),
    e => e instanceof assert.AssertionError && e.message.includes('автор превью'));
});
it('R180 контрфакт знака @ при нуле упоминаний отвергается DOM строки', async () => {
  // Класс ошибки: мутант границы положительного счётчика.
  const check = (row: HTMLButtonElement) => assert.equal(!!row.querySelector('[data-icon="at"]'), false, 'ноль без знака @');
  await scene({ mentions: 0 }, check);
  const anchor = 'const atMark = !!last && !s.closed && s.mentions > 0;'; assert.equal(source.split(anchor).length - 1, 1);
  await assert.rejects(scene({ mentions: 0 }, check, source.replace(anchor, 'const atMark = !!last && !s.closed && s.mentions >= 0;')),
    e => e instanceof assert.AssertionError && e.message.includes('ноль без знака'));
});
