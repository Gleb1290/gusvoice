import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import type { ServerMemberInfo } from '@gusvoice/shared';
import { has, Permission, permsFromString } from '@gusvoice/shared';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import * as status from '../status';
import * as memberRoles from '../memberRoles';
import * as audioRules from '../userAudioRules';
import * as dmRules from '../dmRules';
import * as callView from '../callView';
import * as contactRules from '../contactRules';

const sources = {
  menu: readFileSync(new URL('./UserContextMenu.tsx', import.meta.url), 'utf8'),
  sheet: readFileSync(new URL('./MemberProfileSheet.tsx', import.meta.url), 'utf8'),
};
type Surface = keyof typeof sources;
type AudioState = { volume: number; muted: boolean };
const selectors = {
  menu: { head: '.ctx-vol2-head', icon: '.ctx-vol2-spk [data-icon]', pct: '.ctx-vol2-pct' },
  sheet: { head: '.mps-vol-head', icon: '.mps-vol-spk [data-icon]', pct: '.mps-vol-pct' },
};
const member: ServerMemberInfo = {
  user: { id: 'peer', username: 'peer', displayName: 'Собеседник', avatarUrl: null,
    animatedAvatarUrl: null, status: 'online', customStatus: null },
  nickname: null, roleIds: [], joinedAt: '2026-10-12T00:00:00Z',
};
const unavailable = () => assert.fail('I/O или действие вне контракта значка громкости');
const empty = () => null;
const wrap = ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children);

type Fixture = {
  render(audio: AudioState, self?: boolean): Promise<void>;
  icon(): string | null;
  pct(): string | null;
  hasHeader(): boolean;
};
async function fixture(surface: Surface, check: (f: Fixture) => Promise<void>, raw = sources[surface]) {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  const previousAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let audio: AudioState = { volume: 1, muted: false };
  let state = {
    user: { id: 'local', username: 'local', displayName: 'Я' }, bootstrap: null,
    members: [member], onlineUsers: [], userStatuses: {}, presence: {}, serverFeatures: [],
    convActive: false, blockedUsers: [], view: 'server', dmOnlineUsers: [], dmAwayUsers: [],
    pushMutedDmUsers: [], economy: {}, loadMembers: unavailable, applyMemberNickname: unavailable,
    openDmWith: unavailable, requestMention: unavailable, setSettingsOpen: unavailable, setPushMuted: unavailable,
  };
  const audioBoundary = {
    MAX_VOLUME: 2,
    useUserAudio(id: string) {
      assert.equal(id, member.user.id, 'оба регулятора читают громкость адресата, а не локального пользователя');
      return { ...audio, setVolume: unavailable, setMuted: unavailable, toggleMuted: unavailable, reset: unavailable };
    },
  };
  function load<T>(source: string, deps: Record<string, unknown>, filename: string): T {
    const module = { exports: {} };
    // Исполняется весь исходный модуль: выбор значка и вычисление volPct не копируются в тест.
    runInNewContext(ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    }, fileName: filename }).outputText, {
      module, exports: module.exports,
      require(id: string) {
        assert.equal(Object.hasOwn(deps, id), true, `явная граница импорта ${id}`);
        return deps[id];
      },
    }, { timeout: 1000, filename });
    return module.exports as T;
  }
  try {
    // Стор/аудио, онлайн-хуки и соседние визуальные блоки — границы. Чистые правила настоящие.
    // Icon сохраняет переданное имя в DOM; ContextMenu/BottomSheet только пропускают children.
    const common: Record<string, unknown> = {
      react: React, 'react/jsx-runtime': jsx,
      '../store': { useStore: <T,>(select: (s: typeof state) => T) => select(state) },
      '../localUserAudio': audioBoundary, '../status': status, '../dmRules': dmRules,
      '../toast': { toastError: unavailable, toast: unavailable },
      './Avatar': { Avatar: empty }, './AvatarZoom': { AvatarZoom: wrap },
      './GuestMark': { GuestLine: empty, useGuestHome: () => () => null, guestHomeLabel: unavailable },
      './Icon': { Icon: ({ name }: { name: string }) => React.createElement('span', { 'data-icon': name }) },
      './ProfileEconomy': { ProfileEconomy: empty }, './StatusDot': { StatusDot: empty },
      '../avatarAnimation': { useAnimatedAvatarUrl: () => () => null, useAnimatedAvatarsEnabled: () => false },
    };
    const menu = load<typeof import('./UserContextMenu')>(surface === 'menu' ? raw : sources.menu, {
      ...common, '@gusvoice/shared': { has, Permission, permsFromString },
      '../callStore': { explainCallPrivacy: unavailable, useCall: { getState: unavailable } },
      '../callView': callView,
      'livekit-client': { ConnectionQuality: { Excellent: 'excellent', Good: 'good', Poor: 'poor', Lost: 'lost' } },
      '../api': { api: {} }, '../reportEvidence': { clearEvidence: unavailable, useEvidence: () => [] },
      './ContextMenu': { ContextMenu: wrap, MenuDivider: empty, MenuHeader: empty, MenuItem: empty, MenuSection: wrap },
      './PokeModal': { PokeComposer: empty }, './SharedMedia': { SharedMediaRows: empty, SharedMediaPanel: empty },
      '../confirm': { confirmAction: unavailable }, '../useLastSeen': { useLastSeen: () => null },
      '../dmOnline': { dotShown: (online: boolean) => online, serverHidesOnline: () => false,
        serverPresence4: () => false, useLocalOnline: () => false },
      '../lastSeenText': { lastSeenLabel: unavailable }, '../contactRules': contactRules,
      '../contacts': { useContactList: () => null, useContacts: { getState: unavailable } },
      './ContactEditModal': { removeContactAsk: unavailable }, '../userAudioRules': audioRules,
    }, 'UserContextMenu.tsx');
    const sheet = surface === 'sheet' ? load<typeof import('./MemberProfileSheet')>(raw, {
      ...common, './BottomSheet': { BottomSheet: wrap }, '../memberRoles': memberRoles,
      // Не дублируем цветовые helpers: лист получает их из настоящего целого модуля меню.
      './UserContextMenu': menu,
    }, 'MemberProfileSheet.tsx') : null;
    await check({
      async render(next, self = false) {
        audio = next;
        state = { ...state, user: { ...state.user, id: self ? member.user.id : 'local' } };
        await React.act(async () => {
          root.render(surface === 'menu'
            ? React.createElement(menu.UserContextMenu, {
              target: { userId: member.user.id, name: member.user.displayName, voiceChannelId: 'voice' },
              pos: { x: 12, y: 18 }, onClose() {},
            })
            : React.createElement(sheet!.MemberProfileSheet, { member, onClose() {} }));
        });
      },
      icon: () => host.querySelector(selectors[surface].icon)?.getAttribute('data-icon') ?? null,
      pct: () => host.querySelector(selectors[surface].pct)?.textContent ?? null,
      hasHeader: () => host.querySelector(selectors[surface].head) !== null,
    });
  } finally {
    try { await React.act(async () => root.unmount()); }
    finally {
      host.remove(); await GlobalRegistrator.unregister();
      if (previousAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousAct);
      else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    }
  }
}

