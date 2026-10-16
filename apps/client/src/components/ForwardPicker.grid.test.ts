import assert from 'node:assert/strict';
import { it } from 'node:test';
import { React, load, sourceOf, icon, noop, environment, click, reactProps, mutate } from './R171.phoneHarness';
import * as listRules from '../dmListRules';
import * as rowRules from '../dmRowRules';
import type * as Picker from './ForwardPicker';
import type * as Sidebar from './DmSidebar';

const source = sourceOf('ForwardPicker');
const cellsSource = sourceOf('DmSidebar');
type Mode = 'plain' | 'share' | 'one';
async function fixture(phone: boolean, mode: Mode, check: (f: {
  host: HTMLDivElement; drafts: string[]; picks: string[]; sends: string[][]; closes(): number;
  hold(selector: string): Promise<void>;
}) => Promise<void>, raw = source, rawCells = cellsSource) {
  await environment(async (host, render) => {
    const timers = new Map<number, { fn: () => void; delay: number }>(); let next = 0;
    const oldSet = window.setTimeout, oldClear = window.clearTimeout;
    window.setTimeout = ((fn: () => void, delay = 0) => { timers.set(++next, { fn, delay }); return next; }) as typeof window.setTimeout;
    window.clearTimeout = ((id: number) => timers.delete(id)) as typeof window.clearTimeout;
    const drafts: string[] = [], picks: string[] = [], sends: string[][] = []; let closes = 0;
    try {
      const cells = load<typeof Sidebar>(rawCells, {
        '../dmListRules': listRules,
        './Avatar': { Avatar: ({ size, name }: { size: number; name: string }) => React.createElement('i', { 'data-avatar': size, 'data-name': name }) },
        './SavedAvatar': { SavedAvatar: ({ size }: { size: number }) => React.createElement('i', { 'data-saved': size }) },
        './StatusDot': { StatusDot: () => React.createElement('i', { 'data-online': true }) }, './Icon': { Icon: icon },
      }, { navigator: { vibrate: noop } });
      const dms = [{ id: 'c', otherUser: { id: 'peer', username: 'anna', displayName: 'Анна', avatarUrl: null } },
        { id: 'saved', saved: true, otherUser: { id: 'me', username: 'me', displayName: 'Я', avatarUrl: null } }];
      const state = { dms, convActive: false, serverFeatures: [], user: { id: 'me' }, currentDmId: 'current', unreadDms: [],
        conv: { summaries: {} }, drafts: {}, outbox: {} };
      const module = load<typeof Picker>(raw, {
        '../dialogChrome': { useDialogChrome: () => ({ current: null }) },
        '../convSyncRules': { serverSaved: () => false }, '../dmRowRules': rowRules,
        '../phoneLayout': { usePhoneLayout: () => phone },
        '../peerName': { usePeerName: () => (_id: string, fallback: string) => fallback,
          dmPeerLabel: (d: typeof dms[number]) => d.saved ? 'Избранное' : d.otherUser.displayName },
        '../store': { useStore: (select: (s: typeof state) => unknown) => select(state) },
        '../dmOnline': { useVisibleOnline: () => new Set(['peer']) },
        './Icon': { Icon: icon }, './BottomSheet': { BottomSheet: ({ children }: { children: React.ReactNode }) => React.createElement('div', { className: 'phone-sheet' }, children) },
        './DmSidebar': { ForwardCell: cells.ForwardCell, ForwardAva: cells.ForwardAva,
          DmRow: ({ dm, onOpen }: { dm: typeof dms[number]; onOpen(id: string): void }) =>
            React.createElement('button', { className: 'dm-row', onClick: () => onOpen(dm.id) }, dm.otherUser.displayName) },
      });
      await render(React.createElement(module.ForwardPicker, { count: 1,
        onSend: ids => sends.push([...ids]), onClose: () => closes++,
        ...(mode === 'share' ? { onDraft: (id: string) => drafts.push(id),
          share: { title: 'Поделиться', head: 'Текст', channels: [{ id: 'ch', serverId: 'server', name: 'общий', serverName: 'Сервер', serverIconUrl: null }] } } : {}),
        ...(mode === 'one' ? { pickOne: { title: 'Ответить', what: 'Выберите', onPick: (id: string) => picks.push(id) } } : {}),
      }));
      await check({ host, drafts, picks, sends, closes: () => closes,
        hold: async selector => {
          const el = host.querySelector(selector); assert.ok(!!el);
          await React.act(async () => reactProps(el).onTouchStart({ touches: [{ clientX: 10, clientY: 10 }] }));
          const pending = [...timers].filter(([, value]) => value.delay === listRules.DM_ROW_HOLD_MS);
          assert.equal(pending.length, 1, 'удержание назначило штатный срок');
          await React.act(async () => { for (const [id, value] of pending) { timers.delete(id); value.fn(); } });
          assert.equal(host.querySelector(selector) === el, true, 'выбор сохраняет удерживаемую ячейку после rerender');
          await React.act(async () => {
            reactProps(el).onTouchEnd({ cancelable: true, preventDefault: noop }); (el as HTMLElement).click();
          });
        },
      });
    } finally { window.setTimeout = oldSet; window.clearTimeout = oldClear; }
  });
}
async function plain(raw = source, rawCells = cellsSource) {
  await fixture(true, 'plain', async f => {
    assert.equal(!!f.host.querySelector('.fwd-grid'), true); assert.equal(!!f.host.querySelector('.dm-row'), false);
    const cell = f.host.querySelector<HTMLButtonElement>('.fwd-cell'); assert.ok(!!cell);
    assert.equal(cell.getAttribute('role'), 'checkbox'); assert.equal(cell.getAttribute('aria-checked'), 'false');
    assert.equal(f.host.querySelector('[data-saved]')?.getAttribute('data-saved'), '56');
    assert.equal(f.host.querySelector('[data-avatar]')?.getAttribute('data-avatar'), '56');
    await click(f.host, '.fwd-cell');
    assert.equal(f.host.querySelector('.fwd-cell') === cell, true, 'переключение не перемонтирует ячейку');
    assert.equal(cell.classList.contains('picked'), true); assert.equal(cell.getAttribute('aria-checked'), 'true');
    assert.equal(f.sends.length, 0, 'тап отмечает, а не отправляет');
    await click(f.host, '.fwd-cell'); assert.equal(cell.getAttribute('aria-checked'), 'false');
    await click(f.host, '.fwd-cell');
    const send = f.host.querySelector<HTMLButtonElement>('.fwd-send'); assert.ok(!!send);
    assert.equal(send.classList.contains('round'), true); assert.equal(send.getAttribute('aria-label'), 'Отправить (1)');
    await React.act(async () => { send.click(); send.click(); });
    assert.equal(f.sends.length, 1, 'двойной тап отправляет один раз');
    assert.equal(f.sends[0].length, 1); assert.equal(f.sends[0][0], 'saved'); assert.equal(f.closes(), 1);
  }, raw, rawCells);
}
it('R171 телефонная пересылка отмечает ячейки, рисует аватар 56 и отправляет выбранное один раз круглой кнопкой', () => {
  // Повторная отправка не отменяется: один двойной тап не должен дублировать сообщения.
  return plain();
});
it('R171 компьютер сохраняет список строк без телефонной сетки и круглой кнопки', async () => {
  // Телефонная разметка не должна вытеснять привычный список компьютера.
  await fixture(false, 'plain', async f => {
    assert.equal(!!f.host.querySelector('.fwd-grid'), false); assert.equal(f.host.querySelectorAll('.dm-row').length, 2);
    await click(f.host, '.dm-row'); assert.equal(f.host.querySelector('.fwd-send')?.classList.contains('round'), false);
  });
});
it('R171 share при пустом выборе открывает черновик без галочек, pickOne сразу выбирает без отправки', async () => {
  // Одинаковая ячейка имеет разные контракты: черновик и ответ в другом чате не отправляют сейчас.
  for (const mode of ['share', 'one'] as const) await fixture(true, mode, async f => {
    const cell = f.host.querySelector('.fwd-cell'); assert.ok(!!cell);
    assert.equal(cell.getAttribute('role'), null); assert.equal(cell.getAttribute('aria-checked'), null);
    await click(f.host, '.fwd-cell'); assert.equal(f.sends.length, 0); assert.equal(f.closes(), 1);
    assert.equal((mode === 'share' ? f.drafts : f.picks)[0], 'saved');
    assert.equal(!!f.host.querySelector('.fwd-send'), false);
  });
});
it('R171 share удержанием включает выбор, глотает отпускание, канал подписан решёткой без online', async () => {
  // Без подавления клика отпускания первый выбранный адресат тут же снялся бы или открыл черновик.
  await fixture(true, 'share', async f => {
    const channel = [...f.host.querySelectorAll('.fwd-cell')].find(el => el.textContent?.includes('# общий')); assert.ok(!!channel);
    assert.equal(f.host.querySelectorAll('.fwd-cell-dot').length, 1, 'собеседник online имеет точку до выбора');
    assert.equal(!!channel.querySelector('.fwd-cell-dot'), false);
    assert.equal(channel.getAttribute('role'), null);
    await f.hold('.fwd-cell');
    assert.equal([...f.host.querySelectorAll('.fwd-cell')].find(el => el.textContent?.includes('# общий')) === channel, true);
    assert.equal(f.drafts.length, 0); assert.equal(f.closes(), 0);
    assert.equal(f.host.querySelector('.fwd-cell')?.getAttribute('aria-checked'), 'true');
    await React.act(async () => (channel as HTMLElement).click()); assert.equal(channel.getAttribute('aria-checked'), 'true');
    assert.equal(f.host.querySelector('.fwd-send')?.getAttribute('aria-label'), 'Отправить (2)');
    await click(f.host, '.fwd-send'); assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0].join(','), 'saved,ch');
  });
});
it('R171 тап по каналу share без выбора создаёт черновик канала без галочки и немедленной отправки', async () => {
  // Канал — полноценный адресат share, но не личный online-пользователь.
  await fixture(true, 'share', async f => {
    const channel = [...f.host.querySelectorAll<HTMLButtonElement>('.fwd-cell')].find(el => el.textContent?.includes('# общий'));
    assert.ok(!!channel); assert.equal(channel.getAttribute('role'), null);
    await React.act(async () => channel.click());
    assert.equal(f.drafts.length, 1); assert.equal(f.drafts[0], 'ch'); assert.equal(f.sends.length, 0);
    assert.equal(f.closes(), 1);
  });
});
for (const [name, anchor, replacement] of [
  ['тап не переключает', 'const gridOpen = pickOne ? pickSingle : share ? choose : toggle;', 'const gridOpen = pickOne ? pickSingle : share ? choose : () => {};'],
  ['защита повторной отправки снята', 'if (sent.current || pickedRef.current.length === 0) return;', 'if (pickedRef.current.length === 0) return;'],
  ['телефон игнорируется', 'const phone = usePhoneLayout();', 'const phone = false;'],
] as const) it(`R171 ${name} обнаруживается тем же сценарием пересылки`, async () => {
  // Мутант должен нарушить наблюдаемое поведение, не загрузку VM.
  await plain(); await assert.rejects(() => plain(mutate(source, anchor, replacement)), assert.AssertionError);
});

