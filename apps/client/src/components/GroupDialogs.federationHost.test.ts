import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { ConvGroupMember, ConvSummary, DmChannel, User } from '@gusvoice/shared';
import type { ConfirmSpec } from '../confirmRules';
import * as groupRules from '../groupChatRules';
import * as dmRules from '../dmRules';
import * as contactRules from '../contactRules';
import type * as Dialogs from './GroupDialogs';
import { React, environment, icon, load, mutate, reactProps, sourceOf } from './R171.phoneHarness';

// Только целый модуль: GroupDialogHost подписывается на настоящее состояние окна,
// openGroupInfo открывает его, а API/подтверждение/тосты остаются границами I/O.
const source = sourceOf('GroupDialogs');
const CONV = 'group-e7';
const TITLE = 'Смешанная группа';
type Home = NonNullable<User['homeInstance']>;
const HOST: Home = { instanceId: 'home-x', name: 'Инстанс X', domain: 'x.example.test' };
const HOME_A: Home = { instanceId: 'home-a', name: 'Инстанс A', domain: 'a.example.test' };
const HOME_B: Home = { instanceId: 'home-b', name: 'Инстанс B', domain: 'b.example.test' };
type Person = DmChannel['otherUser'];
const candidates: Person[] = [
  { id: 'peer-a', username: 'e7_peer_a', displayName: 'Участник A', avatarUrl: null, homeInstance: HOME_A },
  { id: 'peer-b', username: 'e7_peer_b', displayName: 'Участник B', avatarUrl: null, homeInstance: HOME_B },
  { id: 'peer-local', username: 'e7_peer_local', displayName: 'Местный участник', avatarUrl: null },
];
type Op = 'rename' | 'add' | 'remove' | 'photo' | 'leave';
type HostSource = 'member' | 'direct' | 'unknown';
interface Options {
  foreign?: boolean;
  down?: boolean;
  hostSource?: HostSource;
  confirm?: boolean;
  reply?: (op: Op, args: unknown[]) => unknown | Promise<unknown>;
}
interface State {
  user: { id: string };
  members: [];
  dms: DmChannel[];
  serverFeatures: string[];
  conv: { summaries: Record<string, Pick<ConvSummary, 'fedGroupHost' | 'former'>> };
}
function fixture(options: Options): State {
  const member: ConvGroupMember = {
    id: 'member-x', username: 'e7_member_x', displayName: 'Участник X', avatarUrl: null, role: 'member',
    ...(options.hostSource === 'direct' ? { homeInstance: HOME_B } :
      options.hostSource === 'unknown' ? {} : { homeInstance: HOST }),
  };
  const dm: DmChannel = {
    id: CONV,
    otherUser: { id: `group:${CONV}`, username: '', displayName: TITLE, avatarUrl: null },
    createdAt: '2026-10-12T00:00:00Z', lastMessageAt: null,
    group: { title: TITLE, avatarUrl: null, ownerId: 'me', limit: 5, members: [
      { id: 'me', username: 'e7_me', displayName: 'Создатель', avatarUrl: null, role: 'owner' }, member,
    ] },
  };
  const dms = [dm, ...candidates.map((otherUser): DmChannel => ({
    id: `direct:${otherUser.id}`, otherUser, createdAt: dm.createdAt, lastMessageAt: null,
  }))];
  if (options.hostSource === 'direct') dms.push({
    id: 'direct:host', createdAt: dm.createdAt, lastMessageAt: null,
    otherUser: { id: 'host-peer', username: 'e7_host_peer', displayName: 'Собеседник X', avatarUrl: null, homeInstance: HOST },
  });
  return {
    user: { id: 'me' }, members: [], dms, serverFeatures: ['groups1', 'fedm6'],
    conv: { summaries: { [CONV]: options.foreign === false ? {} : {
      fedGroupHost: { instanceId: HOST.instanceId, ...(options.down ? { down: true } : {}) },
    } } },
  };
}
interface View {
  host: HTMLDivElement;
  dialogs: typeof Dialogs;
  state: State;
  calls: { op: Op; args: unknown[] }[];
  confirms: ConfirmSpec[];
  toasts: [string, string][];
  errors: unknown[];
  update: () => Promise<void>;
}
async function withInfo(options: Options, check: (view: View) => Promise<void>, raw = source): Promise<void> {
  await environment(async (host, render) => {
    const state = fixture(options);
    const calls: View['calls'] = [], confirms: ConfirmSpec[] = [], toasts: View['toasts'] = [], errors: unknown[] = [];
    const request = async (op: Op, args: unknown[]) => {
      calls.push({ op, args });
      return options.reply ? options.reply(op, args) : { ok: true };
    };
    const useStore = Object.assign((select: (s: State) => unknown) => select(state), { getState: () => state });
    const dialogs = load<typeof Dialogs>(raw, {
      '../api': { api: {
        convRenameGroup: (...args: unknown[]) => request('rename', args),
        convAddMembers: (...args: unknown[]) => request('add', args),
        convRemoveMember: (...args: unknown[]) => request('remove', args),
        convGroupPhoto: (...args: unknown[]) => request('photo', args),
        convLeaveGroup: (...args: unknown[]) => request('leave', args),
        searchUsers: async () => ({ users: [] }),
      } },
      '../confirm': { confirmAction: async (spec: ConfirmSpec) => { confirms.push(spec); return options.confirm !== false; } },
      '../dialogChrome': { useDialogChrome: () => React.useRef(null) },
      '../dmRules': dmRules, '../groupChatRules': groupRules, '../contactRules': contactRules,
      '../phoneLayout': { usePhoneLayout: () => false },
      '../contacts': { useContactList: () => [] },
      '../peerName': { usePeerName: () => (_id: string, fallback: string) => fallback },
      '../dmOnline': { useVisibleOnline: () => new Set<string>() },
      '../useContactSeen': { useContactSeen: () => new Map<string, string>() },
      '../store': { useStore },
      '../toast': { toast: (kind: string, message: string) => { toasts.push([kind, message]); }, toastError: (e: unknown) => { errors.push(e); } },
      './Avatar': { Avatar: () => React.createElement('i', { 'data-avatar': true }) },
      './Icon': { Icon: icon },
      './SharedMedia': { SharedMediaRows: () => null },
      './ServerActionModals': { CreateServerModal: () => null },
    });
    const update = () => render(React.createElement(dialogs.GroupDialogHost));
    await update();
    assert.equal(host.querySelector('[role="dialog"]'), null, 'сначала хост не показывает окно');
    await React.act(async () => { dialogs.openGroupInfo(CONV); await settle(); });
    assert.equal(host.querySelector('[role="dialog"]')?.getAttribute('aria-label'), 'Информация о группе',
      'окно открыл экспортированный openGroupInfo, а не извлечённый компонент');
    await check({ host, dialogs, state, calls, confirms, toasts, errors, update });
  });
}
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function query<T extends Element>(host: ParentNode, selector: string): T {
  const element = host.querySelector<T>(selector);
  assert.ok(element, `настоящее окно содержит ${selector}`);
  return element;
}
async function press(element: HTMLButtonElement) {
  await React.act(async () => { element.click(); await settle(); });
}
function action(host: ParentNode, text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);
  assert.ok(button, `настоящее окно содержит действие «${text}»`);
  return button;
}
async function changeName(host: ParentNode, value: string) {
  const input = query<HTMLInputElement>(host, 'input[aria-label="Название группы"]');
  await React.act(async () => { reactProps(input).onChange({ target: { value } }); await settle(); });
}
async function submitName(host: ParentNode) {
  const form = query<HTMLFormElement>(host, 'form.group-name-row');
  await React.act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle(); });
}
async function pick(host: ParentNode, id: string) {
  const person = candidates.find((c) => c.id === id);
  assert.ok(person, 'запрошен известный кандидат');
  const row = [...host.querySelectorAll<HTMLButtonElement>('.group-pick')]
    .find((b) => b.querySelector('.dm-sub')?.textContent?.trim() === `@${person.username}`);
  assert.ok(row, 'кандидат получен настоящими dmComposeCandidates и groupPickable');
  await press(row);
}
async function begin(view: View, op: Exclude<Op, 'photo' | 'leave'>) {
  if (op === 'rename') {
    await changeName(view.host, '  Новое название  ');
    assert.equal(query<HTMLButtonElement>(view.host, 'form button[type="submit"]').disabled, false,
      'живой дом разрешает сохранить новое название');
    await submitName(view.host);
  } else if (op === 'add') {
    await press(query(view.host, '.group-add'));
    assert.equal(action(view.host, 'Добавить').disabled, true, 'добавление без выбранного человека запрещено');
    await pick(view.host, 'peer-a');
    assert.equal(action(view.host, 'Добавить').disabled, false, 'выбор снимает запрет добавления');
    await press(action(view.host, 'Добавить'));
  } else await press(query(view.host, '.group-member button.danger'));
}
// Массив picked.map приходит из VM: сравниваем данные, не прототипы двух JS-миров.
function assertCall(view: View, op: Op, args: unknown[]) {
  assert.equal(JSON.stringify(view.calls), JSON.stringify([{ op, args }]), 'ручка вызвана один раз с настоящими аргументами');
}
function pendingToast(view: View) {
  assert.equal(view.toasts.length, 1, 'pending run сообщает ровно один информационный тост');
  assert.deepEqual(view.toasts[0], ['info', 'Запрос отправлен инстансу «Инстанс X»']);
  assert.deepEqual(view.errors, [], 'pending не превращается в toastError');
}
function assertGroupUnchanged(view: View) {
  const group = view.state.dms[0].group!;
  assert.equal(group.title, TITLE, 'ответ ручки не подменяет авторитетное название из сводки');
  assert.deepEqual(group.members.map((m) => m.id), ['me', 'member-x'], 'ответ ручки не подменяет авторитетный состав из сводки');
}
const opArgs: Record<Exclude<Op, 'photo' | 'leave'>, unknown[]> = {
  rename: [CONV, 'Новое название'], add: [CONV, ['peer-a']], remove: [CONV, 'member-x'],
};
async function successfulOperation(op: Exclude<Op, 'photo' | 'leave'>, pending: boolean, raw = source) {
  await withInfo({ reply: () => ({ ok: true, ...(pending ? { pending: true } : {}) }) }, async (view) => {
    await begin(view, op);
    assertCall(view, op, opArgs[op]);
    if (pending) pendingToast(view);
    else { assert.deepEqual(view.toasts, [], 'обычный успешный ответ не обещает отправку инстансу'); assert.deepEqual(view.errors, []); }
    assertGroupUnchanged(view);
    assert.equal(view.host.querySelector('[role="dialog"]')?.getAttribute('aria-label'), 'Информация о группе',
      'переименование, добавление и удаление оставляют информацию открытой');
    if (op === 'rename') {
      assert.equal(view.host.querySelector('form button[type="submit"]'), null, 'sentTitle скрывает повторную отправку того же названия');
      await changeName(view.host, 'Новое название');
      assert.equal(view.host.querySelector('form button[type="submit"]'), null, 'пробелы не обходят sentTitle');
      // Сводка приезжает отдельно от pending: кнопка всё ещё скрыта, но следующий текст можно послать.
      view.state.dms[0].group = { ...view.state.dms[0].group!, title: 'Новое название' };
      await view.update();
      await changeName(view.host, 'Следующее название');
      assert.equal(query<HTMLButtonElement>(view.host, 'form button[type="submit"]').disabled, false);
      await changeName(view.host, '   ');
      assert.equal(view.host.querySelector('form button[type="submit"]'), null, 'пустое название не отправляется');
    } else if (op === 'add') {
      await press(query(view.host, '.group-add'));
      assert.equal(view.host.querySelectorAll('.group-chip').length, 0, 'успех очищает выбранных при следующем открытии добавления');
      assert.equal(action(view.host, 'Добавить').disabled, true);
    } else {
      assert.equal(view.confirms.length, 1);
      assert.equal(view.confirms[0].title, 'Удалить Участник X из группы?');
      assert.equal(view.confirms[0].confirmLabel, 'Удалить');
      assert.equal(query<HTMLButtonElement>(view.host, '.group-member button.danger').disabled, false, 'busy снят после ответа');
    }
  }, raw);
}

