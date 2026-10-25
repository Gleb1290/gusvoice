import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as jsx from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import ts from 'typescript';
import * as dmRules from '../dmRules';
import * as convRules from '../convSyncRules';
import * as contactRules from '../contactRules';
import * as listRules from '../dmListRules';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const source = read('./DmSidebar.tsx');
const contact = { id: 'contact-user', name: 'Мой контакт', displayName: 'Имя собеседника', username: 'contact', avatarUrl: null };
type Who = { name: string; username: string; avatarUrl: string | null };
type Sidebar = {
  NewDmSheet: React.ComponentType<{ initialQuery: string }>;
  ContactPickSheet: React.ComponentType<{ onPick: (id: string, who: Who) => void; onClose: () => void }>;
};
type Scene = {
  body: HTMLElement;
  closed(): number;
  composeClosed(): number;
  picks: Array<{ id: string; who: Who }>;
  opened: string[];
  click(selector: string): Promise<void>;
};
function load<T>(raw: string, deps: Record<string, unknown>): T {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(raw, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, {
    module, exports: module.exports, window, document, performance,
    require: (id: string) => {
      assert.ok(Object.hasOwn(deps, id), `неописанная граница целого NewDmSheet/BottomSheet: ${id}`);
      return deps[id];
    },
  });
  return module.exports as T;
}

async function fixture(phone: boolean, pick: boolean, work: (scene: Scene) => Promise<void>, raw = source) {
  GlobalRegistrator.register({ url: 'http://localhost/', width: phone ? 360 : 1200 });
  const priorAct = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const opened: string[] = [], picks: Scene['picks'] = [];
  let closed = 0, composeClosed = 0, hide = () => {};
  const unused = () => assert.fail('IO и чужие сценарии не нужны экрану выбора контакта');
  const state = {
    members: [], dms: [], user: { id: 'me' }, serverFeatures: ['contacts1'], convActive: true,
    openDmWith: async (id: string) => { opened.push(id); }, openDmRemote: unused, openSaved: unused,
  };
  const useStore = Object.assign((select: (value: typeof state) => unknown) => select(state), { getState: () => state });
  const common = { react: React, 'react-dom': ReactDOM, 'react/jsx-runtime': jsx };
  const contacts = [contact], online = new Set<string>(), seen = new Map<string, string>();
  const nameOf = (_id: string, fallback: string) => fallback;
  try {
    const icon = load<typeof import('./Icon')>(read('./Icon.tsx'), common);
    // Не макет с пропом page: настоящая оболочка создаёт портал и выбирает экран/лист.
    const bottom = load<typeof import('./BottomSheet')>(read('./BottomSheet.tsx'), { ...common, './Icon': icon });
    const deps: Record<string, unknown> = {
      ...common, '../store': { useStore }, '../dmRules': dmRules, '../convSyncRules': convRules,
      '../contactRules': contactRules, '../dmListRules': listRules,
      '../api': { api: { searchUsers: unused } },
      '../dmOnline': { useVisibleOnline: () => online }, '../useContactSeen': { useContactSeen: () => seen },
      '../phoneLayout': { usePhoneLayout: () => phone }, '../hotkeys': { isMobile: () => phone, isTauri: () => false },
      '../dialogChrome': { useDialogChrome: () => React.useRef(null) },
      '../toast': { toast: unused, toastError: unused },
      '../dmCompose': { closeDmCompose: () => { composeClosed++; hide(); } },
      '../contacts': { useContactList: (enabled: boolean) => { assert.equal(enabled, true); return contacts; } },
      '../peerName': { usePeerName: () => nameOf }, './BottomSheet': bottom, './Icon': icon,
      './Avatar': { Avatar: () => null },
    };
    // Остальные экспорты целого DmSidebar не рендерятся. Не загружаем стор, транспорт или живые подписки.
    for (const id of ['../channelRules', '../chatKeysRules', '../dmArchiveRules', '../dmRowRules', '../typing', '../androidBack', '../connState',
      './SavedAvatar', './GroupDialogs', '../groupChatRules', './DmRowMenu', './DmFolderBar', '../dmFolderView', '../dmFolders',
      '../cornerButtonsRules', '../dmListSearchRules', './DmServerSearch', './DmAllSearch', './DmListSearch', './DmArchive',
      '../dragOut', '../dmListView', '../uiPrefs', '../filesDrop', './DmListSwipe', './DmPinDrag', '../chatSwipe', './Goose',
      './SelfVoiceBar', './SettingsShell', './SharedMedia', './StatusDot', './VoicePanel', '../voiceDrafts']) deps[id] = {};
    // Только тестовый экспорт приватного компонента; исполняется весь модуль, не вырезанный JSX.
    const sidebar = load<Sidebar>(`${raw}\nexport { NewDmSheet };`, deps);
    function Parent() {
      const [visible, setVisible] = React.useState(true);
      hide = () => setVisible(false);
      if (!visible) return null;
      return pick
        ? React.createElement(sidebar.ContactPickSheet, {
          onClose: () => { closed++; hide(); }, onPick: (id, who) => { picks.push({ id, who }); },
        })
        : React.createElement(sidebar.NewDmSheet, { initialQuery: '' });
    }
    await React.act(async () => { root.render(React.createElement(Parent)); });
    await work({ body: document.body, closed: () => closed, composeClosed: () => composeClosed, picks, opened,
      async click(selector) {
        const target = document.querySelector<HTMLElement>(selector);
        assert.ok(target, `есть доступная цель ${selector}`);
        await React.act(async () => { target.click(); });
      },
    });
  } finally {
    try { await React.act(async () => root.unmount()); } finally {
      host.remove();
      try { await GlobalRegistrator.unregister(); } finally {
        if (priorAct) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', priorAct);
        else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      }
    }
  }
}

