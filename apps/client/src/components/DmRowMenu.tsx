import { useCallback, useState, type ReactNode } from 'react';
import type { DmChannel } from '@gusvoice/shared';
import { confirmAction } from '../confirm';
import { serverArchive, serverChatClear, serverChatPrefs, serverPinOrder, serverPush4, serverUnreadMark } from '../convSyncRules';
import { notifyAlwaysAction } from '../notifyExceptionsRules';
import { archiveMenuLabel } from '../dmArchiveRules';
import { READ_ALL_CONFIRM_ABOVE, dmMuteOf, muteActive, muteLeftLabel, pinnedGroupIds, pinnedStep } from '../dmListRules';
import { reorderDmPins } from './DmPinDrag';
import { peerNameNow } from '../peerName';
import { useStore } from '../store';
import { toastError } from '../toast';
import { ContextMenu, MenuDivider, MenuItem, type MenuPos } from './ContextMenu';
import { clearHistories, clearHistory, deleteChat, deleteChats, deleteFormerGroup } from './dmClearActions';
import { plural } from '../dmRowRules';
import { Icon } from './Icon';
import { archiveDms } from './DmArchive';
import { DmMuteMenuItems, switchDmBlock, toggleDmPinned } from './DmChatView';
import { DmFolderMenuItems, FolderRemoveItem, toggleFolderPinned, useFoldersOn } from './DmFolderBar';

/** Открытое меню строки: беседа, точка (ПКМ / палец), уровень (`mute` — сроки «Выключить уведомления»), «сейчас» для сроков. */
type Target = { dm: DmChannel; pos: MenuPos; level: 'main' | 'mute' | 'folders'; now: number };

/**
 * «Прочитать все» (G04, 07.10, сервер `conv13`): все беседы с непрочитанным или пометкой читаются разом. Подтверждение —
 * только когда непрочитанных больше `READ_ALL_CONFIRM_ABOVE`, как у Telegram Desktop (`menu_mark_as_read.cpp`, 03·1.7.5); иначе — сразу.
 * Тексты окна — `lng_context_mark_read_all_sure` и `_2` («Это действие нельзя отменить»).
 */
export async function readAllDms(): Promise<void> {
  const sums = Object.values(useStore.getState().conv.summaries);
  const total = sums.reduce((n, s) => n + (s.unread > 0 ? s.unread : 0), 0);
  if (total > READ_ALL_CONFIRM_ABOVE) {
    const ok = await confirmAction({
      title: 'Прочитать все беседы?',
      body: 'Вы точно хотите пометить все беседы как прочитанные? Это действие нельзя отменить.',
      confirmLabel: 'Прочитать все',
    });
    if (!ok) return;
  }
  await useStore.getState().readAllConvs().catch(toastError);
}

/**
 * Меню над списком ЛС (G04, 07.10, `conv13`): правый клик (на телефоне — долгое нажатие, системное `contextmenu`) по
 * заголовку списка — «Прочитать все». У Telegram это меню вкладки-папки «Все чаты» (03·1.7.4–1.7.5): у нас список бесед
 * один, его заголовок и есть эта вкладка. Нечего читать — пункт серый. Возвращает открывалку и узел меню.
 */
export function useDmListMenu(): { openListMenu: (pos: MenuPos) => void; menu: ReactNode } {
  const [pos, setPos] = useState<MenuPos | null>(null);
  const on = useStore((s) => s.convActive && serverUnreadMark(s.serverFeatures));
  const anyUnread = useStore((s) => Object.values(s.conv.summaries).some((x) => x.unread > 0 || x.markedUnread === true));
  const close = useCallback(() => setPos(null), []);
  const openListMenu = useCallback((p: MenuPos) => setPos(p), []);
  const menu: ReactNode =
    pos && on ? (
      <ContextMenu pos={pos} onClose={close} width={232} fit>
        <MenuItem
          icon="checks"
          label="Прочитать все"
          disabled={!anyUnread}
          onClick={() => {
            close();
            void readAllDms();
          }}
        />
      </ContextMenu>
    ) : null;
  return { openListMenu, menu };
}