// Потеря pending молчит о доставке, а лишний тост у обычного успеха обещает несуществующую очередь (3 × 2 случая).
for (const op of ['rename', 'add', 'remove'] as const) for (const pending of [true, false]) {
  it(`R206 ${op}: ${pending ? 'pending даёт тост дома' : 'обычный успех обходится без тоста pending'}, сводка и окно не теряются`, async () => {
    await successfulOperation(op, pending);
  });
}

async function downControls(hostSource: HostSource, raw = source) {
  await withInfo({ down: true, hostSource }, async (view) => {
    const label = hostSource === 'unknown' ? null : 'Инстанс X';
    const hint = groupRules.fedGroupDownText(label);
    assert.equal(query(view.host, '.group-limit').textContent, hint, 'лежавший дом объяснён над составом');
    assert.equal(query(view.host, '.group-limit').getAttribute('role'), 'status');
    const name = query<HTMLInputElement>(view.host, 'input[aria-label="Название группы"]');
    assert.equal(name.disabled, true); assert.equal(name.title, hint);
    const add = query<HTMLButtonElement>(view.host, '.group-add');
    assert.equal(add.disabled, true, 'hostDown запрещает group-add даже ниже предела');
    assert.equal(add.title, hint);
    for (const selector of ['.group-leave', '.group-member button.danger']) {
      const button = query<HTMLButtonElement>(view.host, selector);
      assert.equal(button.disabled, true, 'лежавший дом блокирует уход и удаление');
      assert.equal(button.title, hint); await press(button);
    }
    await press(add);
    assert.equal(view.host.querySelector('[role="dialog"]')?.getAttribute('aria-label'), 'Информация о группе',
      'disabled не открывает подбор людей');
    // Изменение через React-handler имитирует прежний ввод до падения дома: submit тоже обязан иметь запрет.
    await changeName(view.host, 'Новое название');
    assert.equal(query<HTMLButtonElement>(view.host, 'form button[type="submit"]').disabled, true);
    await submitName(view.host);
    assert.deepEqual(view.calls, []); assert.deepEqual(view.confirms, []);
    assert.deepEqual(view.toasts, []); assert.deepEqual(view.errors, []);
  }, raw);
}
// Недоступность обязана блокировать состав даже ниже лимита, независимо от источника имени дома.
for (const hostSource of ['member', 'direct', 'unknown'] as const) {
  it(`R206 дом группы лежит: имя ${hostSource} и все действия состава закрыты ниже предела`, async () => {
    await downControls(hostSource);
  });
}
// Парное принятие ловит запрет всех чужих групп вместо запрета только лежавшего дома.
it('R206 живой дом не рисует предупреждение недоступности и разрешает состав и название', async () => {
  await withInfo({}, async (view) => {
    assert.equal(view.host.querySelector('.group-limit'), null);
    for (const selector of ['input[aria-label="Название группы"]', '.group-add', '.group-leave', '.group-member button.danger']) {
      const control = query<HTMLInputElement | HTMLButtonElement>(view.host, selector);
      assert.equal(control.disabled, false, 'живой дом сохраняет возможность управления');
      assert.equal(control.getAttribute('title'), null);
    }
    assert.deepEqual(view.calls, []);
  });
});