it('R171 снятие условности checkbox обнаруживается режимом выбора одного адресата', async () => {
  // PickOne — кнопка перехода, не ложный переключатель с состоянием выбранности.
  const check = (rawCells: string) => fixture(true, 'one', async f => {
    const cell = f.host.querySelector('.fwd-cell'); assert.ok(!!cell);
    assert.equal(cell.getAttribute('role'), null); assert.equal(cell.getAttribute('aria-checked'), null);
  }, source, rawCells);
  await check(cellsSource);
  await assert.rejects(() => check(mutate(cellsSource,
    "className={`fwd-cell${picked ? ' picked' : ''}`}\n      role={selecting ? 'checkbox' : undefined}",
    "className={`fwd-cell${picked ? ' picked' : ''}`}\n      role=\"checkbox\"")), assert.AssertionError);
});
it('R171 отпускание после удержания не снимает первую выбранную ячейку share', async () => {
  // Синтетический click после touchend обязан проглотиться ровно один раз.
  const check = (rawCells: string) => fixture(true, 'share', async f => {
    await f.hold('.fwd-cell');
    assert.equal(f.host.querySelector('.fwd-cell')?.getAttribute('aria-checked'), 'true');
    assert.equal(f.drafts.length, 0); assert.equal(f.closes(), 0);
  }, source, rawCells);
  await check(cellsSource);
  const anchor = "if (hold.current?.fired) {\n          hold.current = null;\n          return;\n        }\n        onOpen(id);";
  await assert.rejects(() => check(mutate(cellsSource, anchor, 'onOpen(id);')), assert.AssertionError);
});