/**
 * Меню строки беседы в списке ЛС (07.10, #211, G01 темы 14 плейбука): ПКМ на ПК, удержание пальцем на телефоне (там
 * `ContextMenu` без якоря сам становится листом снизу). Пункты и порядок — как у Telegram Desktop (03·1.2): «Закрепить»,
 * «Выключить уведомления ▸» (второй уровень — сроки, `DmMuteMenuItems`) / «Включить уведомления» с остатком, «Заблокировать»,
 * «Пометить как прочитанное / непрочитанное» (`conv13`), «Очистить историю», «Удалить чат». Закреп и сроки — только при сервере
 * `conv11`, очистка и удаление — при `conv12`;
 * старый сервер — прежний переключатель «навсегда» и блокировка. Возвращает открывалку и узел меню (рисовать один раз).
 */
/**
 * Где можно менять порядок закреплённых из меню строки: `true` — общий порядок (архив или «Все чаты»), `false` — нельзя (своя
 * папка без `pinorder2`), объект — своя папка со своим порядком (09.10, `pinorder2`): её закреплённые сверху вниз.
 */
export type PinReorderScope = boolean | { folderId: string; ids: readonly string[]; own?: readonly string[] | null };

export function useDmRowMenu(reorderHere?: { readonly current: PinReorderScope }): { openDmMenu: (dm: DmChannel, pos: MenuPos) => void; menu: ReactNode } {
  const [target, setTarget] = useState<Target | null>(null);
  const prefsOn = useStore((s) => s.convActive && serverChatPrefs(s.serverFeatures));
  const clearOn = useStore((s) => s.convActive && serverChatClear(s.serverFeatures));
  const markOn = useStore((s) => s.convActive && serverUnreadMark(s.serverFeatures));
  const archiveOn = useStore((s) => s.convActive && serverArchive(s.serverFeatures));
  const pinOrderOn = useStore((s) => s.convActive && serverPinOrder(s.serverFeatures));
  const foldersOn = useFoldersOn();
  const blockedUsers = useStore((s) => s.blockedUsers);
  const mutedUsers = useStore((s) => s.pushMutedDmUsers);
  const muteUntil = useStore((s) => s.pushMuteUntil);
  // «Личные» / группы выключены (решение владельца 38, `push4`): «Включить уведомления» беседы — исключение, как Telegram.
  const push4 = useStore((s) => serverPush4(s.serverFeatures));
  const notifyDm = useStore((s) => s.user?.notifyDm);
  const notifyGroups = useStore((s) => s.user?.notifyGroups);
  const alwaysTargets = useStore((s) => s.pushAlwaysTargets);
  const close = useCallback(() => setTarget(null), []);
  const openDmMenu = useCallback(
    (dm: DmChannel, pos: MenuPos) => setTarget({ dm, pos, level: 'main', now: Date.now() }),
    [],
  );

  let menu: ReactNode = null;
  if (target) {
    const { dm, pos, now } = target;
    // Строка могла обновиться, пока меню открыто (событие сервера): закреп и заглушку — по свежей беседе из стора.
    const live = useStore.getState().dms.find((d) => d.id === dm.id) ?? dm;
    const mute = dmMuteOf(live, mutedUsers, muteUntil);
    const muted = muteActive(mute, now);
    const blocked = blockedUsers.some((u) => u.id === dm.otherUser.id);
    const alwaysAct = notifyAlwaysAction(dm.otherUser.id, { push4, notifyDm, notifyGroups, always: alwaysTargets });
    // Бывшая группа (`groups3`): закреп, архив, метки, очистка и заглушка у сервера — «нет такой»; остаётся «Удалить группу» (Telegram: у left-чата только удаление).
    const former = !!useStore.getState().conv.summaries[dm.id]?.former;
    /* Своя папка (ревью 09.10): без `pinorder2` порядок закреплённых там не ведётся — «Поднять выше / Опустить ниже» менял бы
       местами с беседой, которой в папке нет. С `pinorder2` (09.10) — шаг по закреплённым ЭТОЙ папки, порядок пишется в папку.
       `reorderHere` ставит список (`DmSidebar`). */
    const scope = reorderHere?.current ?? true;
    const pinFolder = typeof scope === 'object' ? scope.folderId : null;
    /* Своя папка со своим набором (`pinset1`, `own`): «Закрепить / Открепить» и шаги — по набору ЭТОЙ папки, общий закреп
       (`pinnedAt`) здесь не показывается и не меняется — как `pinned_peers` фильтра у Telegram. */
    const own = typeof scope === 'object' ? (scope.own ?? null) : null;
    const pinnedHere = own ? own.includes(dm.id) : !!live.pinnedAt;
    const pinGroup = !pinnedHere || scope === false ? [] : typeof scope === 'object' ? scope.ids : pinnedGroupIds(useStore.getState().dms, live.archived === true);
    const pinUp = pinnedStep(pinGroup, dm.id, -1);
    const pinDown = pinnedStep(pinGroup, dm.id, 1);
    const act = (fn: () => void) => () => {
      close();
      fn();
    };
    menu = (
      <ContextMenu pos={pos} onClose={close} width={target.level === 'main' ? 264 : 256} fit>
        {target.level === 'mute' ? (
          <DmMuteMenuItems peerId={dm.otherUser.id} mute={mute} now={now} onDone={close} />
        ) : target.level === 'folders' ? (
          <DmFolderMenuItems dm={live} muted={muted} onDone={close} />
        ) : former ? (
          <MenuItem icon="trash" label="Удалить группу" danger onClick={act(() => void deleteFormerGroup(dm))} />
        ) : (
          <>
            {/* «В архив» / «Вернуть из архива» — первым пунктом, как у Telegram Desktop (`Filler::addToggleArchive` стоит перед закрепом). */}
            {archiveOn && (
              <MenuItem
                icon={live.archived ? 'unarchive' : 'archive'}
                label={archiveMenuLabel(live.archived === true)}
                onClick={act(() => archiveDms([dm.id], live.archived !== true))}
              />
            )}
            {prefsOn && (
              <MenuItem
                icon={pinnedHere ? 'pin-off' : 'pin'}
                label={pinnedHere ? 'Открепить' : 'Закрепить'}
                onClick={act(() => (own && pinFolder ? toggleFolderPinned(pinFolder, dm.id, !pinnedHere) : toggleDmPinned(dm.id, !pinnedHere)))}
              />
            )}
            {/* Порядок закреплённых без мыши и пальца (08.10, `pinorder1`): у Telegram только перетаскивание — здесь ещё два
                пункта, чтобы порядок меняли клавиатурой и скринридером. Нет соседа в эту сторону — пункта нет. */}
            {pinOrderOn && pinnedHere && pinUp && (
              <MenuItem icon="chevron-up" label="Поднять выше" onClick={act(() => reorderDmPins(pinUp, pinFolder))} />
            )}
            {pinOrderOn && pinnedHere && pinDown && (
              <MenuItem icon="chevron-down" label="Опустить ниже" onClick={act(() => reorderDmPins(pinDown, pinFolder))} />
            )}
            {dm.saved ? null : alwaysAct ? (
              <MenuItem
                icon={alwaysAct === 'enable' ? 'bell' : 'bell-off'}
                label={alwaysAct === 'enable' ? 'Включить уведомления' : 'Выключить уведомления'}
                onClick={act(() => void useStore.getState().setPushAlways(dm.otherUser.id, alwaysAct === 'enable').catch(toastError))}
              />
            ) : muted ? (
              <MenuItem
                icon="bell"
                label="Включить уведомления"
                shortcut={(prefsOn && muteLeftLabel(mute, now)) || undefined}
                note
                onClick={act(() => void useStore.getState().setPushMuted('dm_user', dm.otherUser.id, false).catch(toastError))}
              />
            ) : prefsOn ? (
              <MenuItem
                icon="bell-off"
                label="Выключить уведомления"
                submenu
                onClick={() => setTarget({ ...target, level: 'mute' })}
              />
            ) : (
              <MenuItem
                icon="bell-off"
                label="Отключить уведомления"
                onClick={act(() => void useStore.getState().setPushMuted('dm_user', dm.otherUser.id, true).catch(toastError))}
              />
            )}
            {markOn &&
              ((live.unread ?? 0) > 0 || live.markedUnread === true ? (
                <MenuItem
                  icon="checks"
                  label="Пометить как прочитанное"
                  onClick={act(() => void useStore.getState().markConvRead(dm.id).catch(toastError))}
                />
              ) : (
                <MenuItem
                  icon="mail"
                  label="Пометить как непрочитанное"
                  onClick={act(() => void useStore.getState().setConvUnreadMark(dm.id, true).catch(toastError))}
                />
              ))}
            {/* Папки (G40, `folders1`): «Добавить в папку ▸» (`Filler::addToggleFolder`) и «Убрать из папки» открытой. */}
            {foldersOn && (
              <MenuItem icon="folder" label="Добавить в папку" submenu onClick={() => setTarget({ ...target, level: 'folders' })} />
            )}
            {foldersOn && <FolderRemoveItem dm={live} muted={muted} onDone={close} />}
            {/* «Избранное» (`saved1`): человека нет — ни заглушки, ни блокировки. */}
            {!dm.saved && (
              <MenuItem
                icon="ban"
                label={blocked ? 'Разблокировать' : 'Заблокировать'}
                danger={!blocked}
                onClick={act(() => void switchDmBlock(dm.otherUser, blocked))}
              />
            )}
            {clearOn && (
              <>
                <MenuDivider />
                <MenuItem icon="close" label="Очистить историю" onClick={act(() => void clearHistory(dm, peerNameNow))} />
                <MenuItem icon="trash" label="Удалить чат" danger onClick={act(() => void deleteChat(dm, peerNameNow))} />
              </>
            )}
          </>
        )}
      </ContextMenu>
    );
  }
  return { openDmMenu, menu };
}