async function photo(foreign: boolean, raw = source) {
  await withInfo({ foreign }, async (view) => {
    const button = query<HTMLButtonElement>(view.host, '.group-photo');
    const fileInput = query<HTMLInputElement>(button, 'input[type="file"]');
    let fileClicks = 0;
    const originalClick = fileInput.click;
    fileInput.click = () => { fileClicks += 1; };
    try {
      await press(button);
      assert.equal(fileClicks, foreign ? 0 : 1, 'фото чужого дома не открывает файловый выбор');
      assert.equal(button.title, foreign ? 'Фото меняется на инстансе «Инстанс X»' : 'Фото группы');
      assert.equal(button.getAttribute('aria-disabled'), foreign ? 'true' : null);
      assert.deepEqual(view.toasts, foreign ? [['info', 'Фото меняется на инстансе «Инстанс X»']] : []);
      assert.deepEqual(view.errors, []); assert.deepEqual(view.calls, []);
    } finally { fileInput.click = originalClick; }
  }, raw);
}
// aria-disabled не блокирует click: locked должен сам объяснить запрет; местное фото должно остаться доступным.
for (const foreign of [true, false]) {
  it(`R206 фото ${foreign ? 'чужого живого дома даёт подсказку без выбора файла' : 'своей группы открывает выбор файла без подсказки'}`, async () => {
    await photo(foreign);
  });
}