function checkInput(body: HTMLElement, phone: boolean) {
  const input = body.querySelector<HTMLInputElement>('input.sheet-search');
  assert.ok(input, 'поле поиска остаётся общим для compose и выбора контакта');
  assert.equal(input.placeholder, 'Кому написать?');
  // React autoFocus не обязан отражаться HTML-атрибутом: проверяем реальный фокус после mount.
  assert.equal(document.activeElement === input, !phone, 'телефон не вызывает клавиатуру сам, ПК сразу готов к набору');
}
function checkPicker(body: HTMLElement, phone: boolean) {
  // При намеренно сломанной page-ветке DOM-узел нельзя отдавать assert для diff:
  // util.inspect дерева happy-dom может исчерпать память раньше предметной AssertionError.
  assert.equal(!!body.querySelector('.sheet.page'), false, 'R258-pick: выбор контакта не превращается в полный экран');
  assert.equal(!!body.querySelector('.sheet-page-bar'), false);
  if (phone) {
    assert.ok(body.querySelector('.sheet-scrim:not(.page) > .sheet:not(.page) .sheet-grab'), 'контакт остаётся обычным листом с ручкой');
    assert.equal(body.querySelector('.sheet-title')?.textContent, 'Отправить контакт');
    assert.equal(!!body.querySelector('.modal-overlay'), false);
  } else {
    assert.equal(!!body.querySelector('.sheet'), false);
    assert.equal(body.querySelector('.modal-overlay > .modal.dm-compose h2')?.textContent, 'Отправить контакт');
  }
  checkInput(body, phone);
}