/**
 * «Заблокировать» в режиме выбора бесед (Telegram Android `DialogsActivity`, действие `block`; окно —
 * `AlertsCreator.createBlockDialogAlert`, строки `BlockUserTitle` / `BlockUsers`): одно подтверждение на всю пачку. Одна
 * выбранная — обычное окно (`switchDmBlock`). `true` — подтверждено (вызывающий выходит из выбора).
 */
export async function blockDms(dms: readonly DmChannel[]): Promise<boolean> {
  if (dms.length === 0) return false;
  if (dms.length === 1) {
    await switchDmBlock(dms[0].otherUser, false);
    return true;
  }
  const n = dms.length;
  const ok = await confirmAction({
    title: `Заблокировать ${n} ${plural(n, 'собеседника', 'собеседников', 'собеседников')}?`,
    body: 'Они не узнают об этом. Новые сообщения и «печатает» из этих бесед до вас не дойдут — даже после разблокировки. Чтобы написать самим, разблокируйте.',
    tone: 'danger',
    confirmLabel: 'Заблокировать',
  });
  if (!ok) return false;
  for (const dm of dms) {
    const p = dm.otherUser;
    const user = { id: p.id, username: p.username, displayName: p.displayName, avatarUrl: p.avatarUrl };
    await useStore.getState().setBlocked(user, true).catch(toastError);
  }
  return true;
}