const refusedCases = [
  { userIds: ['peer-b'], expected: 'Нельзя позвать: инстанс «Инстанс B» не поддерживает группы', label: 'только отказанный дом' },
  { userIds: undefined, expected: 'Нельзя позвать: инстансы «Инстанс A», «Инстанс B» не поддерживают группы', label: 'все выбранные дома без списка id' },
  { userIds: ['peer-local'], expected: 'Нельзя позвать: инстанс этого человека не поддерживает группы', label: 'запасная фраза для своего id' },
] as const;
// Отказ относится к домам приглашённых, не к хосту группы; потеря выбора мешает исправить и повторить запрос.
for (const testCase of refusedCases) it(`R206 group_not_invitable: ${testCase.label}, выбранные люди сохраняются`, async () => {
  const error = Object.assign(new Error('group_not_invitable'), { status: 403,
    ...(testCase.userIds ? { userIds: [...testCase.userIds] } : {}) });
  await withInfo({ reply: async () => { throw error; } }, async (view) => {
    await press(query(view.host, '.group-add'));
    for (const person of candidates) await pick(view.host, person.id);
    await press(action(view.host, 'Добавить'));
    assertCall(view, 'add', [CONV, candidates.map((p) => p.id)]);
    assert.deepEqual(view.toasts, [['error', testCase.expected]], 'отказ объясняет дома выбранных, а не дом группы');
    assert.deepEqual(view.errors, [], 'group_not_invitable обработан отдельно от toastError');
    assert.equal(view.host.querySelector('[role="dialog"]')?.getAttribute('aria-label'), 'Добавить участников');
    assert.equal(view.host.querySelectorAll('.group-chip').length, 3, 'при отказе выбор не очищен');
    assert.equal(action(view.host, 'Добавить').disabled, false, 'после отказа можно изменить выбор и повторить');
    assertGroupUnchanged(view);
  });
});