it('R258 телефон: Новое сообщение открывается экраном со стрелкой назад, а не листом с ручкой', async () => {
  await fixture(true, false, async scene => {
    assert.ok(scene.body.querySelector('.sheet-scrim.page > .sheet.page[role="dialog"][aria-modal="true"]'));
    assert.equal(scene.body.querySelector('.sheet-page-title')?.textContent, 'Новое сообщение');
    assert.equal(scene.body.querySelector('.sheet.page')?.getAttribute('aria-label'), 'Новое сообщение');
    assert.equal(!!scene.body.querySelector('.sheet-grab'), false);
    assert.equal(!!scene.body.querySelector('.modal.dm-compose'), false);
    checkInput(scene.body, true);
    await scene.click('.sheet-page-bar .sheet-back');
    assert.equal(scene.composeClosed(), 1, 'стрелка закрывает compose через его прежний контракт');
    assert.equal(scene.closed(), 0); assert.equal(!!scene.body.querySelector('.sheet'), false);
    assert.equal(scene.opened.length, 0);
  });
});

it('R258 телефон: выбор контакта остаётся листом со своим заголовком и закрывается своим onClose', async () => {
  await fixture(true, true, async scene => {
    checkPicker(scene.body, true);
    await scene.click('.sheet-scrim');
    assert.equal(scene.closed(), 1); assert.equal(scene.composeClosed(), 0);
    assert.equal(scene.picks.length, 0); assert.equal(!!scene.body.querySelector('.sheet'), false);
  });
});

it('R258 ПК: Написать остаётся окном ComposeDialog по центру, а не телефонным экраном или листом', async () => {
  await fixture(false, false, async scene => {
    const dialog = scene.body.querySelector('.modal-overlay > .modal.dm-compose');
    assert.ok(dialog, 'сохраняется оконная оболочка ПК, а не BottomSheet');
    assert.equal(dialog.getAttribute('role'), 'dialog'); assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(dialog.querySelector('h2')?.textContent, 'Написать');
    assert.equal(!!scene.body.querySelector('.sheet-scrim, .sheet, .sheet-page-bar'), false);
    checkInput(scene.body, false);
    await scene.click('.modal-overlay');
    assert.equal(scene.composeClosed(), 1); assert.equal(scene.closed(), 0);
    assert.equal(!!scene.body.querySelector('.modal.dm-compose'), false);
  });
});

it('R258 ПК: карточка контакта сохраняет отдельный заголовок и не закрывает чужой compose', async () => {
  await fixture(false, true, async scene => {
    checkPicker(scene.body, false);
    await scene.click('.modal-overlay');
    assert.equal(scene.closed(), 1); assert.equal(scene.composeClosed(), 0);
    assert.equal(scene.picks.length, 0); assert.equal(!!scene.body.querySelector('.modal.dm-compose'), false);
  });
});

it('R258 обе раскладки: выбор строки отдаёт контакт родителю и не открывает беседу', async () => {
  for (const phone of [true, false]) await fixture(phone, true, async scene => {
    checkPicker(scene.body, phone);
    // Это настоящий ContactPickSheet, не переданный вручную pick: защищаем оба способа использования общего поля.
    await scene.click('.dm-compose-list .sheet-row');
    assert.equal(scene.closed(), 1); assert.equal(scene.composeClosed(), 0);
    assert.equal(scene.opened.length, 0, 'выбор вложения не становится переходом в личку');
    // who создан в VM, его прототип принадлежит другому realm; сравниваем данные, не прототип.
    assert.equal(JSON.stringify(scene.picks), JSON.stringify([{ id: contact.id,
      who: { name: contact.name, username: contact.username, avatarUrl: null } }]));
    assert.equal(!!scene.body.querySelector('.sheet, .modal.dm-compose'), false);
  });
});

it('R258 контрфакт: безусловный page обнаруживается настоящим выбором контакта после зелёного оригинала', async () => {
  const scenario = (raw: string) => fixture(true, true, async scene => { checkPicker(scene.body, true); }, raw);
  await scenario(source);
  const anchor = 'page={!pick}';
  assert.equal(source.split(anchor).length - 1, 1, 'единственная развилка экран/лист в NewDmSheet');
  await assert.rejects(scenario(source.replace(anchor, 'page')), (error: unknown) =>
    error instanceof assert.AssertionError && error.message.startsWith('R258-pick: выбор контакта не превращается в полный экран')
      && error.actual === true && error.expected === false);
});