/**
 * Шапка режима выбора бесед на телефоне (07.10, G01) — по Telegram Android (`DialogsActivity.createActionMode`,
 * `updateCounters`): крестик, число выбранных, «Закрепить» / «Открепить», «Без звука» / «Со звуком», «Удалить» и «⋯» с
 * «Пометить как прочитанное / непрочитанное», «Очистить историю», «Заблокировать» (порядок пунктов Android: read, clear,
 * block; «Очистить» — только если сервер умеет, «Заблокировать» — как у Telegram (`cantBlockCount`) скрыт, если среди
 * выбранных есть уже заблокированный). Правила панели Telegram: закрепить — если среди выбранных есть незакреплённые
 * (закрепляются они), иначе открепить все; звук — если есть заглушённые, им включается звук, иначе все глушатся навсегда;
 * «прочитано» — если есть непрочитанные или помеченные, иначе «непрочитанное» всем. После действия выбор закрывается.
 * Архив (G41, `archive1`) — первая кнопка справа: «В архив» выбранных (или «Вернуть из архива», если все уже там).
 */
export function DmPickHead({
  ids,
  isMuted,
  onClose,
  pinIn = null,
}: {
  ids: readonly string[];
  isMuted: (dm: DmChannel) => boolean;
  onClose: () => void;
  /** Своя папка со своим набором закреплённых (09.10, `pinset1`): «Закрепить / Открепить» — только в ней, по её набору. */
  pinIn?: { folderId: string; own: readonly string[] } | null;
}) {
  const dms = useStore((s) => s.dms);
  const prefsOn = useStore((s) => s.convActive && serverChatPrefs(s.serverFeatures));
  const clearOn = useStore((s) => s.convActive && serverChatClear(s.serverFeatures));
  const markOn = useStore((s) => s.convActive && serverUnreadMark(s.serverFeatures));
  const archiveOn = useStore((s) => s.convActive && serverArchive(s.serverFeatures));
  const [moreAt, setMoreAt] = useState<MenuPos | null>(null);
  const picked = dms.filter((d) => ids.includes(d.id));
  const toPin = picked.filter((d) => (pinIn ? !pinIn.own.includes(d.id) : !d.pinnedAt));
  // В архив — если среди выбранных есть не в архиве (уходят они), иначе вернуть все (Android: действие `archive` / `unarchive`).
  const toArchive = picked.filter((d) => d.archived !== true);
  const muted = picked.filter(isMuted);
  const unreadOnes = picked.filter((d) => (d.unread ?? 0) > 0 || d.markedUnread === true);
  const st = () => useStore.getState();
  const run = (fn: () => void) => () => {
    setMoreAt(null);
    onClose();
    fn();
  };
  const archive = run(() => archiveDms(toArchive.length > 0 ? toArchive.map((d) => d.id) : picked.map((d) => d.id), toArchive.length > 0));
  const pin = run(() => {
    const list = toPin.length > 0 ? toPin : picked;
    const on = toPin.length > 0;
    // В своей папке — по одному, по очереди: каждый ответ сервера — весь список папок, параллельные затёрли бы друг друга.
    if (pinIn) void list.reduce<Promise<void>>((p, d) => p.then(() => toggleFolderPinned(pinIn.folderId, d.id, on)), Promise.resolve());
    else for (const d of list) toggleDmPinned(d.id, on);
  });
  const mute = run(() => {
    if (muted.length > 0) for (const d of muted) void st().setPushMuted('dm_user', d.otherUser.id, false).catch(toastError);
    else for (const d of picked) void st().setPushMuted('dm_user', d.otherUser.id, true).catch(toastError);
  });
  const read = run(() => {
    if (unreadOnes.length > 0) for (const d of unreadOnes) void st().markConvRead(d.id).catch(toastError);
    else for (const d of picked) void st().setConvUnreadMark(d.id, true).catch(toastError);
  });
  const del = () => {
    setMoreAt(null);
    void deleteChats(picked, peerNameNow).then((done) => done && onClose());
  };
  const clear = () => {
    setMoreAt(null);
    void clearHistories(picked, peerNameNow).then((done) => done && onClose());
  };
  const blockedUsers = useStore((s) => s.blockedUsers);
  const canBlock = picked.length > 0 && !picked.some((d) => blockedUsers.some((u) => u.id === d.otherUser.id));
  const block = () => {
    setMoreAt(null);
    void blockDms(picked).then((done) => done && onClose());
  };
  const n = picked.length;
  return (
    <div className="server-head dm-list-head dm-pick-head">
      <button type="button" className="head-icon" aria-label="Отменить выбор" title="Отменить выбор" onClick={onClose}>
        <Icon name="close" size={20} />
      </button>
      <strong aria-live="polite">{n}</strong>
      <div className="dm-pick-acts">
        {archiveOn && (
          <button
            type="button"
            className="head-icon"
            aria-label={archiveMenuLabel(toArchive.length === 0)}
            title={archiveMenuLabel(toArchive.length === 0)}
            onClick={archive}
          >
            <Icon name={toArchive.length > 0 ? 'archive' : 'unarchive'} size={20} />
          </button>
        )}
        {prefsOn && (
          <button
            type="button"
            className="head-icon"
            aria-label={toPin.length > 0 ? 'Закрепить' : 'Открепить'}
            title={toPin.length > 0 ? 'Закрепить' : 'Открепить'}
            onClick={pin}
          >
            <Icon name={toPin.length > 0 ? 'pin' : 'pin-off'} size={20} />
          </button>
        )}
        <button
          type="button"
          className="head-icon"
          aria-label={muted.length > 0 ? 'Включить уведомления' : 'Выключить уведомления'}
          title={muted.length > 0 ? 'Включить уведомления' : 'Выключить уведомления'}
          onClick={mute}
        >
          <Icon name={muted.length > 0 ? 'bell' : 'bell-off'} size={20} />
        </button>
        {clearOn && (
          <button type="button" className="head-icon" aria-label="Удалить" title="Удалить" onClick={del}>
            <Icon name="trash" size={20} />
          </button>
        )}
        {markOn && (
          <button
            type="button"
            className="head-icon"
            aria-label="Ещё"
            title="Ещё"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMoreAt({ x: r.right, y: r.bottom });
            }}
          >
            <Icon name="more" size={20} />
          </button>
        )}
      </div>
      {moreAt && (
        <ContextMenu pos={moreAt} onClose={() => setMoreAt(null)} width={264} fit>
          {unreadOnes.length > 0 ? (
            <MenuItem icon="checks" label="Пометить как прочитанное" onClick={read} />
          ) : (
            <MenuItem icon="mail" label="Пометить как непрочитанное" onClick={read} />
          )}
          {clearOn && <MenuItem icon="close" label="Очистить историю" onClick={clear} />}
          {canBlock && <MenuItem icon="ban" label="Заблокировать" danger onClick={block} />}
        </ContextMenu>
      )}
    </div>
  );
}