// Падение хоста после открытия окна не должно выглядеть успехом или терять имя в общем обработчике ошибок.
for (const op of ['rename', 'add', 'remove'] as const) it(`R206 ${op}: 403 host_down доходит до toastError с именем дома и сохраняет окно`, async () => {
  const error = Object.assign(new Error('federation.dm_group_host_down'), { status: 403, fedWho: undefined as string | undefined });
  await withInfo({ reply: async () => { throw error; } }, async (view) => {
    await begin(view, op); assertCall(view, op, opArgs[op]);
    assert.equal(view.errors.length, 1); assert.equal(view.errors[0], error);
    assert.equal(error.fedWho, 'Инстанс X', 'groupError передаёт имя хоста в toastError');
    assert.deepEqual(view.toasts, [], 'отказ не рисует успешный pending');
    assert.ok(view.host.querySelector('[role="dialog"]'), 'при отказе окно не закрывается');
    if (op === 'rename') assert.equal(query<HTMLButtonElement>(view.host, 'form button[type="submit"]').disabled, false,
      'неудачный rename не записывает sentTitle');
    if (op === 'add') { assert.equal(view.host.querySelectorAll('.group-chip').length, 1); assert.equal(action(view.host, 'Добавить').disabled, false); }
    assertGroupUnchanged(view);
  });
});
// Уже уточнённая сервером причина не должна обвинять другой инстанс после обработки в окне группы.
it('R206 groupError сохраняет уже заданный fedWho вместо подмены домом группы', async () => {
  const error = Object.assign(new Error('federation.dm_group_host_down'), { status: 403, fedWho: 'Исходный инстанс' });
  await withInfo({ reply: async () => { throw error; } }, async (view) => {
    await begin(view, 'rename');
    assert.equal(view.errors[0], error); assert.equal(error.fedWho, 'Исходный инстанс');
    assert.deepEqual(view.toasts, []);
  });
});

// Уход ещё в доставке, но окно закрывается сразу; отсутствие участника хоста не должно потерять подпись из 1:1.
it('R206 pending leaveGroup закрывает открытое окно и сообщает имя дома из 1:1', async () => {
  await withInfo({ hostSource: 'direct', reply: () => ({ ok: true, pending: true }) }, async (view) => {
    await press(query(view.host, '.group-leave'));
    assertCall(view, 'leave', [CONV]); pendingToast(view);
    assert.equal(view.host.querySelector('[role="dialog"]'), null, 'pending уход закрывает именно показанное окно');
    assert.equal(view.confirms.length, 1); assert.equal(view.confirms[0].title, `Покинуть «${TITLE}»?`);
    assert.equal(view.confirms[0].confirmLabel, 'Покинуть'); assert.equal(view.confirms[0].tone, 'danger');
    assertGroupUnchanged(view);
  });
});
// Неудачный уход не должен закрыть окно или выглядеть завершённым выходом из группы.
it('R206 leaveGroup при host_down сохраняет окно и передаёт fedWho в toastError', async () => {
  const error = Object.assign(new Error('federation.dm_group_host_down'), { status: 403, fedWho: undefined as string | undefined });
  await withInfo({ reply: async () => { throw error; } }, async (view) => {
    await press(query(view.host, '.group-leave')); assertCall(view, 'leave', [CONV]);
    assert.equal(view.errors.length, 1); assert.equal(view.errors[0], error); assert.equal(error.fedWho, 'Инстанс X');
    assert.deepEqual(view.toasts, []);
    assert.equal(view.host.querySelector('[role="dialog"]')?.getAttribute('aria-label'), 'Информация о группе');
    assertGroupUnchanged(view);
  });
});
// Отмена подтверждения — не отправка leave с последующим косметическим восстановлением окна.
it('R206 отменённое подтверждение ухода не вызывает API и не закрывает информацию', async () => {
  await withInfo({ confirm: false }, async (view) => {
    await press(query(view.host, '.group-leave'));
    assert.equal(view.confirms.length, 1); assert.deepEqual(view.calls, []);
    assert.deepEqual(view.toasts, []); assert.deepEqual(view.errors, []);
    assert.ok(view.host.querySelector('[role="dialog"]')); assertGroupUnchanged(view);
  });
});
// Отмена удаления обязана сохранить человека и не послать запрос хосту группы.
it('R206 отменённое удаление участника не вызывает API и сохраняет состав', async () => {
  await withInfo({ confirm: false }, async (view) => {
    await press(query(view.host, '.group-member button.danger'));
    assert.equal(view.confirms.length, 1); assert.deepEqual(view.calls, []);
    assert.deepEqual(view.toasts, []); assert.deepEqual(view.errors, []); assertGroupUnchanged(view);
  });
});

