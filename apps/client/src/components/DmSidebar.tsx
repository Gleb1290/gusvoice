import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { ConvMute, ConvSummary, DmChannel, RemoteUserHit, UserSearchHit } from '@gusvoice/shared';
import { api } from '../api';
import { isMobile, isTauri } from '../hotkeys';
import { useStore } from '../store';
import { useVisibleOnline } from '../dmOnline';
import { useContactSeen } from '../useContactSeen';
import { toast, toastError } from '../toast';
import { useDialogChrome } from '../dialogChrome';
import {
  dmBlockText,
  dmComposeCandidates,
  dmComposeHint,
  DM_SERVER_UPDATE_TEXT,
  dmEmptyHint,
  dmNeedsServerUpdate,
  dmSearchHits,
  dmRemoteQuery,
  remoteHandle,
  serverFedDm,
  serverSearchesUsers,
  USER_SEARCH_DELAY_MS,
  userSearchQuery,
  type DmCandidate,
  type DmSearchState,
} from '../dmRules';
import { isFeedOnScreen } from '../channelRules';
import { isTypingKey } from '../chatKeysRules';
import { peerReadKeyOf, SAVED_NAME, serverArchive, serverGlobalSearch, serverGroups, serverFrequent, serverFrequentHide, serverPinOrder, serverSaved, serverServersSearch } from '../convSyncRules';
import { archivedOnly, archiveUnreadChats, withoutArchived } from '../dmArchiveRules';
import { closeDmCompose, openDmCompose, useDmCompose } from '../dmCompose';
import { byRecent, DM_ROW_HOLD_MS, DM_ROW_HOLD_SLOP, dmMuteOf, muteActive, nextMuteExpiry } from '../dmListRules';
import {
  dmRowLabel,
  dmRowPreview,
  dmRowStatus,
  dmRowTime,
  matchDmName,
  matchDmUsername,
  rowActivityAt,
  rowShowsDraft,
} from '../dmRowRules';
import { usePhoneLayout } from '../phoneLayout';
import { typingActionLabel, useTyping, useTypingAction } from '../typing';
import { pushBackHandler } from '../androidBack';
import { CONN_TEXT, connLabel, useConnState } from '../connState';
import { Avatar } from './Avatar';
import { contactLabel, contactMatches, serverContacts, sortContacts } from '../contactRules';
import { useContactList } from '../contacts';
import { dmPeerLabel, usePeerName } from '../peerName';
import { SavedAvatar } from './SavedAvatar';
import { GroupDialogHost, openNewGroup } from './GroupDialogs';
import { chatReadKeyOf, groupPreviewAuthor, groupTypingLabel, typingNames } from '../groupChatRules';
import { DmPickHead, useDmListMenu, useDmRowMenu, type PinReorderScope } from './DmRowMenu';
import { useDmFolderUi } from './DmFolderBar';
import { folderOwnPinRows, folderPinnedRows } from '../dmFolderView';
import { useDmFolders } from '../dmFolders';
import { rowMarks } from '../cornerButtonsRules';
import {
  hasChips,
  phoneSearchTabsShown,
  scopeView,
  searchButtonShown,
  searchFieldAlpha,
  type PhoneSearchTab,
  type SearchChips,
  type SearchScope,
} from '../dmListSearchRules';
import { DmSearchScopes, openServerHit, ServerMessageHits } from './DmServerSearch';
// Вкладки поиска на телефоне (`DmSearchKinds.tsx`) — через `DmAllSearch`: одна граница «результаты поиска» у списка.
import { AllMessageHits, DmKindHits, DmSearchTabs } from './DmAllSearch';
import { DmMessageHits, DmSearchChips, DmSearchHome, openSearchHit, useFrequent, useFrequentHidden, useRecentSearches } from './DmListSearch';
import { DmArchiveHead, DmArchiveRow, useArchiveCollapsed } from './DmArchive';
import { DRAG_MSG_MIME, hasMsgDrag, parseMsgDrag, requestForwardDrop, type MsgDragPayload } from '../dragOut';
import { DM_ROW_AVA, useListLines } from '../dmListView';
/** Аватар строки на телефоне, px: Telegram Android `DialogCell` в обычной раскладке — 52 (`DialogCell.java:2467`; 56 — «три строки»).
 * Своя константа, а не из `dmListView`: тесты подменяют тот модуль целиком. Та же цифра — в `DmArchive.tsx`. */
const DM_ROW_AVA_PHONE = 52;
/** Точка «в сети» на аватаре строки, телефон, px: Telegram `DialogCell.java:5077` — круг радиусом 5 dp в обводке 2 dp (радиус 7), центр на 6 dp левее
 * правого и 8 dp выше нижнего края аватара (`:5068-5073`); положение — `.app.m-list .dm-row .mp-dot-wrap` в `styles.css`. */
const DM_ONLINE_DOT_PHONE = 10;
import { setNarrowAllowed, useSidebarNarrow } from '../uiPrefs';
import { CHOOSE_BY_DRAG_MS, dragMoved, hasFilesDrag, requestFilesDrop } from '../filesDrop';
import { useDmListSwipe, useSwipeCaps, useSwipeSetting } from './DmListSwipe';
import { useDmPinDrag } from './DmPinDrag';
import { effectiveSwipe } from '../chatSwipe';
import { BottomSheet } from './BottomSheet';
import { Goose } from './Goose';
import { Icon } from './Icon';
import { SelfVoiceBar } from './SelfVoiceBar';
import { SettingsSearch } from './SettingsShell';
import { SharedMediaHost } from './SharedMedia';
import { StatusDot } from './StatusDot';
import { VoicePanel } from './VoicePanel';
import { useVoiceDraftKeys } from '../voiceDrafts';

interface DmRowProps {
  dm: DmChannel;
  /** Сводка беседы (режим бесед): превью, ✓ / ✓✓. Нет её (ещё не пришла) — строка без превью и отметок. */
  summary: ConvSummary | undefined;
  meId: string | undefined;
  online: boolean;
  /** Открытая беседа (ПК) — подсветка строки (`.active`, `aria-current`). */
  active: boolean;
  unread: boolean;
  unreadN: number;
  /** Мой черновик в этой беседе (Р7). */
  draft: string | undefined;
  /** В своей очереди есть «не отправлено» — красный «!» вместо ✓ / ✓✓ перед временем; счётчик остаётся на своём месте. */
  failed: boolean;
  /** Уведомления выключены (07.10, G03): значок «без звука» у имени, счётчик серый. */
  muted?: boolean;
  /** Серый счётчик без значка «без звука» (07.10, G41): беседа в архиве — у Telegram там счётчики серые (`adjustBadgesStateByFolder`). */
  grayBadge?: boolean;
  /** Закреплена наверху списка (07.10, G02): булавка на месте счётчика, когда счётчика нет (как Telegram на ПК). */
  pinned?: boolean;
  /** Запрос поиска — совпадение в имени медовым. */
  query: string;
  phone: boolean;
  /**
   * Показывать «печатает» (по умолчанию да — боковая панель). Окно «Переслать в…» (раунд 12, `ForwardPicker.tsx`) берёт
   * ту же строку, но без «печатает»: там выбирают, кому уйдёт сообщение, а за набором не следят.
   */
  showTyping?: boolean;
  onOpen: (id: string) => void;
  /**
   * Меню строки (07.10, G01): ПКМ, клавиша меню и удержание пальцем (`ROW_HOLD_MS`). Нет — строка без меню (выбор в
   * `ForwardPicker`).
   */
  onMenu?: (dm: DmChannel, pos: { x: number; y: number }) => void;
  /** Roving tabindex списка (07.10, G14): `0` — строка, на которую встаёт Tab; остальные `-1`. Нет — обычная кнопка. */
  tabIndex?: number;
  /** Строка получила фокус (07.10, G14) — список запоминает её для roving tabindex. */
  onFocusRow?: (id: string) => void;
  /** Время моего черновика (сводка сервера, `draft.at`): по нему черновик поднимает беседу и прячется за новым (G34). */
  draftAt?: string | null;
  /** Черновик — ответ на сообщение: значок ответа перед «Черновик:» (G34; Telegram Desktop `dialogsMiniReplyIcon`). */
  draftReply?: boolean;
  /**
   * Выбор нескольких бесед на телефоне (07.10, G01; Telegram Android `DialogsActivity.onItemLongClick`): удержание строки
   * (не аватара) входит в выбор / переключает строку. Нет — удержание открывает меню, как раньше.
   */
  onPick?: (id: string) => void;
  /** Режим выбора включён: тап переключает строку, а не открывает беседу; удержание — тоже переключает. */
  selecting?: boolean;
  /** Строка выбрана: галочка на аватаре и подсветка (`.picked`, `aria-checked`). */
  picked?: boolean;
  /**
   * Бросок сообщений на строку (08.10, G76; Telegram Desktop `DialogsInner::dropEvent`): сообщения из ленты, перетащенные мышью, —
   * пересылка в эту беседу. Нет — строка бросок не принимает (выбор в `ForwardPicker`).
   */
  onDropMsgs?: (dm: DmChannel, p: MsgDragPayload) => void;
  /** Файлы из проводника брошены на строку (G37): открыть беседу и показать окно отправки. */
  onDropFiles?: (dm: DmChannel, files: File[]) => void;
}

/**
 * Часы заглушек (07.10, G03): «сейчас» для `muteActive`, которое само сдвигается к ближайшему концу срока — значок «без
 * звука» и серый счётчик снимаются вовремя без опроса. Общие для списка (`DmSidebar`) и шапки беседы (`DmChatView`).
 */