async function zeroIsSilent(surface: Surface, raw = sources[surface]) {
  await fixture(surface, async f => {
    await f.render({ volume: 0, muted: false });
    assert.equal(f.hasHeader(), true, 'проверяем существующую шапку громкости');
    assert.equal(f.pct(), '0%', 'ноль не превращён в состояние локального mute');
    assert.equal(f.icon(), 'volume-off', '0% без mute перечёркивает значок шапки');
    await f.render({ volume: 0.5, muted: false });
    assert.equal(f.pct(), '50%');
    assert.equal(f.icon(), 'volume', 'ненулевая незаглушённая громкость возвращает обычный значок');
  }, raw);
}

for (const surface of ['menu', 'sheet'] as const) {
  const label = surface === 'menu' ? 'меню человека' : 'лист профиля';
  it(`R168 ${label}: 0% без mute перечёркивает значок, а 50% возвращает обычный`, async () => zeroIsSilent(surface));

  it(`R168 ${label}: mute перечёркивает значок независимо от сохранённой громкости`, async () => {
    await fixture(surface, async f => {
      for (const volume of [0, 0.5, 2]) {
        await f.render({ volume, muted: true });
        assert.equal(f.icon(), 'volume-off', `mute при сохранённой громкости ${volume}`);
        assert.equal(f.pct(), 'выкл');
      }
      await f.render({ volume: 0.5, muted: false });
      assert.equal(f.icon(), 'volume', 'отключение mute не оставляет ложное перечёркивание');
      assert.equal(f.pct(), '50%');
    });
  });

  it(`R168 ${label}: граница округления 0%/1% совпадает с подписью шапки`, async () => {
    await fixture(surface, async f => {
      // Условие относится к отображаемым процентам, не к сырым audio.volume === 0.
      await f.render({ volume: 0.0049, muted: false });
      assert.equal(f.pct(), '0%'); assert.equal(f.icon(), 'volume-off');
      await f.render({ volume: 0.005, muted: false });
      assert.equal(f.pct(), '1%'); assert.equal(f.icon(), 'volume');
      await f.render({ volume: 0.01, muted: false });
      assert.equal(f.pct(), '1%'); assert.equal(f.icon(), 'volume');
    });
  });

  it(`R168 ${label}: чужая шапка есть, самому себе громкость не предлагается даже при 0%`, async () => {
    await fixture(surface, async f => {
      await f.render({ volume: 0, muted: false });
      assert.equal(f.hasHeader(), true); assert.equal(f.icon(), 'volume-off');
      await f.render({ volume: 0, muted: false }, true);
      assert.equal(f.hasHeader(), false); assert.equal(f.icon(), null);
    });
  });

  it(`R168 ${label}: мутант только по mute пропускает неверный значок при 0%`, async () => {
    await zeroIsSilent(surface);
    const anchor = "audio.muted || volPct === 0 ? 'volume-off' : 'volume'";
    assert.equal(sources[surface].split(anchor).length - 1, 1, 'один точный якорь мутации значка шапки');
    const mutant = sources[surface].replace(anchor, "audio.muted ? 'volume-off' : 'volume'");
    await assert.rejects(zeroIsSilent(surface, mutant), (error: unknown) =>
      error instanceof assert.AssertionError && error.message.includes('0% без mute перечёркивает значок шапки'));
  });
}