// Незавершённый запрос не должен запускать конфликтующие операции; после ответа UI не должен остаться заблокированным.
it('R206 занятый rename блокирует повторный запрос, уход и удаление до ответа, затем снимает busy', async () => {
  let resolve!: (value: unknown) => void;
  const response = new Promise<unknown>((yes) => { resolve = yes; });
  await withInfo({ reply: () => response }, async (view) => {
    try {
      await begin(view, 'rename'); assertCall(view, 'rename', opArgs.rename);
      for (const selector of ['form button[type="submit"]', '.group-leave', '.group-member button.danger']) {
        assert.equal(query<HTMLButtonElement>(view.host, selector).disabled, true, 'busy закрывает конфликтующие действия');
      }
      await submitName(view.host); assertCall(view, 'rename', opArgs.rename);
      await React.act(async () => { resolve({ ok: true, pending: true }); await settle(); });
      pendingToast(view);
      assert.equal(query<HTMLButtonElement>(view.host, '.group-leave').disabled, false);
      assert.equal(query<HTMLButtonElement>(view.host, '.group-member button.danger').disabled, false);
      assert.equal(view.host.querySelector('form button[type="submit"]'), null);
    } finally { resolve({ ok: true }); }
  });
});

function hostAssertion(message: string, actual: unknown, expected: unknown) {
  return (error: unknown) => error instanceof assert.AssertionError && error.message.startsWith(message)
    && error.actual === actual && error.expected === expected;
}
// Контрфакт ловит потерю именно запрета по доступности хоста, а не случайный предел заполненной группы.
it('R206 потеря hostDown у group-add обнаруживается запретом кнопки в настоящем окне', async () => {
  await downControls('member');
  const mutant = mutate(source, 'disabled={group.members.length >= group.limit || hostDown}',
    'disabled={group.members.length >= group.limit}');
  await assert.rejects(() => downControls('member', mutant),
    hostAssertion('hostDown запрещает group-add даже ниже предела', false, true));
});
// Контрфакт доказывает реальное открытие выбора файла, а не только изменение title/aria-disabled.
it('R206 потеря locked у фото обнаруживается фактом открытия выбора файла чужой группы', async () => {
  await photo(true);
  const mutant = mutate(source, 'locked={fedHost ? fedGroupPhotoHint(hostLabel) : undefined}', 'locked={undefined}');
  await assert.rejects(() => photo(true, mutant),
    hostAssertion('фото чужого дома не открывает файловый выбор', 1, 0));
});
// Контрфакт проверяет исчезнувший тост после успешного API, а не ошибки загрузки компонента.
it('R206 потеря groupOpPending в run обнаруживается отсутствием информационного тоста, не ошибкой VM', async () => {
  await successfulOperation('rename', true);
  const mutant = mutate(source,
    "      after?.();\n      if (groupOpPending(r)) toast('info', fedGroupPendingText(hostLabel));",
    '      after?.();');
  await assert.rejects(() => successfulOperation('rename', true, mutant),
    hostAssertion('pending run сообщает ровно один информационный тост', 0, 1));
});