export function useMuteClock(mutes: readonly (ConvMute | null | undefined)[]): number {
  const [now, setNow] = useState(() => Date.now());
  const next = nextMuteExpiry(mutes, Date.now());
  useEffect(() => {
    if (next === null) return;
    // setTimeout держит не больше 2^31−1 мс (~24,8 сут): дальний срок — промежуточным пробуждением.
    const t = setTimeout(() => setNow(Date.now()), Math.min(Math.max(next - Date.now(), 0) + 250, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [next]);
  return Math.max(now, Date.now());
}

/**
 * Строка беседы (раунд 11, `docs/design/design-step11/HANDOFF.md` §2): аватар с точкой «в сети», имя, ✓ / ✓✓ перед
 * временем (при неотправленном — красный «!» на их месте), превью (печатает → черновик → последнее сообщение), счётчик
 * или точка непрочитанного. Что писать — правила `dmRowRules.ts`; вид — блок «Раунд 11» в `styles.css`. Экспортирована
 * для окна «Переслать в…» (раунд 12): те же строки, а не копия разметки.
 */
/** Удержание пальцем на строке беседы до меню (07.10, G01) — как удержание пузыря в ленте (`MessagePane`, 480 мс). */
const ROW_HOLD_MS = DM_ROW_HOLD_MS;
/** Сдвиг пальца дальше этого — прокрутка списка, не удержание (как `TOUCH_SLOP` у `ContextMenu`). */
const ROW_HOLD_SLOP = DM_ROW_HOLD_SLOP;

export const DmRow = memo(function DmRow({
  dm,
  summary,
  meId,
  online,
  active,
  unread,
  unreadN,
  draft,
  failed,
  muted = false,
  grayBadge = false,
  pinned = false,
  query,
  phone,
  showTyping = true,
  onOpen,
  onMenu,
  tabIndex,
  onFocusRow,
  draftAt = null,
  draftReply = false,
  onPick,
  selecting = false,
  picked = false,
  onDropMsgs,
  onDropFiles,
}: DmRowProps) {
  /* Бросок сообщений (G76): над строкой — подсветка, `dragenter` / `dragleave` приходят и от дочерних узлов, поэтому счётчик. */
  const [dropOn, setDropOn] = useState(false);
  const dropDepth = useRef(0);
  /* Файлы из проводника на строку (G37): отсчёт «постоял секунду — открыть беседу» и последняя точка мыши. */
  const chooseTimer = useRef<number | null>(null);
  const dragAt = useRef<{ x: number; y: number } | null>(null);
  const stopChoose = () => {
    if (chooseTimer.current != null) window.clearTimeout(chooseTimer.current);
    chooseTimer.current = null;
    dragAt.current = null;
  };
  useEffect(() => stopChoose, []);
  const takesDrag = (types: ReadonlyArray<string>) => (!!onDropMsgs && hasMsgDrag(types)) || (!!onDropFiles && hasFilesDrag(types));
  /* «Только аватары» (G34): имени в строке нет — оно в подсказке при наведении (tdesktop показывает его в `ImportantTooltip`). */
  const narrow = useSidebarNarrow() && !phone;
  /* Удержание пальцем (07.10, G01): своё — таймер `ROW_HOLD_MS` без сдвига дальше `ROW_HOLD_SLOP`; системное долгое
     нажатие Android (`contextmenu`) — тоже меню, кто первый. Сработавшее удержание глотает щелчок отпускания; новое касание
     метку сбрасывает (если щелчка после удержания не было, следующий тап не потеряется). */
  const hold = useRef<{ timer: number | null; x: number; y: number; fired: boolean; ava: boolean } | null>(null);
  const holdStop = () => {
    const h = hold.current;
    if (h?.timer != null) window.clearTimeout(h.timer);
    if (h) h.timer = null;
  };
  /* Telegram Android (`DialogsActivity.onItemLongClick`): удержание аватара — просмотр беседы с меню (у нас — меню строки),
     удержание остальной строки — выбор; в режиме выбора любое удержание переключает строку. */
  const holdFire = (x: number, y: number) => {
    const h = hold.current;
    holdStop();
    if (h) h.fired = true;
    navigator.vibrate?.(8);
    if (onPick && (selecting || !h?.ava)) onPick(dm.id);
    else onMenu?.(dm, { x, y });
  };
  const holdable = !!(onMenu || onPick);
  // «печатает» — событие шлюза `typing` с `dmId` (`typing.ts`, гаснет через 5 с). Хук зовётся и при `showTyping={false}`:
  // число хуков не должно зависеть от пропса, — выключенный ответ просто не читается.
  const directTyping = useTyping(dm.id).includes(dm.otherUser.id);
  // Группа (07.10, `groups1`): «печатает» любого участника — «Имя печатает» / «Имя и Имя печатают» (`groupChatRules`).
  const typers = useTyping(dm.id);
  const peerTyping = dm.group ? typers.length > 0 : directTyping;
  const typing = showTyping && peerTyping;
  const actionLabel = typingActionLabel(useTypingAction(dm.id, dm.otherUser.id)); // G21: вид действия (хук всегда)
  // Подпись контакта вместо имени (решение владельца 08.10 п.27, `peerName.ts`): строка, «печатает», автор в группе.
  const nameOf = usePeerName();
  const typingLabel = dm.group ? groupTypingLabel(typingNames(dm.group, typers, nameOf)) : actionLabel;
  const name = dmPeerLabel(dm, nameOf);
  const match = query ? matchDmName(name, query) : null;
  const last = summary?.lastMessage ?? null;
  // Черновик прячется за новым непрочитанным сообщением и поднимает беседу своим временем (G34, Telegram Android `DialogCell`).
  const draftShown = !!draft && rowShowsDraft({ draftAt, lastAt: dm.lastMessageAt, unread: unread || unreadN > 0 });
  const preview = dmRowPreview({ typing, draft: draftShown ? draft : null, last, meId });
  // Служебная запись группы (`groups1`) — без отметок ✓ / ✓✓, как у Telegram.
  const status = last?.service || last?.call || dm.saved ? null : dmRowStatus({ last, meId, peerReadKey: summary?.group ? chatReadKeyOf(summary) : peerReadKeyOf(summary), preview });
  const when = dmRowTime(
    preview.kind === 'draft'
      ? rowActivityAt({ lastMessageAt: dm.lastMessageAt, createdAt: dm.createdAt, draftAt })
      : dm.lastMessageAt,
  );
  // Значок «переслано» и мини-превью фото — только у последнего сообщения (не у черновика и не у «печатает»).
  const fwd = (preview.kind === 'attachment' || preview.kind === 'text') && last?.forwarded === true;
  // Группа: «Имя:» / «Вы:» перед текстом последнего (Telegram `DialogCell`), у служебной записи — нет.
  const from = dm.group && (preview.kind === 'attachment' || preview.kind === 'text') ? groupPreviewAuthor(last, meId, nameOf) : null;
  const fromLine = from ? <span className="dm-from">{from}: </span> : null;
  const thumb =
    preview.kind === 'attachment' && last?.attachmentKind === 'photo' && typeof last.thumb === 'string' ? last.thumb : null;
  const thumbSpoiler = last?.thumbSpoiler === true;
  // Э3 (#141): миниатюра — ссылка сервера; вложение с соседнего инстанса может ещё копироваться (503) — тогда значок вида, как без миниатюры.
  const [badThumb, setBadThumb] = useState<string | null>(null);
  const label0 = dmRowLabel({
    name,
    online,
    preview,
    mine: !!meId && last?.authorId === meId,
    time: when?.label ?? null,
    status,
    unread: unreadN > 0 ? unreadN : unread ? 'dot' : 0,
    failed,
  });
  const marks = rowMarks(dm);
  const label = `${label0}${marks.reactions ? ', новая реакция' : ''}${marks.mentions ? ', вас упомянули' : ''}${pinned ? ', закреплена' : ''}${muted ? ', без звука' : ''}${fwd ? ', переслано' : ''}`;
  const tail = (
    <>
        {unreadN > 0 ? (
          // Число, как в списке каналов. Точка остаётся страховкой: флаг непрочитанного и счётчик приходят из разных мест
          // (сокет и загрузка списка), и рисовать пустую пилюлю на рассинхроне хуже, чем показать точку.
          <span className={`dm-badge${muted || grayBadge ? ' muted' : ''}`}>{unreadN > 99 ? '99+' : unreadN}</span>
        ) : unread ? (
          <span className={`dm-badge dot${muted || grayBadge ? ' muted' : ''}`} />
        ) : pinned ? (
          // Закреп (07.10, G02): булавка на месте счётчика, только когда счётчика нет — как у Telegram на ПК (03·1.1.12).
          <span className="dm-pin">
            <Icon name="pin" size={14} stroke={1.5} title="Закреплена" />
          </span>
        ) : null}
    </>
  );
  return (
    <button
      type="button"
      data-swipe-row={dm.id}
      className={`dm-row${unread ? ' unread' : ''}${unread || unreadN > 0 || pinned || marks.reactions || marks.mentions ? ' has-tail' : ''}${failed ? ' failed' : ''}${active ? ' active' : ''}${picked ? ' picked' : ''}${dropOn ? ' drop-msgs' : ''}`}
      aria-current={active ? 'true' : undefined}
      role={selecting ? 'checkbox' : undefined}
      aria-checked={selecting ? picked : undefined}
      aria-label={label}
      title={narrow ? name : undefined}
      tabIndex={tabIndex}
      onFocus={onFocusRow ? () => onFocusRow(dm.id) : undefined}
      onDragEnter={
        onDropMsgs || onDropFiles
          ? (e) => {
              if (!takesDrag(e.dataTransfer.types)) return;
              dropDepth.current += 1;
              setDropOn(true);
            }
          : undefined
      }
      onDragOver={
        onDropMsgs || onDropFiles
          ? (e) => {
              if (!takesDrag(e.dataTransfer.types)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              /* Файлы из проводника: мышь постояла над строкой секунду — беседа открывается (tdesktop `ChoosePeerByDragTimeout`),
                 и файлы можно бросить прямо в ленту. Сдвиг мыши начинает отсчёт заново. */
              if (onDropFiles && hasFilesDrag(e.dataTransfer.types) && !active && dragMoved(dragAt.current, e.clientX, e.clientY)) {
                dragAt.current = { x: e.clientX, y: e.clientY };
                if (chooseTimer.current != null) window.clearTimeout(chooseTimer.current);
                chooseTimer.current = window.setTimeout(() => onOpen(dm.id), CHOOSE_BY_DRAG_MS);
              }
            }
          : undefined
      }
      onDragLeave={
        onDropMsgs || onDropFiles
          ? (e) => {
              if (!takesDrag(e.dataTransfer.types)) return;
              dropDepth.current = Math.max(0, dropDepth.current - 1);
              if (dropDepth.current === 0) {
                setDropOn(false);
                stopChoose();
              }
            }
          : undefined
      }
      onDrop={
        onDropMsgs || onDropFiles
          ? (e) => {
              if (!takesDrag(e.dataTransfer.types)) return;
              e.preventDefault();
              dropDepth.current = 0;
              setDropOn(false);
              stopChoose();
              if (hasMsgDrag(e.dataTransfer.types)) {
                const p = parseMsgDrag(e.dataTransfer.getData(DRAG_MSG_MIME));
                if (p) onDropMsgs?.(dm, p);
              } else {
                /* Файлы — копией списка сразу: `dataTransfer.files` живёт только внутри обработчика. */
                const files = Array.from(e.dataTransfer.files);
                if (files.length) onDropFiles?.(dm, files);
              }
            }
          : undefined
      }
      onClick={() => {
        if (hold.current?.fired) {
          hold.current = null;
          return;
        }
        if (selecting && onPick) return onPick(dm.id);
        onOpen(dm.id);
      }}
      onContextMenu={
        holdable
          ? (e) => {
              e.preventDefault();
              if (hold.current?.fired) return;
              const h = hold.current;
              if (h) return holdFire(h.x, h.y);
              if (!onMenu || selecting) return;
              // Клавиша меню / Shift+F10 — у строки, а не в углу окна.
              if (e.clientX === 0 && e.clientY === 0) {
                const r = e.currentTarget.getBoundingClientRect();
                onMenu(dm, { x: r.left + 24, y: r.bottom - 4 });
              } else onMenu(dm, { x: e.clientX, y: e.clientY });
            }
          : undefined
      }
      onTouchStart={
        holdable
          ? (e) => {
              holdStop();
              hold.current = null;
              if (e.touches.length !== 1) return;
              const t = e.touches[0];
              const ava = !!(e.target as Element | null)?.closest?.('.dm-ava');
              const h = { timer: null as number | null, x: t.clientX, y: t.clientY, fired: false, ava };
              hold.current = h;
              h.timer = window.setTimeout(() => holdFire(h.x, h.y), ROW_HOLD_MS);
            }
          : undefined
      }
      onTouchMove={
        holdable
          ? (e) => {
              const h = hold.current;
              const t = e.touches[0];
              if (!h || h.fired || !t) return;
              if (Math.abs(t.clientX - h.x) > ROW_HOLD_SLOP || Math.abs(t.clientY - h.y) > ROW_HOLD_SLOP) {
                holdStop();
                hold.current = null;
              }
            }
          : undefined
      }
      onTouchEnd={
        holdable
          ? (e) => {
              holdStop();
              // Удержание сработало — отпускание не должно стать щелчком мыши: иначе он придёт в подложку листа и закроет меню.
              if (hold.current?.fired && e.cancelable) e.preventDefault();
            }
          : undefined
      }
      onTouchCancel={holdable ? holdStop : undefined}
    >
      <span className="dm-ava">
        {dm.saved ? <SavedAvatar size={phone ? DM_ROW_AVA_PHONE : DM_ROW_AVA} /> : <Avatar name={name} url={dm.otherUser.avatarUrl} size={phone ? DM_ROW_AVA_PHONE : DM_ROW_AVA} />}
        {online && (
          /* Обводка точки — цветом фона строки: `currentColor`, а `color` обёртки стили называют рядом с фоном в каждом
             состоянии строки (блок «Раунд 11» в `styles.css`; своей переменной под фон нет с 05.10). */
          <span className="mp-dot-wrap">
            <StatusDot status="online" size={phone ? DM_ONLINE_DOT_PHONE : 12} ringColor="currentColor" />
          </span>
        )}
        {/* Выбор (G01): галочка в углу аватара — Telegram Android `DialogCell.checkBox` (CheckBox2 справа внизу аватара). */}
        {selecting && picked && (
          <span className="dm-pick">
            <span className="sel-check on">
              <Icon name="check" size={12} stroke={3} />
            </span>
          </span>
        )}
      </span>
      {/* Имя и значки рядом (07.10): «без звука» — у имени, как у Telegram на телефоне (03·1.1.13); имя уступает ему место. */}
      <span className="dm-name">
        <span className="dm-name-text">
          {match?.hit ? (
            <>
              {match.before}
              <mark className="dm-hit">{match.hit}</mark>
              {match.after}
            </>
          ) : (
            name
          )}
        </span>
        {muted && (
          <span className="dm-flag">
            <Icon name="bell-off" size={12} stroke={1.75} title="Уведомления выключены" />
          </span>
        )}
      </span>
      <span className="dm-when">
        {failed ? (
          /* «!» встаёт на место отметки (поправка владельца после стенда, 04.10) — как у Telegram: красный значок рядом
             со временем, а число непрочитанного остаётся своим местом внизу справа. Вместо ✓ / ✓✓ ВСЕГДА, и когда
             последнее сообщение чужое: неотправленное лежит в очереди беседы, а не у последнего сообщения списка. */
          <span className="dm-st failed">
            <Icon name="alert-circle" size={14} stroke={1.5} title="Не отправлено" />
          </span>
        ) : (
          status && (
            <span className={`dm-st ${status}`}>
              <Icon
                name={status === 'read' ? 'checks' : 'check'}
                size={14}
                stroke={1.5}
                title={status === 'read' ? 'Прочитано' : 'Отправлено'}
              />
            </span>
          )
        )}
        {when && (
          <time className="dm-time" dateTime={when.dateTime}>
            {when.label}
          </time>
        )}
      </span>
      {preview.kind === 'typing' ? (
        <span className="dm-preview dm-typing">
          <span className="typing-dots">
            <span />
            <span />
            <span />
          </span>
          {typingLabel}
        </span>
      ) : preview.kind === 'draft' ? (
        <span className="dm-preview">
          {draftReply && (
            <span className="dm-att dm-draft">
              <Icon name="reply" size={14} title="Ответ" />
            </span>
          )}
          <span className="dm-draft">Черновик:</span> {preview.text}
        </span>
      ) : preview.kind === 'attachment' ? (
        <span className="dm-preview">
          {fromLine}
          {fwd && (
            <span className="dm-att">
              <Icon name="forward" size={14} title="Переслано" />
            </span>
          )}
          {thumb && thumb !== badThumb ? (
            /* Мини-превью фото (G34): Telegram Android `DialogCell.thumbImage` — 18 dp, скругление 2 dp, перед текстом. */
            <img className={thumbSpoiler ? 'dm-thumb spoiled-thumb' : 'dm-thumb'} src={thumb} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBadThumb(thumb)} />
          ) : (
            <span className="dm-att">
              <Icon name={preview.icon} size={14} />
            </span>
          )}
          {preview.label}
        </span>
      ) : (
        // Последнего сообщения нет (пустая беседа, старый путь без сводок) — строка всё равно в две линии.
        <span className="dm-preview">
          {fromLine}
          {fwd && (
            <span className="dm-att">
              <Icon name="forward" size={14} title="Переслано" />
            </span>
          )}
          {preview.kind === 'text' ? preview.text : ' '}</span>
      )}
      {/* Реакция на моё сообщение / упоминание «зажигает» строку (G24; tdesktop `dialogs_layout.cpp`: кружок акцентного цвета со
          значком рядом со счётчиком; в беседе без звука — серый, как счётчик). Кружки и счётчик делят одну ячейку сетки. */}
      {marks.reactions || marks.mentions ? (
        <span className="dm-marks">
          {marks.mentions && (
            <span className={`dm-mark${muted || grayBadge ? ' muted' : ''}`} title="Непрочитанное упоминание">
              <Icon name="at" size={12} stroke={2.2} />
            </span>
          )}
          {marks.reactions && (
            <span className={`dm-mark react${muted || grayBadge ? ' muted' : ''}`} title="Непрочитанная реакция">
              <Icon name="heart" size={12} stroke={2} />
            </span>
          )}
          {tail}
        </span>
      ) : (
        tail
      )}
    </button>
  );
});

/**
 * «Написать» на ПК — окно по центру, как остальные окна ПК (`.modal-overlay` > `.modal.dm-compose`). Лист снизу
 * (`BottomSheet`) сделан для телефона: на ПК он растягивался на всю ширину окна (1280 px). Esc, возврат фокуса на кнопку,
 * с которой открыли, — `useDialogChrome`; щелчок мимо окна закрывает.
 */
function ComposeDialog({
  inputRef,
  children,
  title = 'Написать',
  onClose = closeDmCompose,
}: {
  inputRef: RefObject<HTMLInputElement>;
  children: ReactNode;
  /** Выбор контакта для карточки (G69, `ContactPickSheet`): свой заголовок и своё закрытие. */
  title?: string;
  onClose?: () => void;
}) {
  const dialogRef = useDialogChrome<HTMLDivElement>(onClose);
  // `useDialogChrome` ставит фокус на само окно (точка входа для читалок), а человеку сразу печатать — курсор в поле.
  // Эффект стоит ПОСЛЕ хука и потому выполняется после него: последнее слово за полем.
  useEffect(() => {
    inputRef.current?.focus();
  }, [inputRef]);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal dm-compose"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dm-compose-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="dm-compose-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

/**
 * «Написать» — кому написать: участники открытого сервера и собеседники существующих бесед (`dmComposeCandidates`: в сторе
 * ростер только открытого сервера, поэтому без бесед в сессии, где сервер не открывали, список был бы пуст). Телефон —
 * лист снизу, ПК — окно по центру (`ComposeDialog`), разметка одна. `initialQuery` — запрос из «ничего не нашлось».
 * С сервером `users1` (05.10) набранное @имя ищется ещё и среди всех людей инстанса (`api.searchUsers`: пауза
 * `USER_SEARCH_DELAY_MS`, опоздавший ответ отбрасывается по номеру запроса) — найденные блоком «На этом инстансе» под
 * своими; пустое окно учит «Введите @имя» (`dmComposeHint`).
 */
function NewDmSheet({ initialQuery, pick }: { initialQuery: string; pick?: ContactPick }) {
  const phone = usePhoneLayout();
  // Выбор контакта для карточки (G69): тот же список, но нажатие — выбор человека, а не беседа с ним.
  const close = pick ? pick.onClose : closeDmCompose;
  const members = useStore((s) => s.members);
  const dms = useStore((s) => s.dms);
  // Гость ли я сам — от этого зависит каждый клик «написать» (§5.8).
  const me = useStore((s) => s.user);
  const openDmWith = useStore((s) => s.openDmWith);
  const openDmRemote = useStore((s) => s.openDmRemote);
  // Гостю искать незачем: личка с ним закрыта, и сервер ему не ответит (`requireLocalUser`).
  const searchOn = useStore((s) => serverSearchesUsers(s.serverFeatures)) && !me?.homeInstance;
  const groupsOn = useStore((s) => s.convActive && serverGroups(s.serverFeatures)) && !me?.homeInstance;
  // «Избранное» (`saved1`): строка в «Написать» — для телефона, где нет Ctrl+0.
  const savedOn = useStore((s) => s.convActive && serverSaved(s.serverFeatures)) && !me?.homeInstance;
  const openSaved = useStore((s) => s.openSaved);
  const [query, setQuery] = useState(initialQuery);
  const [hits, setHits] = useState<UserSearchHit[]>([]);
  // Э1 (`fedm1`): люди связанных инстансов из кеша каталога (`UserSearchResponse.remote`).
  const [remote, setRemote] = useState<RemoteUserHit[]>([]);
  const [search, setSearch] = useState<DmSearchState | null>(null);
  // Номер запроса поиска (как у `JoinServerModal`): ответ на прошлый ввод, догнавший нас после следующего, показал бы не
  // тех людей — человек в этот момент уже набрал другое имя.
  const round = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Контакты (08.10, `contacts1`): «Написать» — это и список контактов, как экран «Новое сообщение» Telegram Android
  // (`ContactsActivity`: «Новая группа», затем контакты; Desktop — окно «Контакты» с поиском). Сверху, кто в сети, дальше по имени.
  const contactsOn = useStore((s) => serverContacts(s.serverFeatures)) && !me?.homeInstance;
  const contacts = useContactList(contactsOn);
  const nameOf = usePeerName();
  const contactIds = useMemo(() => new Set((contacts ?? []).map((c) => c.id)), [contacts]);
  const candidatesAll = useMemo(
    () => dmComposeCandidates({ members, dms, meId: me?.id, query, nameOf }),
    [members, dms, me?.id, query, nameOf],
  );
  const candidates = useMemo(() => candidatesAll.filter((u) => !contactIds.has(u.id)), [candidatesAll, contactIds]);
  // Точка «в сети» — только у тех, чьё время захода мне видно (Р-2, `lastseen2`).
  const candidateIds = useMemo(() => [...candidates.map((u) => u.id), ...contactIds], [candidates, contactIds]);
  const onlineSet = useVisibleOnline(candidateIds);
  const contactRows = useMemo(
    () => sortContacts((contacts ?? []).filter((c) => contactMatches(c, query)), onlineSet),
    [contacts, query, onlineSet],
  );
  // Телефон (#218, `ContactsActivity`): под именем «в сети» / «был(а) …», а не @ник; клавиатура сама не открывается.
  const seenText = useContactSeen(candidateIds, onlineSet, phone);
  const subOf = (id: string, username: string) => {
    const t = seenText.get(id);
    return t ? (
      <span className={`dm-sub seen${onlineSet.has(id) ? ' on' : ''}`}>{t}</span>
    ) : (
      <span className="dm-sub"> @{username}</span>
    );
  };
  const fedDm = useStore((s) => serverFedDm(s.serverFeatures));
  // Э1 (`fedm1`): `@имя@домен` — человек связанного инстанса; уходит на сервер как есть (`userSearchQuery` его не пропустит).
  const remoteQuery = searchOn ? dmRemoteQuery(query, fedDm) : null;
  const searchQuery = searchOn ? userSearchQuery(query) : null;

  useEffect(() => {
    const ask = remoteQuery ?? searchQuery;
    if (!ask) {
      round.current += 1;
      setHits([]);
      setRemote([]);
      setSearch(null);
      return;
    }
    const mine = ++round.current;
    setSearch({ state: 'loading' });
    const t = window.setTimeout(() => {
      api
        .searchUsers(ask)
        .then((r) => {
          if (round.current !== mine) return;
          setHits(r.users);
          setRemote(r.remote ?? []);
          setSearch({ state: 'done' });
        })
        .catch((e: Error) => {
          if (round.current !== mine) return;
          setHits([]);
          setRemote([]);
          setSearch({ state: 'error', error: e.message });
        });
    }, USER_SEARCH_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [searchQuery, remoteQuery]);

  const found = useMemo(
    () => dmSearchHits({ hits, candidates, meId: me?.id, query: searchQuery }).filter((u) => !contactIds.has(u.id)),
    [hits, candidates, me?.id, searchQuery, contactIds],
  );
  const hint = dmComposeHint({ searchOn, shown: contactRows.length + candidates.length + found.length + remote.length, query, search });

  const picker = (
    <>
      <input
        ref={inputRef}
        className="sheet-search"
        autoFocus={!phone}
        value={query}
        placeholder="Кому написать?"
        onChange={(e) => setQuery(e.target.value)}
      />
      {/* Группы ЛС (07.10, `groups1`): первая строка «Написать» — «Новая группа», как Telegram «New Group». */}
      {groupsOn && !query && !pick && (
        <button
          type="button"
          className="sheet-row group-new"
          onClick={() => {
            close();
            openNewGroup();
          }}
        >
          <span className="dm-ava group-add-ico">
            <Icon name="users" size={20} />
          </span>
          <span className="sr-label">Новая группа</span>
        </button>
      )}
      {savedOn && !query && !pick && (
        <button
          type="button"
          className="sheet-row group-new"
          onClick={() => {
            close();
            void openSaved();
          }}
        >
          <span className="dm-ava">
            <SavedAvatar size={38} />
          </span>
          <span className="sr-label">{SAVED_NAME}</span>
        </button>
      )}
      {hint && <div className="sheet-empty">{hint}</div>}
      {(contactRows.length > 0 || candidates.length > 0 || found.length > 0 || remote.length > 0) && (
        <div className="dm-compose-list">
          {contactRows.length > 0 && <div className="mp-head">Контакты</div>}
          {contactRows.map((c) => (
            <button
              type="button"
              key={c.id}
              className="sheet-row"
              onClick={() => {
                close();
                if (pick) return pick.onPick(c.id, { name: contactLabel(c), username: c.username ?? '', avatarUrl: c.avatarUrl ?? null });
                openDmWith(c.id).catch((e: Error) => toastError(e));
              }}
            >
              <span className="dm-ava">
                <Avatar url={c.avatarUrl} name={c.displayName} size={38} />
                <span className={`mp-dot ${onlineSet.has(c.id) ? 'on' : 'off'}`} />
              </span>
              <span className="sr-label">
                {contactLabel(c)}
                {subOf(c.id, c.username)}
              </span>
            </button>
          ))}
          {contactRows.length > 0 && candidates.length > 0 && <div className="mp-head">Остальные</div>}
          {candidates.map((u) => (
            <button
              type="button"
              key={u.id}
              className="sheet-row"
              onClick={() => {
                close();
                if (pick) return pick.onPick(u.id, { name: nameOf(u.id, u.displayName), username: u.username ?? '', avatarUrl: u.avatarUrl ?? null });
                // Гость и гостю — нельзя (§5.8): отвечаем словами, не сходив за отказом на сервер.
                const blocked = dmBlockText(me?.homeInstance, u.homeInstance);
                if (blocked) {
                  toast('info', blocked);
                  return;
                }
                // Бэкенд откажет, если общего сервера уже нет (человек вышел, список устарел) — сказать об этом.
                openDmWith(u.id).catch((e: Error) => toastError(e));
              }}
            >
              <span className="dm-ava">
                <Avatar url={u.avatarUrl} name={nameOf(u.id, u.displayName)} size={38} />
                <span className={`mp-dot ${onlineSet.has(u.id) ? 'on' : 'off'}`} />
              </span>
              <span className="sr-label">
                {nameOf(u.id, u.displayName)}
                {subOf(u.id, u.username)}
              </span>
            </button>
          ))}
          {found.length > 0 && <div className="mp-head">На этом инстансе</div>}
          {found.map((u) => (
            // Та же строка, но без точки «в сети»: онлайн незнакомых сервер не отдаёт, и серая точка соврала бы. Гостей среди
            // найденных нет, а гостю поиск не включается — проверка `dmBlockText` здесь не нужна.
            <button
              type="button"
              key={u.id}
              className="sheet-row"
              onClick={() => {
                close();
                if (pick) return pick.onPick(u.id, { name: nameOf(u.id, u.displayName), username: u.username ?? '', avatarUrl: u.avatarUrl ?? null });
                // Политика инстанса `shared` не пускает к незнакомому (403), а новых переписок за час больше 10 (429) — сервер
                // объясняет это сам, его текст и показываем.
                openDmWith(u.id).catch((e: Error) => toastError(e));
              }}
            >
              <span className="dm-ava">
                <Avatar url={u.avatarUrl} name={nameOf(u.id, u.displayName)} size={38} />
              </span>
              <span className="sr-label">
                {nameOf(u.id, u.displayName)}
                <span className="dm-sub"> @{u.username}</span>
              </span>
            </button>
          ))}
          {remote.length > 0 && <div className="mp-head">Другие инстансы</div>}
          {remote.map((u) => (
            // Э1 (`fedm1`): человек связанного инстанса. Решает его дом (Ф6): отказ сервер вернёт кодом, тост скажет словами.
            <button
              type="button"
              key={`${u.instanceId}:${u.homeUserId}`}
              className="sheet-row"
              onClick={() => {
                // Выбор контакта (G69): у человека из каталога соседа ещё нет нашей строки — поделиться можно после беседы с ним.
                if (pick) {
                  toast('info', 'Сначала напишите этому человеку — потом им можно поделиться');
                  return;
                }
                close();
                openDmRemote({ instanceId: u.instanceId, homeUserId: u.homeUserId }).catch((e: Error) => toastError(e));
              }}
            >
              <span className="dm-ava">
                <Avatar url={u.avatarUrl} name={u.displayName} size={38} />
              </span>
              <span className="sr-label">
                {u.displayName}
                <span className="dm-sub"> {remoteHandle(u)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );

  return phone ? (
    <BottomSheet title={pick?.title ?? 'Написать'} onClose={close}>
      {picker}
    </BottomSheet>
  ) : (
    <ComposeDialog inputRef={inputRef} {...(pick ? { title: pick.title, onClose: close } : {})}>
      {picker}
    </ComposeDialog>
  );
}

/** Выбор человека вместо «написать ему» (G69): заголовок окна, выбор, закрытие. */
/** Кого выбрали — для окна подтверждения «Отправить контакт» (имя, @ник, аватар из той же строки списка). */
export interface ContactWho {
  name: string;
  username: string;
  avatarUrl: string | null;
}

interface ContactPick {
  title: string;
  onPick: (userId: string, who: ContactWho) => void;
  onClose: () => void;
}

/**
 * «Контакт» из листа вложений ЛС (14.10, G69, `geocontact1`): тот же список, что «Написать» (контакты, собеседники, люди
 * открытого сервера и поиск по @имени) — как Telegram Android `ChatAttachAlertContactsLayout` берёт список контактов. Нажатие
 * строки — выбор человека (`onPick` с его id), «Новая группа» и «Избранное» не показываются; люди других инстансов из каталога
 * (без беседы) — пока нельзя: у них ещё нет нашей строки.
 */
export function ContactPickSheet({ onPick, onClose }: { onPick: (userId: string, who: ContactWho) => void; onClose: () => void }) {
  return <NewDmSheet initialQuery="" pick={{ title: 'Отправить контакт', onPick, onClose }} />;
}

/**
 * Левая колонка личных сообщений (раунд 11, HANDOFF §2–§4): шапка, поиск по беседам, строки, пустой список, «Написать».
 * Пустой список на ПК — в главной области (`MainLayout`): там есть место, а список без бесед пуст и без поиска.
 */
/**
 * Люди в поиске по списку бесед на телефоне (#218) — вместо служебных строк «По запросу … бесед нет» + «Написать новому
 * человеку» над результатами. Как у Telegram Android (`DialogsSearchAdapter`): после найденных бесед — люди, с кем беседы
 * ещё нет (у TG — контакты из локального поиска; у нас — ростер открытого сервера и собеседники, `dmComposeCandidates`), затем
 * блок «Глобальный поиск» (`R.string.GlobalSearch`) — люди инстанса по @логину с сервера (`GET /users/search`, признак `users1`;
 * у TG — `searchAdapterHelper.getGlobalSearch()`, поиск по username). Строка — как у результатов по сообщениям (`.dm-row`),
 * под именем @логин (`ProfileSearchCell`). Тап — беседа с человеком (`openDmWith`); ничего не нашлось — блока нет.
 */
function DmGlobalPeople({ q, dms, onOpened }: { q: string; dms: readonly DmChannel[]; onOpened: () => void }) {
  // Ростера может не быть (сервер не открывали) — тогда только собеседники.
  const members = useStore((s) => s.members) ?? [];
  const me = useStore((s) => s.user);
  const openDmWith = useStore((s) => s.openDmWith);
  const openDmRemote = useStore((s) => s.openDmRemote);
  // Гостю искать незачем: личка с ним закрыта, и сервер ему не ответит (`requireLocalUser`) — как в «Написать».
  const searchOn = useStore((s) => serverSearchesUsers(s.serverFeatures)) && !me?.homeInstance;
  const nameOf = usePeerName();
  const [hits, setHits] = useState<UserSearchHit[]>([]);
  const [remote, setRemote] = useState<RemoteUserHit[]>([]);
  // Номер запроса: ответ на прошлый ввод, догнавший следующий, показал бы не тех людей.
  const round = useRef(0);

  // С кем беседа один на один уже есть — те видны строками бесед выше, второй раз их не показываем.
  const peers = useMemo(() => new Set(dms.filter((d) => !d.group).map((d) => d.otherUser.id)), [dms]);
  const local = useMemo(
    () => (q.trim() ? dmComposeCandidates({ members, dms, meId: me?.id, query: q, nameOf }).filter((u) => !peers.has(u.id)) : []),
    [members, dms, me?.id, q, nameOf, peers],
  );
  const fedDm = useStore((s) => serverFedDm(s.serverFeatures));
  // Э1 (`fedm1`): `@имя@домен` — человек связанного инстанса; уходит на сервер как есть (`userSearchQuery` его не пропустит).
  const remoteQuery = searchOn ? dmRemoteQuery(q, fedDm) : null;
  const searchQuery = searchOn ? userSearchQuery(q) : null;
  useEffect(() => {
    const mine = ++round.current;
    const ask = remoteQuery ?? searchQuery;
    if (!ask) {
      setHits([]);
      setRemote([]);
      return;
    }
    const t = window.setTimeout(() => {
      api
        .searchUsers(ask)
        .then((r) => {
          if (round.current === mine) {
            setHits(r.users);
            setRemote(r.remote ?? []);
          }
        })
        .catch(() => {
          // Поиск людей — добавка к поиску бесед: сбой не повод для окна, просто блока нет.
          if (round.current === mine) {
            setHits([]);
            setRemote([]);
          }
        });
    }, USER_SEARCH_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [searchQuery, remoteQuery]);
  const taken = useMemo(() => [...local, ...[...peers].map((id) => ({ id }))], [local, peers]);
  const found = useMemo(() => dmSearchHits({ hits, candidates: taken, meId: me?.id, query: searchQuery }), [hits, taken, me?.id, searchQuery]);

  if (local.length === 0 && found.length === 0 && remote.length === 0) return null;
  // Э1 (`fedm1`): человек связанного инстанса — `@имя@домен` под именем, тап открывает переписку через его дом.
  const remoteRow = (u: RemoteUserHit) => (
    <button
      type="button"
      key={`${u.instanceId}:${u.homeUserId}`}
      className="dm-row dm-msg-hit dm-people-hit"
      onClick={() => {
        onOpened();
        openDmRemote({ instanceId: u.instanceId, homeUserId: u.homeUserId }).catch((e: Error) => toastError(e));
      }}
    >
      <span className="dm-ava">
        <Avatar name={u.displayName} url={u.avatarUrl} size={40} />
      </span>
      <span className="dm-name">
        <span className="dm-name-text">{u.displayName}</span>
      </span>
      <span className="dm-when" />
      <span className="dm-preview">{remoteHandle(u)}</span>
    </button>
  );
  const open = (u: DmCandidate | UserSearchHit) => {
    // Гость и гостю — нельзя (§5.8): отвечаем словами, не сходив за отказом на сервер.
    const blocked = 'homeInstance' in u ? dmBlockText(me?.homeInstance, u.homeInstance) : null;
    if (blocked) {
      toast('info', blocked);
      return;
    }
    onOpened();
    openDmWith(u.id).catch((e: Error) => toastError(e));
  };
  const row = (u: DmCandidate | UserSearchHit) => {
    const name = nameOf(u.id, u.displayName);
    return (
      <button type="button" key={u.id} className="dm-row dm-msg-hit dm-people-hit" onClick={() => open(u)}>
        <span className="dm-ava">
          <Avatar name={name} url={u.avatarUrl} size={40} />
        </span>
        <span className="dm-name">
          <span className="dm-name-text">{name}</span>
        </span>
        <span className="dm-when" />
        <span className="dm-preview">@{u.username}</span>
      </button>
    );
  };
  return (
    <>
      {local.length > 0 && (
        <section className="dms-hits" aria-label="Люди" data-testid="dm-local-people">
          {local.map(row)}
        </section>
      )}
      {found.length > 0 && (
        <section className="dms-hits" aria-label="Глобальный поиск" data-testid="dm-global-people">
          <div className="dms-head">
            <span>Глобальный поиск</span>
          </div>
          {found.map(row)}
          {remote.map(remoteRow)}
        </section>
      )}
    </>
  );
}

export function DmSidebar() {
  const dms = useStore((s) => s.dms);
  const nameOf = usePeerName(); // подпись контакта в поиске по списку (`peerName.ts`)
  const currentDmId = useStore((s) => s.currentDmId);
  const mobilePane = useStore((s) => s.mobilePane);
  const view = useStore((s) => s.view);
  const unreadDms = useStore((s) => s.unreadDms);
  const loadDms = useStore((s) => s.loadDms);
  const selectDm = useStore((s) => s.selectDm);
  const voice = useStore((s) => s.voice);
  const meId = useStore((s) => s.user?.id);
  // Гость ли я сам — от этого зависит подпись пустого списка (§5.8).
  const guestHome = useStore((s) => s.user?.homeInstance ?? null);
  // Сводки (превью, ✓ / ✓✓), черновики (Р7) и своя очередь отправки — строки есть только в режиме бесед.
  const summaries = useStore((s) => s.conv.summaries);
  const drafts = useStore((s) => s.drafts);
  /** Черновики голосовых (G54, `voiceDrafts.ts`): «Черновик: Голосовое сообщение», если текстового черновика нет. */
  const voiceDrafts = useVoiceDraftKeys();
  const outbox = useStore((s) => s.outbox);
  // Список ещё не пришёл (беседы без кеша) — пустым его не называем: иначе гусь мелькнул бы до ответа сервера.
  const listKnown = useStore((s) => s.convActive && s.conv.pts !== null);
  // Сервер без бесед (`conv1`+`conv2`) — ЛС там нет: на телефоне в списке заглушка про обновление сервера (09.10).
  const dmOff = useStore((s) => dmNeedsServerUpdate(s.serverFeatures));
  // Заглушки бесед (07.10, G03): из сводки (`conv11`) или из списка заглушек собеседников; срок вышел — перерисовать.
  const mutedUsers = useStore((s) => s.pushMutedDmUsers);
  const muteUntil = useStore((s) => s.pushMuteUntil);
  const mutes = useMemo(
    () => new Map(dms.map((d) => [d.id, dmMuteOf(d, mutedUsers, muteUntil)] as const)),
    [dms, mutedUsers, muteUntil],
  );
  const muteNow = useMuteClock([...mutes.values()]);
  const compose = useDmCompose();
  const phone = usePhoneLayout();
  /* Архив бесед (07.10, G41, `archive1`): строка «Архив» наверху основного списка и экран архива с «назад» (у Telegram
     Desktop — тот же столбец, у Android — тот же список с другой шапкой). Беседы архива не входят ни в основной список,
     ни в папки; поиск находит и их. Свёрнутость строки — настройка устройства. */
  const archiveOn = useStore((s) => s.convActive && serverArchive(s.serverFeatures));
  const [inArchive, setInArchive] = useState(false);
  const [archiveCollapsed, setArchiveCollapsed] = useArchiveCollapsed();
  const archDms = useMemo(() => (archiveOn ? archivedOnly(dms) : []), [archiveOn, dms]);
  // «Избранное» (`saved1`) без сообщений в списке не показывается (как у Telegram): заведённое Ctrl+0 / «Переслать», оно
  // появляется в списке с первой заметкой; закреплённое и открытое сейчас — остаётся.
  const mainDms = useMemo(
    () => (archiveOn ? withoutArchived(dms) : dms).filter((d) => !d.saved || !!d.lastMessageAt || !!d.pinnedAt || d.id === currentDmId),
    [archiveOn, dms, currentDmId],
  );
  const activeFolderId = useDmFolders((s) => s.activeId);
  // Архив опустел (всё вернули) или выбрали папку — экран архива закрывается.
  useEffect(() => {
    if (inArchive && (!archiveOn || archDms.length === 0)) setInArchive(false);
  }, [inArchive, archiveOn, archDms.length]);
  useEffect(() => setInArchive(false), [activeFolderId]);
  // «Потянуть вниз» показывает свёрнутую строку «Архив» (Android `archivePullViewState`); уйти со «своего» места — спрятать снова.
  const [archivePulled, setArchivePulled] = useState(false);
  useEffect(() => setArchivePulled(false), [activeFolderId, inArchive, archiveCollapsed]);
  // «Назад» Android / браузера выходит из архива в список (как из выбора).
  useEffect(() => {
    if (!inArchive) return;
    return pushBackHandler(() => {
      setInArchive(false);
      return true;
    });
  }, [inArchive]);
  const [query, setQuery] = useState('');
  const [findFocused, setFindFocused] = useState(false);
  // Поиск из списка (G35, `gsearch1`): чипы «человек» / «дата», «Недавние» на устройстве; см. `DmListSearch.tsx`.
  const gsearch = useStore((s) => s.convActive && serverGlobalSearch(s.serverFeatures));
  const [chips, setChips] = useState<SearchChips>({});
  // Вкладки областей поиска «Все / Личные / Серверы» (G35, `srvsearch1`): состояние — здесь, правила — `scopeView`.
  const srvSearch = useStore((s) => s.convActive && serverGlobalSearch(s.serverFeatures) && serverServersSearch(s.serverFeatures));
  const [scope, setScope] = useState<SearchScope>('all');
  // Телефон (12.10, #218): при открытом поиске (и с пустым полем) — вкладки «Чаты / Медиа / Ссылки / Файлы / GIF / Голосовые» (Telegram Android
  // `SearchViewPager`, `DmSearchKinds.tsx`); новый поиск — снова с «Чатов».
  const [kindTab, setKindTab] = useState<PhoneSearchTab>('chats');
  useEffect(() => {
    if (!query) setScope('all');
  }, [query]);
  // Вкладка переживает ввод и стирание запроса (как у Telegram); с «Чатов» начинается только новый поиск — поле закрыто и пусто.
  const searchIdle = !findFocused && !query && !hasChips(chips);
  useEffect(() => {
    if (searchIdle) setKindTab('chats');
  }, [searchIdle]);
  const recent = useRecentSearches();
  // «Частые» (G35, `freq1`): порядок — сервера, отсев (архив, заблокированные, «Избранное», убранные) — клиента.
  const freqOn = useStore((s) => s.convActive && serverGlobalSearch(s.serverFeatures) && serverFrequent(s.serverFeatures));
  // «Убрать из частых» на сервере (09.10, `freq2`): скрытие видно на всех моих устройствах; без признака — на устройстве.
  const freqServerHide = useStore((s) => s.convActive && serverFrequentHide(s.serverFeatures));
  const freqHidden = useFrequentHidden(freqServerHide);
  const blockedUsers = useStore((s) => s.blockedUsers);
  const blurFind = () => (document.activeElement as HTMLElement | null)?.blur?.();
  /* Открыто меню «Убрать из частых» (`DmSearchHome` → `onMenuOpen`): поле могло потерять фокус от самого удержания (на живом
     WebView долгое нажатие выделяет слово и уводит фокус) — поиск под меню не закрываем, а после меню возвращаем фокус в поле.
     Иначе панель «Частые» исчезала, и долгое нажатие доходило до строки беседы под пальцем — её меню (приёмка S20+ 09.10). */
  const freqMenuHeld = useRef(false);
  const onFindBlur = () => {
    if (!freqMenuHeld.current) setFindFocused(false);
  };
  const onFreqMenu = useCallback((open: boolean) => {
    freqMenuHeld.current = open;
    if (!open && findRef.current && document.activeElement !== findRef.current) findRef.current.focus({ preventScroll: true });
  }, []);
  const findRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Меню строки (07.10, G01): ПКМ / удержание.
  // Порядок закреплённых меняется только в «Все чаты» и в архиве, не в своей папке (значение ставится ниже, когда известна `folderUi`).
  const reorderHereRef = useRef<PinReorderScope>(true);
  const { openDmMenu, menu: rowMenu } = useDmRowMenu(reorderHereRef);
  const { openListMenu, menu: listMenu } = useDmListMenu();
  // Roving tabindex (07.10, G14): строка, на которой стоял фокус; ушла из списка — открытая, иначе первая.
  const [focusId, setFocusId] = useState<string | null>(null);
  /* Выбор нескольких бесед на телефоне (07.10, G01; Telegram Android `DialogsActivity`): выбранные id; пусто — режим
     выключен (у Telegram он закрывается, когда снята последняя галочка). Только раскладка телефона: на ПК удержания нет. */
  const [picks, setPicks] = useState<string[]>([]);
  const selecting = phone && picks.length > 0;
  const togglePick = useCallback(
    (id: string) => setPicks((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id])),
    [],
  );
  const dropPicks = useCallback(() => setPicks([]), []);
  // Ушли с телефонной раскладки или выбранные беседы пропали из списка — выбор снимается / сужается.
  useEffect(() => {
    if (!phone) setPicks([]);
    else setPicks((p) => (p.every((id) => dms.some((d) => d.id === id)) ? p : p.filter((id) => dms.some((d) => d.id === id))));
  }, [phone, dms]);
  // «Назад» Android / браузера выходит из выбора, а не из списка (как у Telegram).
  useEffect(() => {
    if (!selecting) return;
    return pushBackHandler(() => {
      setPicks([]);
      return true;
    });
  }, [selecting]);
  // «Назад» Android при открытом поиске: сбросить запрос и чипы, снять фокус (эмулятор B1; у Telegram — закрывает поиск, а не приложение).
  const searchOpen = phone && dms.length > 0 && (findFocused || !!query || hasChips(chips));
  /* Пока идёт поиск, капсулы вкладок нет (#218, Telegram Android `checkUi_mainTabsVisible`: `!searching`,
     `TA/ui/DialogsActivity.java:14023`): капсула — в `MainLayout`, поэтому знак — классом на корне (CSS `:root.gv-listsearch`). */
  useEffect(() => {
    if (!searchOpen) return;
    const root = document.documentElement;
    root.classList.add('gv-listsearch');
    return () => root.classList.remove('gv-listsearch');
  }, [searchOpen]);
  /* Архив на телефоне — отдельный экран, как у Telegram Android (`DialogsActivity` с `folderId = 1` открывается поверх
     `MainTabsActivity`): ни капсулы вкладок, ни «Написать» (`isVisible = !(… || folderId != 0 || …)`, `TA/ui/DialogsActivity.java:8846`).
     Капсула — в `MainLayout`, знак — классом на корне (CSS `:root.gv-listarchive`), как при поиске. */
  const archiveScreen = phone && inArchive;
  useEffect(() => {
    if (!archiveScreen) return;
    const root = document.documentElement;
    root.classList.add('gv-listarchive');
    return () => root.classList.remove('gv-listarchive');
  }, [archiveScreen]);
  /* Поле поиска уезжает с лентой и гаснет (#218, `searchFieldAlpha`): прозрачность пишем прямо в стиль на прокрутке (без
     перерисовки списка), а «поле погасло → значок в шапке» — состоянием, оно меняется редко. */
  const findZoneRef = useRef<HTMLDivElement>(null);
  const [findGone, setFindGone] = useState(false);
  const syncFindFade = () => {
    if (!phone) return;
    const st = { scrollTop: listRef.current?.scrollTop ?? 0, searching: searchOpen, selecting };
    findZoneRef.current?.style.setProperty('--find-a', String(searchFieldAlpha(st)));
    setFindGone(searchButtonShown(st));
  };
  useLayoutEffect(syncFindFade);
  useEffect(() => {
    if (!searchOpen) return;
    return pushBackHandler(() => {
      /* Список под чем-то (открыта беседа из результатов, настройки, профиль): «назад» — тому, что сверху (`stepBack`), а
         поиск остаётся, как у Telegram. Иначе первая «назад» в беседе сбрасывала скрытый под ней поиск, а беседа стояла. */
      const st = useStore.getState();
      if (st.mobilePane === 'content' || st.settingsOpen || st.adminOpen || st.mobileProfileOpen) return false;
      setQuery('');
      setChips({});
      blurFind();
      return true;
    }, () => {
      // Тот же вопрос без действия — для предиктивной «назад» (`backLeavesPane`): под беседой поиск не мешает ей уйти.
      const st = useStore.getState();
      return !(st.mobilePane === 'content' || st.settingsOpen || st.adminOpen || st.mobileProfileOpen);
    });
  }, [searchOpen]);
  // Связи нет — «Соединение…» / «Ожидание сети…»; догоняем пропущенное — «Обновление…» (G34; тексты — `CONN_TEXT`).
  const conn = connLabel(useConnState());
  const syncing = useStore((s) => s.convActive && s.conv.phase === 'syncing');
  const headTitle = conn ?? (syncing ? CONN_TEXT.updating : 'Личные сообщения');

  useEffect(() => {
    loadDms().catch(() => {});
  }, [loadDms]);

  // Лист «Написать» живёт со списком: ушли из личных сообщений (или в другой инстанс) — закрыт.
  useEffect(() => closeDmCompose, []);

  /* ПК: Ctrl+9 — архив (Telegram Desktop `core/shortcuts.cpp`: `ShowArchive`; в `dialogs_inner_widget.cpp` — только если в
     архиве есть беседы). Окно поверх — не наше. */
  useEffect(() => {
    if (phone || !archiveOn || archDms.length === 0) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.code !== 'Digit9') return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      setInArchive(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phone, archiveOn, archDms.length]);

  /* ПК: Ctrl+0 — «Избранное» (Telegram Desktop `core/shortcuts.cpp`: `lng_shortcuts_chat_self`, Ctrl+0). Беседу заводит сервер
     при первом разе (`openSaved`). Окно поверх — не наше. По коду клавиши: в русской раскладке `key` тоже «0», но код надёжнее.
     Только в десктопе, как Ctrl+R (Р-4): в браузере Ctrl+0 — сброс масштаба страницы. */
  const savedKeyOn = useStore((s) => s.convActive && serverSaved(s.serverFeatures) && !s.user?.homeInstance);
  const openSavedByKey = useStore((s) => s.openSaved);
  useEffect(() => {
    if (phone || !savedKeyOn || !isTauri()) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || (e.code !== 'Digit0' && e.code !== 'Numpad0')) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      void openSavedByKey().catch(() => {});
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phone, savedKeyOn, openSavedByKey]);

  /* ПК: Ctrl K ставит курсор в поиск бесед (подсказка — в самом поле, `SettingsSearch`). По коду клавиши, а не по
     букве: в русской раскладке `key` — «л». Окно поверх (настройки ловят своё Ctrl K, лист, подтверждение) — не наше. */
  useEffect(() => {
    if (phone) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.code !== 'KeyK') return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const input = findRef.current;
      if (!input) return;
      e.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phone]);

  // Точка «в сети» у строки — только если время захода собеседника мне видно (Р-2, `lastseen2`): скрытый — «был(а) недавно».
  const peerIds = useMemo(() => dms.map((d) => d.otherUser.id), [dms]);
  const onlineSet = useVisibleOnline(peerIds);
  const mobile = isMobile();
  /* 🔴 Число прячется у беседы, которую ВИДНО, а не у «текущей» (#212, 28.09, поймано на S25): на телефоне
     список и лента — разные экраны, и сообщение в беседу, из которой человек вышел в список, пропадало без
     следа — ни числа, ни точки. Ровно та ошибка, что у каналов чинили 20.09 (`ChannelSidebar.shownChannelId`).
     Подсветка строки — по `currentDmId` и только на ПК (раунд 11, HANDOFF §2.2 «Открытая беседа (ПК)»): на телефоне
     список и беседа — разные экраны, выбранной строки там нет. */
  const shownDmId =
    currentDmId && isFeedOnScreen({ id: currentDmId, currentId: currentDmId, mobile, mobilePane, kind: 'dm', view })
      ? currentDmId
      : null;

  const open = useCallback((id: string) => void selectDm(id), [selectDm]);
  // Папки (07.10, G40, `folders1`): полоса слева на ПК / вкладки на телефоне, отбор бесед открытой папки — `DmFolderBar.tsx`.
  const unreadOf = useCallback(
    (d: DmChannel) => (unreadDms.includes(d.id) && d.id !== shownDmId ? (d.unread ?? 0) : 0),
    [unreadDms, shownDmId],
  );
  const mutedNow = useCallback((d: DmChannel) => muteActive(mutes.get(d.id), muteNow), [mutes, muteNow]);
  const folderUi = useDmFolderUi({ dms: mainDms, unreadOf, isMuted: mutedNow, openId: shownDmId, phone });
  /* Полоса папок слева (ПК) стоит ВНУТРИ колонки списка: при 240 px на сам список оставалось 176, имена и поиск обрезались
     («Кап…», «Найти б…»). Telegram Desktop держит ширину списка и ставит полосу снаружи (`window_filters_menu.cpp`) —
     колонке прибавляем ширину полосы через `--dm-strip-w` (её читают `.app`, ручка колонки и док голоса). */
  useEffect(() => {
    if (!folderUi.strip) return undefined;
    document.documentElement.style.setProperty('--dm-strip-w', '64px');
    return () => {
      document.documentElement.style.removeProperty('--dm-strip-w');
    };
  }, [folderUi.strip]);
  /* Жесты по списку на телефоне (G40 + G42, `DmListSwipe.tsx`): свайп по строке — действие из «Свайпа по чату», свайп вбок —
     между папками, «потянуть вниз» — показать свёрнутый «Архив». */
  const swipeCaps = useSwipeCaps();
  const [swipeSetting] = useSwipeSetting();
  const archiveRowShown = archiveOn && !inArchive && !query.trim() && archDms.length > 0 && folderUi.home;
  // В архиве (и в поиске) — общий закреп: набор открытой папки туда не относится (находка Codex R129: Ctrl+9 из своей папки).
  const ownPinsHere = query.trim() || inArchive ? null : folderUi.ownPins;
  const rowOf = useCallback(
    (id: string) => {
      const d = dms.find((x) => x.id === id);
      if (!d) return null;
      return {
        dm: d,
        state: {
          // Своя папка со своим набором (`pinset1`): закреп — по набору папки, свайп закрепляет в ней.
          pinned: ownPinsHere ? ownPinsHere.includes(d.id) : !!d.pinnedAt,
          pinFolder: ownPinsHere ? folderUi.pinFolder?.id : undefined,
          unread: (d.unread ?? 0) > 0 || d.markedUnread === true,
          muted: muteActive(mutes.get(d.id), muteNow),
          archived: d.archived === true,
          former: !!summaries[d.id]?.former,
        },
      };
    },
    [dms, mutes, muteNow, summaries, ownPinsHere, folderUi.pinFolder?.id],
  );
  /* Бросок сообщений из ленты на строку (G76): окно «Переслать в…» с этой беседой отмечено; лента-источник слушает событие. */
  const dropMsgs = useCallback((d: DmChannel, p: MsgDragPayload) => requestForwardDrop(p, d.id), []);
  /* Файлы из проводника на строку (G37, tdesktop `Dialogs::Widget::dropEvent` → `filesOrForwardDrop`): заказ ленте беседы, потом
     открыть беседу — окно отправки встаёт, когда лента готова (`filesDrop.ts`, `MessagePane`). */
  const dropFiles = useCallback(
    (d: DmChannel, files: File[]) => {
      requestFilesDrop(d.id, files);
      void selectDm(d.id);
    },
    [selectDm],
  );
  /* «Только аватары» (G34) — режим колонки списка бесед на ПК; у каналов сервера колонка всегда обычная. */
  const narrowCol = useSidebarNarrow() && !phone;
  const listLines = useListLines();
  useEffect(() => {
    setNarrowAllowed(true);
    return () => setNarrowAllowed(false);
  }, []);
  const gestures = useDmListSwipe({
    listRef,
    enabled: phone && !selecting,
    pages: folderUi.pages,
    rowAction: effectiveSwipe(swipeSetting, swipeCaps),
    rowOf,
    archiveCollapse: archiveRowShown && !(archiveCollapsed && !archivePulled) ? () => setArchiveCollapsed(true) : null,
    archivePull: archiveRowShown && archiveCollapsed && !archivePulled ? () => setArchivePulled(true) : null,
  });
  // Поиск — по началу любого слова имени, без регистра, «ё» = «е» (`dmRowRules.matchDmName`), и по началу логина, с «@» и
  // без (`matchDmUsername`, 05.10); пусто — весь список.
  const q = query.trim();
  /* Черновик поднимает беседу (G34): у Telegram строка встаёт по времени черновика, когда он новее последнего сообщения.
     Время черновика — из сводки сервера (`draft.at`); закреплённые остаются наверху (`byRecent`). */
  const pool = q ? dms : inArchive ? archDms : mainDms;
  const ordered = useMemo(() => {
    const at = (d: DmChannel) => {
      // Черновик голосового (G54, `voiceDrafts.ts`) поднимает беседу так же, как текстовый.
      const draftAt = drafts[d.id]?.text ? summaries[d.id]?.draft?.at : (voiceDrafts.get(d.id) ?? null);
      return draftAt ? { ...d, lastMessageAt: rowActivityAt({ lastMessageAt: d.lastMessageAt, createdAt: d.createdAt, draftAt }) } : d;
    };
    const keyed = pool.map((d) => [d, at(d)] as const);
    return keyed.some(([d, k]) => d !== k) ? [...keyed].sort((a, b) => byRecent(a[1], b[1])).map(([d]) => d) : pool;
  }, [pool, drafts, summaries, voiceDrafts]);
  const shown = useMemo(
    () =>
      q
        ? ordered.filter((d) => matchDmName(dmPeerLabel(d, nameOf), q) || matchDmName(d.otherUser.displayName, q) || matchDmUsername(d.otherUser.username, q))
        : folderUi.on && !inArchive
          ? // Свой порядок закреплённых в своей папке (09.10, `pinorder2`, `DmFolder.pinned`; Telegram — `pinned_peers` фильтра);
            // со своим набором (`pinset1`) — закреплённые только папки, общий закреп здесь не действует (`folderOwnPinRows`).
            folderUi.ownPins
            ? folderOwnPinRows(ordered.filter(folderUi.keep), folderUi.ownPins)
            : folderPinnedRows(ordered.filter(folderUi.keep), folderUi.pinFolder?.pinned)
          : ordered,
    [ordered, q, folderUi.on, folderUi.keep, inArchive, nameOf, folderUi.pinFolder?.pinned, folderUi.ownPins],
  );
  const tabId = shown.some((d) => d.id === focusId)
    ? focusId
    : shown.some((d) => d.id === currentDmId)
      ? currentDmId
      : (shown[0]?.id ?? null);
  // Пустое поле в фокусе — «Частые» («Люди»), «Недавние» вместо списка; чип — только сообщения (G35).
  const chipsOn = gsearch && hasChips(chips);
  // Телефон (#218): вкладки видны сразу при открытии поиска, и при пустом поле тоже; на вкладке вида — свежие вложения вместо «Частых».
  const phoneTabs = phone && gsearch && phoneSearchTabsShown(q, chips, findFocused || chipsOn);
  const kindHits = phoneTabs && kindTab !== 'chats' ? kindTab : null;
  const searchHome = gsearch && findFocused && !q && !hasChips(chips) && !kindHits;
  const freqItems = useFrequent(freqOn, searchHome);
  const frequent = useMemo(
    () =>
      freqItems
        ? { items: freqItems, hidden: freqHidden.hidden, blockedIds: new Set(blockedUsers.map((u) => u.id)), onHide: freqHidden.hide }
        : undefined,
    [freqItems, freqHidden.hidden, freqHidden.hide, blockedUsers],
  );
  // Телефон: «Все / Личные / Серверы» нет — в «Чатах» личные и серверные сообщения одним списком (как вкладка «Все»).
  const sv = scopeView(phone ? 'all' : scope, q, chips, !!srvSearch);
  const listRows = searchHome || chipsOn || !sv.dm || kindHits ? [] : shown;
  /* Перетаскивание закреплённых (08.10, G02/G42, сервер `pinorder1`, `DmPinDrag.tsx`): в основном списке («Все» /
     системная папка) и в архиве, без поиска — общий порядок; в своей папке — её свой порядок (09.10, `pinorder2`, как
     `pinned_peers` фильтра у Telegram); без `pinorder2` в своей папке перетаскивания нет. */
  const pinOrderOn = useStore((s) => s.convActive && serverPinOrder(s.serverFeatures));
  const pinnedIds = useMemo(() => {
    const out: string[] = [];
    for (const d of listRows) {
      if (!d.pinnedAt) break;
      out.push(d.id);
    }
    return out;
  }, [listRows]);
  reorderHereRef.current =
    inArchive || folderUi.home
      ? true
      : folderUi.pinFolder
        ? { folderId: folderUi.pinFolder.id, ids: q ? [] : pinnedIds, own: q ? null : folderUi.ownPins }
        : false;
  useDmPinDrag({
    listRef,
    enabled: pinOrderOn && !q && listRows.length > 0 && (inArchive || folderUi.home || !!folderUi.pinFolder) && pinnedIds.length > 1,
    pinnedIds,
    folderId: inArchive ? null : (folderUi.pinFolder?.id ?? null),
    touchOk: phone,
  });
  const searchChips = gsearch && (findFocused || !!q || chipsOn);
  /** Открыть беседу из найденного/недавнего: запоминаем человека в «Недавних» и убираем курсор из поля. */
  const openFromSearch = (id: string) => {
    recent.push({ kind: 'person', convId: id });
    blurFind();
    open(id);
  };
  const rowsOf = () => [...(listRef.current?.querySelectorAll<HTMLButtonElement>('.dm-row') ?? [])];
  const clearOnEscape = (e: KeyboardEvent<HTMLInputElement>) => {
    // ↓ из поиска — к первой найденной беседе (07.10, G14; как стрелка в поиске Telegram Desktop).
    if (e.key === 'ArrowDown' && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const first = rowsOf()[0];
      if (first) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    if (e.key !== 'Escape' || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    // Esc в поиске (G15; Telegram Desktop `Dialogs::Widget::escape`): сбросить поиск и — открыта беседа — фокус в неё.
    if (query) {
      e.preventDefault();
      setQuery('');
      focusChat();
      return;
    }
    if (chipsOn) {
      e.preventDefault();
      setChips({});
      return;
    }
    if (focusChat()) e.preventDefault();
  };
  /** Фокус в поле открытой беседы (ПК; `MainWidget::dialogsCancelled` у Telegram). `false` — беседы нет. */
  const focusChat = (): boolean => {
    if (phone || !currentDmId) return false;
    const field = document.querySelector<HTMLTextAreaElement>('.content .composer-input');
    field?.focus();
    return !!field;
  };
  /* Клавиши по списку (07.10, G14, Telegram 03·1.7.3): ↑/↓ — соседняя строка, PgUp/PgDn — на экран, Home/End — первая и
     последняя; Enter — открыть (обычная кнопка). Фокус ходит по строкам, Tab с них уходит из списка (roving tabindex). */
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // Поле поиска на телефоне лежит в самой ленте (#218): его клавиши — его (Esc, стрелки по тексту), не навигация по строкам.
    if (e.target instanceof Element && e.target.closest('.dm-find-zone')) return;
    /* Печатный знак на строке списка уходит в «Найти беседу» (G36, HK-28; Telegram Desktop `Dialogs::Widget::keyPressEvent` →
       `redirectKeyToSearch`: знак без Ctrl/Alt/⌘, Shift можно — `RedirectTextToSearch`, код ≥ 32). Фокус переходит в
       keydown — браузер набирает знак уже в поле. Пробел у Telegram только открывает поиск, пустым — не набирает. */
    if (isTypingKey(e.nativeEvent) && e.target instanceof Element && e.target.closest('.dm-row')) {
      const find = listRef.current?.closest('.channels')?.querySelector<HTMLInputElement>('.dm-find input');
      if (find) {
        find.focus();
        find.setSelectionRange(find.value.length, find.value.length);
        if (e.key === ' ') e.preventDefault();
        return;
      }
    }
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    // Esc на строке — в открытую беседу (G15, как Esc в списке Telegram Desktop, когда поиска нет).
    if (e.key === 'Escape') {
      if (focusChat()) e.preventDefault();
      return;
    }
    const rows = rowsOf();
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0 || rows.length === 0) return;
    const page = Math.max(1, Math.floor((listRef.current?.clientHeight ?? 0) / (rows[0].offsetHeight || 1)) - 1);
    const to: Record<string, number> = {
      ArrowDown: i + 1,
      ArrowUp: i - 1,
      PageDown: i + page,
      PageUp: i - page,
      Home: 0,
      End: rows.length - 1,
    };
    if (!(e.key in to)) return;
    e.preventDefault();
    const row = rows[Math.max(0, Math.min(rows.length - 1, to[e.key]))];
    row.focus();
    row.scrollIntoView({ block: 'nearest' });
  };

  /* Поле «Найти беседу» + чипы + вкладки областей поиска (G35). На ПК — над лентой, на телефоне — первой строкой ленты. */
  const findZone = (
    <>
        {dms.length > 0 && (
          <div className={query ? 'dm-find has-q' : 'dm-find'}>
            {phone ? (
              <input
                ref={findRef}
                className="sheet-search"
                placeholder="Найти беседу"
                aria-label="Найти беседу"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => setFindFocused(true)}
                onBlur={onFindBlur}
                onKeyDown={clearOnEscape}
              />
            ) : (
              <SettingsSearch
                inputRef={findRef}
                placeholder="Найти беседу"
                aria-label="Найти беседу"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => setFindFocused(true)}
                onBlur={onFindBlur}
                onKeyDown={clearOnEscape}
              />
            )}
            {/* Крестик «очистить» (Telegram Desktop `FlatInput` + кнопка «×» в поиске, Android `SearchField.clearSearchImageView`):
                на телефоне Esc нет, стирать запрос побуквенно — долго. Фокус из поля не уводим (mousedown гасим). */}
            {query && (
              <button
                type="button"
                className="dm-find-clear"
                aria-label="Очистить поиск"
                title="Очистить"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQuery('');
                  setChips({});
                  findRef.current?.focus();
                }}
              >
                <Icon name="close" size={14} />
              </button>
            )}
          </div>
        )}
        {/* Чипы поиска (G35): мышь по ним не уводит фокус из поля — иначе панель закрылась бы раньше щелчка. */}
        {searchChips && dms.length > 0 && (
          <div onMouseDown={(e) => e.preventDefault()}>
            <DmSearchChips q={q} dms={dms} chips={chips} onChips={setChips} onText={setQuery} phone={phone} />
          </div>
        )}
        {phoneTabs ? (
          <DmSearchTabs
            tab={kindTab}
            onTab={(t) => {
              setKindTab(t);
              listRef.current?.scrollTo({ top: 0 });
            }}
          />
        ) : (
          !phone && sv.tabs && !searchHome && <DmSearchScopes scope={scope} onScope={setScope} />
        )}
    </>
  );
  return (
    <div className={`channels${folderUi.strip ? ' dm-folders-on' : ''}${narrowCol ? ' dm-narrow' : ''}${listLines === 'three' ? ' dm-three' : ''}`}>
      {inArchive && !selecting ? (
        <DmArchiveHead onBack={() => setInArchive(false)} />
      ) : selecting ? (
        <DmPickHead
          ids={picks}
          isMuted={(d) => muteActive(mutes.get(d.id), muteNow)}
          onClose={dropPicks}
          pinIn={ownPinsHere && folderUi.pinFolder ? { folderId: folderUi.pinFolder.id, own: ownPinsHere } : null}
        />
      ) : (
      <div
        className="server-head dm-list-head"
        onContextMenu={(e) => {
          // «Прочитать все» (G04, `conv13`): меню над списком; своего меню у заголовка не было, поэтому системное гасим всегда.
          e.preventDefault();
          openListMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <strong>{headTitle}</strong>
        {/* Телефон (#218): поле поиска уехало с лентой — в шапке значок поиска, как у Telegram Android (`searchItem` при
            `animatorSearchButtonVisible`); тап — поле встаёт сверху и получает фокус. */}
        {phone && findGone && dms.length > 0 && (
          <button
            type="button"
            className="head-icon dm-find-btn"
            title="Найти беседу"
            aria-label="Найти беседу"
            onClick={() => findRef.current?.focus({ preventScroll: true })}
          >
            <Icon name="search" size={22} />
          </button>
        )}
        {/* Сервер без бесед (`dmOff`, 09.10): писать некуда — кнопки «Написать» нет, в списке заглушка. */}
        {!phone && !dmOff && (
          <button type="button" className="head-icon" title="Написать" aria-label="Написать" onClick={() => openDmCompose()}>
            <Icon name="edit" size={18} />
          </button>
        )}
      </div>
      )}
      {!selecting && !(inArchive && phone) && folderUi.bar}
      {/* Телефон (#218): поле, чипы и вкладки областей — первой строкой ленты (`findZone` ниже), чтобы уезжать вместе с ней. */}
      {!phone && findZone}
      <div
        className={phone ? 'channel-list dm-list dm-list-touch' : 'channel-list dm-list'}
        ref={listRef}
        onKeyDown={onListKey}
        onScroll={() => {
          syncFindFade();
          if (archivePulled && (listRef.current?.scrollTop ?? 0) > 56) setArchivePulled(false);
        }}
        {...gestures.bind}
      >
        {gestures.overlay}
        {/* Телефон (#218, Telegram Android `fragmentSearchField`, поля 7, `TA/ui/DialogsActivity.java:5338`): поле едет с лентой и
            гаснет по прокрутке (`--find-a`, `syncFindFade`); пока идёт поиск — прилипает сверху (`.on`); в режиме выбора — скрыто,
            но место держит (`.pick`), чтобы строки под пальцем не прыгали. */}
        {phone && dms.length > 0 && (
          <div ref={findZoneRef} className={`dm-find-zone${searchOpen ? ' on' : ''}${selecting ? ' pick' : ''}`}>
            {findZone}
          </div>
        )}
        {/* Бесед нет — на телефоне гусь в списке (кнопка «Написать» уже есть внизу), на ПК — в главной области. */}
        {phone && dmOff && (
          <div className="empty-goose">
            <Goose pose="look" size={132} />
            <div className="eg-title">Личные сообщения недоступны</div>
            <div className="eg-sub">{DM_SERVER_UPDATE_TEXT}. Каналы и голос работают как обычно.</div>
          </div>
        )}
        {phone && !dmOff && listKnown && dms.length === 0 && (
          <div className="empty-goose">
            <Goose pose="wave" size={132} />
            <div className="eg-title">Бесед пока нет</div>
            <div className="eg-sub">
              {guestHome ? dmEmptyHint(guestHome) : 'Напишите кому-нибудь — беседа появится здесь.'}
            </div>
          </div>
        )}
        {archiveRowShown && !q && !searchHome && !kindHits && (
          <DmArchiveRow
            list={archDms}
            unreadDms={unreadDms}
            unreadChats={archiveUnreadChats(archDms, unreadDms, shownDmId)}
            collapsed={archiveCollapsed && !archivePulled}
            onCollapsed={setArchiveCollapsed}
            onOpen={() => setInArchive(true)}
            phone={phone}
          />
        )}
        {searchHome && (
          <div className="dms-home-wrap" onMouseDown={(e) => e.preventDefault()}>
            <DmSearchHome
              dms={dms}
              frequent={frequent}
              recents={recent.recents}
              onPerson={(d) => openFromSearch(d.id)}
              onQuery={setQuery}
              onRemove={recent.remove}
              onClear={recent.clear}
              onMenuOpen={onFreqMenu}
            />
          </div>
        )}
        {listRows.map((d) => {
          // Точка «помечена непрочитанной» (G04, `conv13`) — как у Telegram: у беседы без новых сообщений; у открытой её нет.
          const counted = unreadDms.includes(d.id) && d.id !== shownDmId;
          const unread = counted || (d.markedUnread === true && d.id !== shownDmId);
          const unreadN = counted ? (d.unread ?? 0) : 0;
          return (
            <DmRow
              key={d.id}
              dm={d}
              summary={summaries[d.id]}
              meId={meId}
              online={onlineSet.has(d.otherUser.id)}
              active={!phone && d.id === currentDmId}
              unread={unread}
              unreadN={unreadN}
              draft={drafts[d.id]?.text || (voiceDrafts.has(d.id) && d.id !== currentDmId ? 'Голосовое сообщение' : undefined)}
              draftAt={drafts[d.id]?.text ? summaries[d.id]?.draft?.at : voiceDrafts.get(d.id)}
              draftReply={!!drafts[d.id]?.replyToId}
              onPick={phone ? togglePick : undefined}
              onDropMsgs={phone ? undefined : dropMsgs}
              onDropFiles={phone ? undefined : dropFiles}
              selecting={selecting}
              picked={selecting && picks.includes(d.id)}
              failed={!!outbox[d.id]?.some((x) => x.status === 'failed')}
              muted={muteActive(mutes.get(d.id), muteNow)}
              grayBadge={d.archived === true}
              pinned={!!d.pinnedAt}
              query={q}
              phone={phone}
              onOpen={gsearch && q ? openFromSearch : open}
              onMenu={openDmMenu}
              tabIndex={d.id === tabId ? 0 : -1}
              onFocusRow={setFocusId}
            />
          );
        })}
        {!q && !kindHits && dms.length > 0 && shown.length === 0 && folderUi.on && folderUi.empty}
        {/* Телефон (#218): без служебных строк над результатами — люди без беседы и «Глобальный поиск» по @логину, как у
            Telegram Android (`DialogsSearchAdapter`); ПК — прежняя строка «бесед нет» со ссылкой «Написать новому человеку». */}
        {kindHits && (
          <DmKindHits
            q={q}
            chips={chips}
            kind={kindHits}
            dms={dms}
            meId={meId}
            onLeave={(h) => {
              if (q.trim().length >= 2) recent.push({ kind: 'query', text: q });
              recent.push({ kind: 'person', convId: h.conversationId });
              blurFind();
            }}
          />
        )}
        {phone && q && !chipsOn && sv.dm && !kindHits && dms.length > 0 && <DmGlobalPeople q={q} dms={dms} onOpened={blurFind} />}
        {!phone && q && !chipsOn && sv.dm && dms.length > 0 && shown.length === 0 && (
          <div className="dm-empty dm-nores">
            <span>По запросу «{q}» бесед нет</span>
            <button type="button" className="link" onClick={() => openDmCompose(q)}>
              Написать новому человеку
            </button>
          </div>
        )}
        {/* Вкладка «Все» (08.10): личные и серверные сообщения одним списком по времени (`AllMessageHits`). */}
        {gsearch && !searchHome && !kindHits && sv.tabs && sv.dm && sv.servers && (
          <AllMessageHits
            q={q}
            dms={dms}
            meId={meId}
            onOpenDm={(h) => {
              if (q.trim().length >= 2) recent.push({ kind: 'query', text: q });
              recent.push({ kind: 'person', convId: h.conversationId });
              blurFind();
              openSearchHit(h);
            }}
            onOpenServer={(h) => {
              recent.push({ kind: 'query', text: q });
              blurFind();
              void openServerHit(h);
            }}
          />
        )}
        {gsearch && !searchHome && !kindHits && sv.dm && !(sv.tabs && sv.servers) && (
          <DmMessageHits
            q={q}
            chips={chips}
            dms={dms}
            meId={meId}
            onOpen={(h) => {
              if (q.trim().length >= 2) recent.push({ kind: 'query', text: q });
              recent.push({ kind: 'person', convId: h.conversationId });
              blurFind();
              openSearchHit(h);
            }}
          />
        )}
        {gsearch && !searchHome && !kindHits && sv.servers && !sv.dm && (
          <ServerMessageHits
            q={q}
            full={sv.serversFull}
            onShowAll={() => setScope('servers')}
            onOpen={(h) => {
              recent.push({ kind: 'query', text: q });
              blurFind();
              void openServerHit(h);
            }}
          />
        )}
      </div>

      {/* Телефон: плавающая «Написать» (design-step8 D1). Пока открыт поиск (фокус в поле или есть запрос), её нет —
          клавиатура подняла бы её на результаты. Поля нет (бесед нет) — поиска нет, даже если фокус не успел уйти. В режиме выбора (G01) её тоже нет — как у Telegram Android в режиме действий. В архиве — тоже (`folderId != 0`, `TA/ui/DialogsActivity.java:8846`). */}
      {phone && !dmOff && !selecting && !inArchive && !(dms.length > 0 && (findFocused || query)) && (
        <button type="button" className="dm-fab" aria-label="Написать" title="Написать" onClick={() => openDmCompose()}>
          <Icon name="edit" size={24} />
        </button>
      )}
      {compose.open && <NewDmSheet key={compose.seq} initialQuery={compose.query} />}
      <GroupDialogHost />
      <SharedMediaHost />
      {rowMenu}
      {listMenu}

      {voice && <VoicePanel />}
      <SelfVoiceBar />
    </div>
  );
}

/**
 * Аватар 56 ячейки: «Избранное» — закладка, остальные — фото или буква. Живёт рядом с `DmRow` (окно «Переслать» берёт
 * из `DmSidebar` и строку, и ячейку; проверки окна подменяют этот модуль целиком).
 */
export function ForwardAva({ saved = false, name, url }: { saved?: boolean; name: string; url?: string | null }) {
  return saved ? <SavedAvatar size={56} /> : <Avatar name={name} url={url} size={56} />;
}

/**
 * Ячейка сетки «Переслать в…» на телефоне (12.10, #218): аватар 56 с подписью в две строки под ним, четыре в ряд — как
 * `ShareDialogCell` Telegram Android (`ShareAlert`: аватар 56 dp с отступом сверху 7, имя 12 sp в две строки с отступом 66 и по
 * 6 по бокам, ячейка 103 dp, значок выбора 24 dp справа внизу аватара, у выбранного аватар сжат до 0.857 и обведён кольцом
 * 2 dp). Размеры лежат в `styles.css` (`.fwd-cell`). Нажатие зовёт `onOpen`; при `holdable` удержание пальцем (`DM_ROW_HOLD_MS`) или
 * правый щелчок — `onPick` (режим «поделиться»: нажатие — одна беседа, удержание — несколько), и сработавшее удержание
 * глотает щелчок отпускания (те же правила, что у `DmRow` и `ShareChannelRow`).
 */
export function ForwardCell({
  id,
  label,
  avatar,
  online = false,
  picked,
  selecting,
  holdable = false,
  onOpen,
  onPick,
}: {
  id: string;
  label: string;
  avatar: ReactNode;
  online?: boolean;
  picked: boolean;
  /** Режим выбора: ячейка — флажок (`role="checkbox"`). */
  selecting: boolean;
  holdable?: boolean;
  onOpen: (id: string) => void;
  onPick: (id: string) => void;
}) {
  const hold = useRef<{ timer: number | null; x: number; y: number; fired: boolean } | null>(null);
  const holdStop = () => {
    const h = hold.current;
    if (h?.timer != null) window.clearTimeout(h.timer);
    if (h) h.timer = null;
  };
  const holdFire = () => {
    const h = hold.current;
    holdStop();
    if (h) h.fired = true;
    navigator.vibrate?.(8);
    onPick(id);
  };
  return (
    <button
      type="button"
      className={`fwd-cell${picked ? ' picked' : ''}`}
      role={selecting ? 'checkbox' : undefined}
      aria-checked={selecting ? picked : undefined}
      onClick={() => {
        if (hold.current?.fired) {
          hold.current = null;
          return;
        }
        onOpen(id);
      }}
      onContextMenu={(e) => {
        if (!holdable) return;
        e.preventDefault();
        if (hold.current?.fired) return;
        if (hold.current) return holdFire();
        onPick(id);
      }}
      onTouchStart={(e) => {
        holdStop();
        hold.current = null;
        if (!holdable || e.touches.length !== 1) return;
        const t = e.touches[0];
        const h = { timer: null as number | null, x: t.clientX, y: t.clientY, fired: false };
        hold.current = h;
        h.timer = window.setTimeout(holdFire, DM_ROW_HOLD_MS);
      }}
      onTouchMove={(e) => {
        const h = hold.current;
        const t = e.touches[0];
        if (!h || !t) return;
        if (Math.abs(t.clientX - h.x) > DM_ROW_HOLD_SLOP || Math.abs(t.clientY - h.y) > DM_ROW_HOLD_SLOP) {
          holdStop();
          hold.current = null;
        }
      }}
      onTouchEnd={(e) => {
        holdStop();
        if (hold.current?.fired && e.cancelable) e.preventDefault();
      }}
      onTouchCancel={holdStop}
    >
      <span className="fwd-cell-ava">
        <span className="fwd-cell-pic">{avatar}</span>
        {online && !picked && (
          <span className="fwd-cell-dot">
            <StatusDot status="online" size={12} ringColor="currentColor" />
          </span>
        )}
        {picked && (
          <span className="fwd-cell-check">
            <Icon name="check" size={14} stroke={3} />
          </span>
        )}
      </span>
      <span className="fwd-cell-name">{label}</span>
    </button>
  );
}
