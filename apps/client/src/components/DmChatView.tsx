import { useEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, ConvMessage, ConvMute, ConvPin, ConvScheduled, DmChannel, Message, Sticker } from '@gusvoice/shared';
import type { GifPick } from './GifPicker';
import { serverDmStickers } from '../dmStickerRules';
import { useDmStickers } from '../dmStickers';
import { StickerCatalogPanel } from './StickerCatalogPanel';
import type { OutboxItem, OutboxRef } from '../outboxRules';
import { useChannelVisit } from '../channelVisit';
import { api } from '../api';
import { fireEffect } from '../effectsBus';
import { SEARCH_PAGE } from '../chatSearchRules';
import type { ChatSearchSource } from './ChatSearch';
import { setUploadDone, setUploadProgress, uploadAborted, uploadSignal } from '../uploadProgress';
import { confirmAction } from '../confirm';
import { serverStranger, strangerBarShown } from '../strangerBarRules';
import { contactLabel, isContact, serverContacts } from '../contactRules';
import { useContactList, useContacts } from '../contacts';
import { dmPeerLabel, peerNameNow, usePeerName } from '../peerName';
import { connLabel, useConnState } from '../connState';
import { sendTyping } from '../sockets';
import { clearOsNotifications } from '../notifications';
import { useStore } from '../store';
import { toast, toastError, useToasts } from '../toast';
import { typingActionLabel, useTyping, useTypingAction } from '../typing';
import { Avatar } from './Avatar';
import { explainCallPrivacy, useCall } from '../callStore';
import { serverCalls } from '../callView';
import { StrangerBar, StrangerReportModal } from './StrangerBar';
import { removeContactAsk } from './ContactEditModal';
import { ContextMenu, MenuDivider, MenuItem } from './ContextMenu';
import { clearHistory, deleteChat, deleteFormerGroup } from './dmClearActions';
import { useMuteClock } from './DmSidebar';
import { FeedLoadError } from './FeedLoadError';
import { Icon } from './Icon';
import { archiveDms } from './DmArchive';
import { archiveMenuLabel } from '../dmArchiveRules';
import { CHAT_MENU_EVENT } from './DesktopKeys';
import { useUserMenu } from './UserContextMenu';
import {
  MessagePane,
  type FeedWindowProps,
  type MessageBatch,
  type MessagePins,
  type MessageSendMenu,
} from './MessagePane';
import { ScheduledView } from './ScheduledView';
import { StatusDot } from './StatusDot';
import { useLastSeen } from '../useLastSeen';
import { dmDot, dmPresent, useLocalOnline } from '../dmOnline';
import { lastSeenLabel, serverLastSeen } from '../lastSeenText';
import { SavedAvatar, SavedEmpty } from './SavedAvatar';
import { chatReadKeyOf, groupMembersLabel, groupTypingLabel, typingNames } from '../groupChatRules';
import { leaveGroup, openGroupInfo } from './GroupDialogs';
import { newClientId } from '../clientId';
import { feedWindowSwitch, toOutboxRef } from '../convStore';
import {
  convCursor,
  peerReadKeyOf,
  SAVED_NAME,
  scheduledCountOf,
  serverBatchActions,
  serverDeletesOthersForBoth,
  serverDmPins,
  serverScheduled,
  serverChatClear,
  serverArchive,
  serverRounds,
  serverVoiceOnce,
  serverChatSearch,
  serverReactionsUnread,
  serverBigReactions,
  serverChatPrefs,
  serverScheduledAttachments,
  serverSilentSend,
  serverMediaFlags,
  serverQuote,
  serverSendFlags,
  serverForwardOptions,
  serverUnreadMark,
  serverGifs,
  serverPush4,
} from '../convSyncRules';
import { notifyAlwaysAction } from '../notifyExceptionsRules';
import { DM_MUTE_PRESETS, MUTE_CUSTOM_EVENT, dmMuteOf, dmPinLimitText, muteActive, mutePeriodLabel, muteLeftLabel, muteSoundOff } from '../dmListRules';
import { loadMuteRecent, saveMuteRecent } from '../muteRecent';
import { dmBubblesSwitch } from '../dmBubbles';
import { usePhoneLayout } from '../phoneLayout';
import { hasMoreOlder, olderCursor } from '../historyPage';

const EMPTY: Message[] = [];

/**
 * Закрепить / открепить беседу в своём списке (07.10, G02, сервер `conv11`) — действие для шапки беседы и будущего меню
 * строки списка. Лимит — тост «Достигнут лимит…» (Telegram, 03·1.2.3), прочие сбои — обычный тост ошибки.
 */
export function toggleDmPinned(convId: string, pinned: boolean): void {
  useStore
    .getState()
    .setConvPinned(convId, pinned)
    .catch((e: unknown) => {
      if ((e as { reason?: string }).reason === 'conv_pin_limit') toast('error', dmPinLimitText(undefined));
      else toastError(e);
    });
}

/**
 * Заблокировать / разблокировать собеседника (#212, «как в Telegram»): блокировка — после окна подтверждения, разблокировка —
 * сразу. Для шапки беседы и меню строки списка (07.10, G01); сбой — тост.
 */
export async function switchDmBlock(peer: DmChannel['otherUser'], blocked: boolean): Promise<void> {
  if (!blocked) {
    const ok = await confirmAction({
      title: `Заблокировать ${peerNameNow(peer.id, peer.displayName)}?`,
      body: `${peerNameNow(peer.id, peer.displayName)} не узнает об этом. Новые сообщения и «печатает» из этой беседы до вас не дойдут — даже после разблокировки. Чтобы написать самим, разблокируйте.`,
      tone: 'danger',
      confirmLabel: 'Заблокировать',
    });
    if (!ok) return;
  }
  const user = { id: peer.id, username: peer.username, displayName: peer.displayName, avatarUrl: peer.avatarUrl };
  await useStore.getState().setBlocked(user, !blocked).catch(toastError);
}

/**
 * Пункты «Выключить уведомления ▸» беседы (07.10, G03, сервер `conv11`, дополнено `conv13`), как подменю Telegram Desktop
 * (03·1.2.5): «Выключить звук» / «Включить звук» (только тон — уведомление остаётся), до двух запомненных сроков «Выключить
 * на …», «Выключить на время…» (второй вид — 1 час, 8 часов, 1 день, 2 дня, 7 дней и «Свой срок…» — выбор даты и времени, 09.10 `mute2`; прежние сроки от 15 минут до 3 месяцев
 * в подменю доживают, если запомнены), «Выключить уведомления» (навсегда, красным);
 * заглушена — «Включить уведомления» с остатком срока серым справа (Н16). Для шапки беседы и меню строки; `onDone` закрывает меню.
 */
export function DmMuteMenuItems({
  peerId,
  mute,
  now,
  onDone,
}: {
  peerId: string;
  mute: ConvMute | null;
  now: number;
  onDone: () => void;
}) {
  const soundMenu = useStore((s) => s.convActive && serverUnreadMark(s.serverFeatures));
  const [view, setView] = useState<'main' | 'time'>('main');
  const set = (muted: boolean, seconds?: number, soundOnly?: boolean) => {
    onDone();
    useStore.getState().setPushMuted('dm_user', peerId, muted, seconds, soundOnly).catch(toastError);
  };
  if (muteActive(mute, now)) {
    return <MenuItem icon="bell" label="Включить уведомления" shortcut={muteLeftLabel(mute, now) || undefined} note onClick={() => set(false)} />;
  }
  if (view === 'time') {
    return (
      <>
        <MenuItem icon="chevron-left" label="Выключить на время" onClick={() => setView('main')} />
        <MenuDivider />
        {DM_MUTE_PRESETS.map((p) => (
          <MenuItem
            key={p.seconds}
            icon="clock"
            label={p.label}
            onClick={() => {
              saveMuteRecent(p.seconds);
              set(true, p.seconds);
            }}
          />
        ))}
        <MenuItem
          icon="calendar-time"
          label="Свой срок…"
          onClick={() => {
            onDone();
            window.dispatchEvent(new CustomEvent<string>(MUTE_CUSTOM_EVENT, { detail: peerId }));
          }}
        />
      </>
    );
  }
  const soundOff = muteSoundOff(mute, now);
  return (
    <>
      {soundMenu && (
        <MenuItem
          icon={soundOff ? 'bell' : 'volume-off'}
          label={soundOff ? 'Включить звук' : 'Выключить звук'}
          onClick={() => (soundOff ? set(false) : set(true, undefined, true))}
        />
      )}
      {loadMuteRecent().map((s) => (
        <MenuItem key={s} icon="clock" label={`Выключить на ${mutePeriodLabel(s)}`} onClick={() => set(true, s)} />
      ))}
      <MenuItem icon="clock" label="Выключить на время…" submenu onClick={() => setView('time')} />
      <MenuDivider />
      <MenuItem icon="bell-off" label="Выключить уведомления" danger onClick={() => set(true)} />
    </>
  );
}
const NO_OUTBOX: OutboxItem[] = [];
const NO_PINS: ConvPin[] = [];
const NO_GONE: Record<string, true> = {};

/**
 * id отправки пересылки (раунд 12) — один на пачку «откуда → куда → какие», пока она не дошла: сервер узнаёт повтор
 * (200 и те же сообщения) — сбой сети после того, как сервер уже переслал, не даст дублей при второй попытке. Модульный, а
 * не в состоянии ленты: лента пересоздаётся при смене беседы.
 */
const forwardKeys = new Map<string, string>();

export function DmChatView({ dm }: { dm: DmChannel }) {
  const messagesRaw = useStore((s) => s.dmMessages[dm.id]);
  const messages = messagesRaw ?? EMPTY;
  const user = useStore((s) => s.user);
  /* «Кто поставил» (07.10): в ЛС реакции ставят двое — я и собеседник; лента берёт их имя и аватар отсюда (аватарки на чипе,
     окно «кто поставил»). Ссылка новая, только когда у кого-то из двоих сменились имя или аватар. */
  const meId = user?.id;
  const meName = user?.displayName;
  const meAvatar = user?.avatarUrl ?? null;
  const peer = dm.otherUser;
  /* Подпись контакта заменяет имя везде в ЛС и группах (решение владельца 08.10 п.27, `peerName.ts`): шапка, окна, поле ввода,
     авторы и цитаты в группе. Настоящее имя остаётся в `peerPerson` — его ждёт окно «Изменить контакт». */
  const nameOf = usePeerName();
  const peerName = dmPeerLabel(dm, nameOf);
  const reactorOf = useMemo(
    () => (id: string) =>
      id === peer.id
        ? { name: peerName, avatarUrl: peer.avatarUrl ?? null }
        : meId && id === meId
          ? { name: meName ?? '', avatarUrl: meAvatar }
          : null,
    [peer.id, peerName, peer.avatarUrl, meId, meName, meAvatar],
  );
  const appendDmMessage = useStore((s) => s.appendDmMessage);
  const updateDmMessage = useStore((s) => s.updateDmMessage);
  const removeDmMessage = useStore((s) => s.removeDmMessage);
  // Заглушка (07.10, G03): из сводки (`conv11`) или из списка заглушек; срок вышел — часы перерисуют шапку сами.
  const mutedUsers = useStore((s) => s.pushMutedDmUsers);
  const muteUntil = useStore((s) => s.pushMuteUntil);
  const mute = dmMuteOf(dm, mutedUsers, muteUntil);
  const muteNow = useMuteClock([mute]);
  const pushMuted = muteActive(mute, muteNow);
  const setPushMuted = useStore((s) => s.setPushMuted);
  // Закреп беседы и сроки заглушки — только у сервера с `conv11` и в режиме бесед; иначе колокольчик — прежний тумблер.
  const prefsOn = useStore((s) => s.convActive && serverChatPrefs(s.serverFeatures));
  /* «Личные» / группы выключены (решение владельца 38, `push4`): пункт меню — «Включить уведомления» этой беседы (исключение)
     или «Выключить уведомления» (снять его), как Telegram; иначе — заглушки, как было. */
  const alwaysAct = useStore((s) =>
    notifyAlwaysAction(dm.otherUser.id, {
      push4: serverPush4(s.serverFeatures),
      notifyDm: s.user?.notifyDm,
      notifyGroups: s.user?.notifyGroups,
      always: s.pushAlwaysTargets,
    }),
  );
  const archiveOn = useStore((s) => s.convActive && serverArchive(s.serverFeatures));
  // «Прослушать один раз» (`voice3`, G54) — только личка 1:1 с человеком: не группа и не «Избранное» (tdesktop `TTLButton`).
  const voiceOnceOn = useStore((s) => s.convActive && serverVoiceOnce(s.serverFeatures)) && !dm.group && !dm.saved;
  /** Кружки (`circles1`, G68) — только режим бесед и сервер с признаком; без него у кнопки записи нет режима камеры. */
  const roundOn = useStore((s) => s.convActive && serverRounds(s.serverFeatures));
  const clearOn = useStore((s) => s.convActive && serverChatClear(s.serverFeatures));
  // Поиск в беседе и «Перейти к дате» (G05, G25): сервер с `search1` и окно ленты (переход «вокруг» найденного).
  const searchFlag = useStore((s) => s.convActive && serverChatSearch(s.serverFeatures));
  // Кнопки «@» / «♥» над «вниз» (G24, `reactunread1`): числа — из сводки беседы, действия — из стора и `api`.
  const reactFlag = useStore((s) => s.convActive && serverReactionsUnread(s.serverFeatures));
  // «Большая» реакция удержанием (G43, `bigreact1`): только беседам нового сервера.
  const bigFlag = useStore((s) => s.convActive && serverBigReactions(s.serverFeatures));
  const unreadReactions = useStore((s) => s.conv.summaries[dm.id]?.unreadReactions ?? 0);
  const unreadMentions = useStore((s) => s.conv.summaries[dm.id]?.unreadMentions ?? 0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [bellAt, setBellAt] = useState<DOMRect | null>(null);
  const pinned = !!dm.pinnedAt;
  const loadOlderDmMessages = useStore((s) => s.loadOlderDmMessages);
  const refreshDmHistory = useStore((s) => s.refreshDmHistory);
  const failed = useStore((s) => s.historyFailed.includes(dm.id));
  const blocked = useStore((s) => s.blockedUsers.some((u) => u.id === dm.otherUser.id));
  // Режим бесед (ЛС этап 2): те же действия через `/api/conv/*` с id отправки; события — `conv.change`.
  const convActive = useStore((s) => s.convActive);
  // Исходящие беседы (шаг 2в): в сторе по беседе — переживают смену беседы, голос и перезапуск, повторяются сами.
  const outboxItems = useStore((s) => s.outbox[dm.id] ?? NO_OUTBOX);
  // Черновик (шаг 2д): читается ОДИН раз при создании ленты — подписка на него перерисовывала бы беседу на каждую букву.
  const [initialDraft] = useState(() => (convActive ? useStore.getState().drafts[dm.id] : undefined));
  /* Черновик с другого моего устройства (Р7): подписка на СЧЁТЧИК пришедших, не на сам черновик — он меняется только
     пришедшим, а не каждой буквой здесь. */
  const draftRev = useStore((s) => (convActive ? (s.draftRev[dm.id] ?? 0) : 0));
  const draftRemote = useMemo(() => {
    if (!draftRev) return undefined;
    const d = useStore.getState().drafts[dm.id];
    return { text: d?.text ?? '', replyToId: d?.replyToId ?? null, rev: draftRev };
  }, [draftRev, dm.id]);
  // Окно ленты (шаг 2г): только в режиме бесед и с переключателем устройства — до приёмки владельцем.
  const [feedWin] = useState(() => convActive && feedWindowSwitch());
  // ЛС как в Telegram (Р13): пузыри — до приёмки владельцем за переключателем устройства (`dmBubbles.ts`).
  const [bubbles] = useState(dmBubblesSwitch);
  /* ✓✓ «прочитано собеседником» (Р6): ключ из сводки беседы — только в режиме бесед и с пузырями (у старой ленты
     отметок нет). Подписка на ЧИСЛО: перерисовка — только когда собеседник прочитал дальше, а не на каждую сводку. */
  // «Избранное» (`saved1`): сообщения сразу «прочитаны» (✓✓, как у Telegram, где читать их некому, кроме меня).
  const saved = !!dm.saved;
  const peerReadKey = useStore((s) =>
    !convActive || !bubbles
      ? null
      : saved
        ? Number.MAX_SAFE_INTEGER
        : s.conv.summaries[dm.id]?.group
          ? chatReadKeyOf(s.conv.summaries[dm.id])
          : peerReadKeyOf(s.conv.summaries[dm.id]),
  );
  const win = useStore((s) => (feedWin ? s.conv.windows[dm.id] : undefined));
  const unreadBelow = useStore((s) => (feedWin ? (s.conv.summaries[dm.id]?.unread ?? 0) : 0));
  /* Раунд 12, порция 5: пересылка, выделение и удаление пачкой — только в режиме бесед и у сервера с `conv5` (ручки —
     `/api/conv/*`); чужое «у обоих» — с `conv6` (С1). Старый сервер или старый путь ЛС — ни пунктов, ни выделения, ни
     галочки у чужого. Видно это только за переключателем пузырей — его проверяет лента (`MessagePane.round12`). */
  const batchOn = useStore((s) => s.convActive && serverBatchActions(s.serverFeatures));
  // «Без звука» (С3, `conv8`): и у меню «Отправить», и у «Переслать в…» (галочка в окне).
  const silentOn = useStore((s) => bubbles && s.convActive && serverSilentSend(s.serverFeatures));
  /** «Скрыть имя отправителя / подписи» у пересылки (G71, `fwd2`). */
  const forwardOptsOn = useStore((s) => s.convActive && serverForwardOptions(s.serverFeatures));
  /** «Отправить позже» в окне «Переслать в…» (G71): тот же признак, что у отложенных (`schedOn` ниже). */
  const schedForward = useStore((s) => bubbles && s.convActive && serverScheduled(s.serverFeatures));
  /** Флаги отправки (G19 + G48, `linkprev1`): «без превью» и «как файл». */
  const sendFlagsOn = useStore((s) => s.convActive && serverSendFlags(s.serverFeatures));
  /** «Высокое качество», спойлер и подпись над медиа в окне отправки файлов (G48, `media2`). */
  const mediaFlagsOn = useStore((s) => s.convActive && serverMediaFlags(s.serverFeatures));
  /** Цитата фрагмента и «Ответить в другом чате» (G55, `quote1`). */
  const quoteOn = useStore((s) => s.convActive && serverQuote(s.serverFeatures));
  // Стикеры в ЛС (С2, `stickers2`): мои наборы, недавние, каталог инстанса во вкладке панели; окно набора из ленты шлёт сюда.
  const stickersOn = useStore((s) => s.convActive && serverDmStickers(s.serverFeatures));
  const myStickers = useDmStickers((s) => s.mine);
  const recentStickers = useDmStickers((s) => s.recent);
  // GIF (`gifs1`, Р-7): «Мой GIF» или найденный — сервер копирует файл вложением этой беседы, дальше обычная отправка
  // с подсказкой `gif: true` (видео без звука по кругу). «Сохранить GIF» — из меню сообщения.
  const gifsOn = useStore((s) => s.convActive && serverGifs(s.serverFeatures));
  const sendGif = async (pick: GifPick) => {
    const a =
      pick.kind === 'saved'
        ? await api.gifAttach(pick.gif.id, dm.id)
        : await api.gifExternalAttach({ conversationId: dm.id, url: pick.gif.url, width: pick.gif.width, height: pick.gif.height });
    const msg = await api.convSend(dm.id, {
      clientId: newClientId(),
      content: '',
      attachments: [{ id: a.attachmentId, width: a.width, height: a.height, durationMs: a.durationMs, gif: true }],
    });
    useStore.getState().convAfterSend(dm.id, msg);
  };
  const saveGif = (a: Attachment) => {
    const attachmentId = a.id;
    if (!attachmentId) return;
    api
      .gifSave({ attachmentId, width: a.width ?? null, height: a.height ?? null, durationMs: a.durationMs ?? null })
      .then(() => toast('success', 'GIF сохранён'))
      .catch(toastError);
  };
  const sendStickerRef = useRef<(stickerId: string) => Promise<void>>(async () => {});
  sendStickerRef.current = async (stickerId: string) => {
    const msg = await api.convSend(dm.id, { clientId: newClientId(), content: '', attachments: [], stickerId });
    useStore.getState().convAfterSend(dm.id, msg);
  };
  useEffect(() => {
    if (!stickersOn) return;
    void useDmStickers.getState().load().catch(() => {});
    // С2 порция 2 (`stickers3`): избранные и недавние с сервера — на каждой беседе заново (события между ними могли пропасть).
    void useDmStickers.getState().loadLists(true).catch(() => {});
    const st = useDmStickers.getState();
    const sender = (sticker: Sticker) => {
      void sendStickerRef.current(sticker.id).then(
        () => useDmStickers.getState().used(sticker),
        toastError,
      );
    };
    st.setSender(sender);
    return () => {
      if (useDmStickers.getState().sender === sender) useDmStickers.getState().setSender(null);
    };
  }, [stickersOn, dm.id]);
  const othersForBoth = useStore((s) => s.convActive && serverDeletesOthersForBoth(s.serverFeatures));
  /* Бывшая группа (`groups3`): пересылка ИЗ неё и удаление пачкой — «нет такой» у сервера (`loadAccess` исходной беседы), потому пачки нет. */
  const former = useStore((s) => s.conv.summaries[dm.id]?.former ?? null);
  const batch = useMemo<MessageBatch | undefined>(
    () =>
      batchOn && !former
        ? {
            silentForward: silentOn,
            // «Скрыть имя отправителя / подписи» (G71, `fwd2`): поля шлём только при признаке — старый сервер выдал бы автора.
            hideOptions: forwardOptsOn,
            // «Комментарий» окна «Переслать в…» (G71, Telegram `ShareBox`): обычное сообщение до пересланных.
            comment: async (to, content, silent) => {
              const msg = await api.convSend(to, {
                clientId: newClientId(),
                content,
                attachments: [],
                ...(silent && silentOn ? { silent: true } : {}),
              });
              useStore.getState().convAfterSend(to, msg);
            },
            // «Отправить позже» окна «Переслать в…»: каждый текст — отложенное в беседу `to` (с ним уходит и «без звука»);
            // время сдвинуто на миллисекунды, чтобы порядок сообщений сохранился.
            ...(schedForward
              ? {
                  later: async (to: string, texts: string[], at: Date, silent: boolean) => {
                    for (const [i, content] of texts.entries()) {
                      const res = await api.convSchedule(to, {
                        clientId: newClientId(),
                        content,
                        sendAt: new Date(at.getTime() + i).toISOString(),
                        ...(silent && silentOn ? { silent: true } : {}),
                      });
                      useStore.getState().convSetScheduled(to, res);
                    }
                  },
                }
              : {}),
            forward: async (messageIds, to, silent, opts) => {
              // `opts.from` — черновик пересылки (08.10): в поле ЭТОЙ беседы ждут сообщения другой (`fwdDrafts`).
              const from = opts?.from ?? dm.id;
              const key = `${from}>${to}:${messageIds.join(',')}`;
              const clientId = forwardKeys.get(key) ?? newClientId();
              forwardKeys.set(key, clientId);
              const res = await api.convForward(to, {
                clientId,
                fromConversationId: from,
                messageIds,
                ...(silent && silentOn ? { silent: true } : {}),
                ...(forwardOptsOn && opts?.hideSender ? { hideSender: true } : {}),
                ...(forwardOptsOn && opts?.hideCaptions ? { hideCaptions: true } : {}),
              });
              forwardKeys.delete(key);
              useStore.getState().convAfterForward(to, res.messages);
            },
            deleteMany: async (messageIds, scope) => {
              await api.convDeleteMany(dm.id, messageIds, scope);
              useStore.getState().convAfterDeleteMany(dm.id, messageIds);
            },
            peerName: (id) => {
              const u = useStore.getState().dms.find((d) => d.id === id)?.otherUser;
              return u ? peerNameNow(u.id, u.displayName) : '';
            },
            open: (id) => void useStore.getState().selectDm(id),
          }
        : undefined,
    [batchOn, former, silentOn, schedForward, forwardOptsOn, dm.id],
  );
  /* Раунд 12, порция 7 — закреп в ЛС (С2, `conv7`): только за переключателем пузырей, в режиме бесед и у сервера с
     признаком; иначе ни запроса, ни пунктов, ни полосы. Список — в сторе (`conv.pins`): загрузка при открытии беседы,
     дальше его ведут `conv.change` с полем `pins` и догонка. Сброшен (смена токена, обрезанный журнал) — просим заново. */
  // Бывшая группа (`groups3`): закрепы — только участникам, запроса нет (сервер ответил бы «нет такой»).
  const pinsOn = useStore((s) => bubbles && s.convActive && serverDmPins(s.serverFeatures) && !s.conv.summaries[dm.id]?.former);
  const pinsEntry = useStore((s) => (pinsOn ? s.conv.pins?.[dm.id] : undefined));
  // Удалённое мной — из полосы сразу, не дожидаясь события со списком (оно идёт следом за событием о сообщении).
  const gone = useStore((s) => (pinsOn ? s.conv.gone : NO_GONE));
  const pinsKnown = !!pinsEntry;
  const pinsAsked = useRef(false);
  useEffect(() => {
    if (!pinsOn || (pinsKnown && pinsAsked.current)) return;
    pinsAsked.current = true;
    let shown = true;
    api.convPins(dm.id).then(
      (res) => useStore.getState().convSetPins(dm.id, res),
      (e) => {
        if (shown) toastError(e, 'Не удалось загрузить закреплённые');
      },
    );
    return () => {
      shown = false;
    };
  }, [pinsOn, pinsKnown, dm.id]);
  const pinList = useMemo(() => {
    const list = pinsEntry?.list ?? NO_PINS;
    return list.some((p) => gone[p.message.id]) ? list.filter((p) => !gone[p.message.id]) : list;
  }, [pinsEntry, gone]);
  const pins = useMemo<MessagePins | undefined>(
    () =>
      pinsOn
        ? {
            list: pinList,
            pin: async (messageId, scope) => {
              useStore.getState().convSetPins(dm.id, await api.convPin(dm.id, messageId, scope));
            },
            unpin: async (messageId, scope) => {
              useStore.getState().convSetPins(dm.id, await api.convUnpin(dm.id, messageId, scope));
            },
          }
        : undefined,
    [pinsOn, pinList, dm.id],
  );
  /* Чёрный список (#212, «как в Telegram»): собеседник не узнает, его новые сообщения сюда не дойдут. */
  const switchBlock = () => switchDmBlock(dm.otherUser, blocked);
  /* Плашка незнакомца (08.10, `stranger1`, С7): сервер говорит, кто незнакомец; я гашу её сразу при блокировке и ответе. */
  const strangerOn = useStore((s) => s.convActive && serverStranger(s.serverFeatures));
  const isStranger = useStore((s) => s.conv.summaries[dm.id]?.stranger === true);
  const [reportOpen, setReportOpen] = useState(false);
  /* Контакты (08.10, `contacts1`): у беседы 1:1 с живым человеком; гостю соседнего инстанса — нет (сервер ответит 403). */
  const contactsOn =
    useStore((s) => s.convActive && serverContacts(s.serverFeatures)) && !user?.homeInstance && !dm.group && !dm.saved;
  const contacts = useContactList(contactsOn);
  const peerContact = contacts?.find((c) => c.id === peer.id) ?? null;
  const peerPerson = { id: peer.id, username: peer.username, displayName: peer.displayName, avatarUrl: peer.avatarUrl };
  // Плашка гаснет сразу, как человек в контактах (Telegram: `user->isContact()` → `Type::None`); сервер гасит её в сводке сам.
  const strangerBar =
    strangerBarShown({
      feature: strangerOn,
      stranger: isStranger,
      blocked,
      group: !!dm.group,
      hasOwnMessage: outboxItems.length > 0 || messages.some((m) => m.author.id === meId),
    }) && !isContact(contacts, peer.id);
  const blockQuiet = () =>
    useStore
      .getState()
      .setBlocked({ id: peer.id, username: peer.username, displayName: peer.displayName, avatarUrl: peer.avatarUrl }, true);
  /* «печатает» в беседе — ТОЛЬКО в шапке, как в Telegram (решение владельца 04.10, раунд 11): строки «X печатает…»
     над полем ввода у ЛС нет, `typingUsers` в ленту не передаётся (каналы серверов её сохраняют). */
  const directTyping = useTyping(dm.id).includes(dm.otherUser.id);
  // Группа (07.10, `groups1`, С4): шапка — «N участников», «печатает» — с именами (`groupChatRules.groupTypingLabel`).
  const typers = useTyping(dm.id);
  const group = dm.group ?? null;
  // Бывшая группа (08.10, `groups3`): вышел или удалили — только чтение (Telegram: `YouLeft` / `YouWereKicked` в шапке,
  // `DeleteThisGroup` вместо поля ввода).
  const groupMentions = useMemo(
    () =>
      group
        ? {
            users: group.members
              .filter((m) => m.id !== meId)
              .map((m) => ({ id: m.id, username: m.username, displayName: m.displayName, avatarUrl: m.avatarUrl })),
            roles: [],
            channels: [],
            noBroadcast: true,
          }
        : undefined,
    [group, meId],
  );
  const typing = group ? typers.length > 0 : directTyping;
  // Что именно делает собеседник (G21): «печатает» / «записывает голосовое» / «отправляет фото|видео|файл».
  const actionLabel = typingActionLabel(useTypingAction(dm.id, dm.otherUser.id));
  const typingLabel = group ? groupTypingLabel(typingNames(group, typers)) : actionLabel;
  // Шапка (раунд 11): «в сети» — тот же признак, что точка в списке.
  // `presence4`: в ЛС «Невидимый» тоже в сети (`dmOnlineUsers`), «Никто» не прячет «в сети» — только время у вышедшего.
  // `presence5` (D4, решение 42): свёрнутое или простаивающее приложение собеседника — в ЛС не в сети (`dmPresent`).
  const rawOnline = useStore((s) => dmPresent(s, dm.otherUser.id));
  const features = useStore((s) => s.serverFeatures);
  /* Связи с сервером нет (замечание владельца 05.10, как у Telegram): вместо статуса собеседника — «Соединение…» или
     «Ожидание сети…» (`connState.ts`); «в сети», точка у аватара и «печатает» в это время устарели и не показываются. */
  const conn = connLabel(useConnState());
  /* «Был(а) в сети» (С1, `lastseen1`): «был(а) 5 минут назад / сегодня в 14:30 / недавно» вместо пустой строки, как у
     Telegram; без признака сервера — `null`, шапка как раньше. «В сети» — по-прежнему точка шлюза. */
  const lastSeen = useLastSeen(group || saved ? null : dm.otherUser.id);
  /* Р-2 (`lastseen2`, сервер без `presence4`): время захода собеседника мне скрыто — ни «в сети», ни точки, а «был(а) недавно».
     С `presence4` (решение владельца 08.10) «в сети» — по присутствию всегда, скрытое время даёт «был(а) недавно» только вышедшему. */
  const localOnline = useLocalOnline(group || saved ? null : dm.otherUser.id);
  const online = dmDot(rawOnline, lastSeen?.exact, features, localOnline);
  /* O5 (приёмка S20+, 09.10): снимок «был(а)» ещё `online:true` (приходит позже присутствия — `online.away` / `online.update`), а «в сети»
     уже нет — раньше строка была пустой ~1,5 с. Теперь сразу «был(а) только что» (время мне видно) или «был(а) недавно» (скрыто
     приватностью — точное не раскрываем). Пусто — только пока снимка нет вовсе или человек в сети. */
  const seenText = !lastSeen || online ? '' : lastSeen.online ? (lastSeen.exact ? 'был(а) только что' : 'был(а) недавно') : lastSeenLabel(lastSeen, new Date());
  const lastSeenOn = useStore((s) => serverLastSeen(s.serverFeatures));
  const peerOnline = online && !conn;
  const peerTyping = typing && !conn;
  const phone = usePhoneLayout();

  /* Шапка кликабельна (G06, Telegram 03·2.2.1 / 2.2.3): аватар и имя открывают карточку собеседника — на ПК та же карточка,
     что по клику на аватар в ленте (`useUserMenu`, вид «profile»), на телефоне она же листом снизу. Меню «⋯» — те же
     действия, что раньше были отдельными кнопками (уведомления, заблокировать) + «Показать профиль». */
  const { openAt: openUserCardAt, menu: userCard } = useUserMenu();
  const [moreAt, setMoreAt] = useState<{ x: number; y: number } | null>(null);
  /* Ctrl+\ — меню беседы с клавиатуры (G65; Telegram `Command::ShowChatMenu` → `_topBar->showPeerMenu()`). Клавишу ловит
     `DesktopKeysHost` (только десктоп) и шлёт событие; меню раскрывается под кнопкой «⋯», как по клику. */
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const open = () => {
      const r = moreBtnRef.current?.getBoundingClientRect();
      if (r) setMoreAt((cur) => (cur ? null : { x: r.right, y: r.bottom + 4 }));
    };
    window.addEventListener(CHAT_MENU_EVENT, open);
    return () => window.removeEventListener(CHAT_MENU_EVENT, open);
  }, []);
  const peerTarget = {
    userId: dm.otherUser.id,
    name: peerName,
    avatarUrl: dm.otherUser.avatarUrl,
    username: dm.otherUser.username,
    convId: dm.id,
  };
  const showProfile = (el: HTMLElement | null) => {
    const r = el?.getBoundingClientRect();
    openUserCardAt({ x: r?.left ?? 0, y: (r?.bottom ?? 0) + 8 }, peerTarget, 'profile');
  };

  /* Раунд 12, порция 8 — меню кнопки «Отправить» и «Отложенные» (С3 `conv8`, С4 `conv9`): только за переключателем пузырей,
     в режиме бесед и у сервера с признаком; иначе ни пунктов, ни входа. Список отложенных — в сторе (`conv.scheduled`):
     загрузка при открытии вида, дальше его ведут `conv.change` с полем `scheduled` и догонка; число для входа — оттуда же
     или из сводки (`scheduledCount`). */
  const schedOn = useStore((s) => bubbles && s.convActive && serverScheduled(s.serverFeatures));
  // Отложенные С ВЛОЖЕНИЯМИ (06.10, `conv10`): без признака «позже» и «когда в сети» с файлами — серые.
  const schedMedia = useStore((s) => schedOn && serverScheduledAttachments(s.serverFeatures));
  const schedEntry = useStore((s) => (schedOn ? s.conv.scheduled?.[dm.id] : undefined));
  const schedCount = useStore((s) =>
    schedOn ? scheduledCountOf(s.conv.scheduled?.[dm.id], s.conv.summaries[dm.id]) : 0,
  );
  const [schedOpen, setSchedOpen] = useState(false);
  // Вид открыт — свежий список (до ответа — то, что уже в памяти). Не вышло — тост и назад к беседе.
  useEffect(() => {
    if (!schedOpen || !schedOn) return;
    let shown = true;
    api.convScheduled(dm.id).then(
      (res) => useStore.getState().convSetScheduled(dm.id, res),
      (e) => {
        if (!shown) return;
        toastError(e, 'Не удалось загрузить отложенные');
        setSchedOpen(false);
      },
    );
    return () => {
      shown = false;
    };
  }, [schedOpen, schedOn, dm.id]);
  // Отложенных не осталось (ушли, удалены — здесь или на другом устройстве) — вид закрывается сам, как в Telegram.
  useEffect(() => {
    if (schedOpen && (!schedOn || (schedEntry && schedEntry.list.length === 0))) setSchedOpen(false);
  }, [schedOpen, schedOn, schedEntry]);
  const setScheduled = (res: { pts: number; items: ConvScheduled[] }) =>
    useStore.getState().convSetScheduled(dm.id, res);
  const sendMenu: MessageSendMenu | undefined =
    silentOn || schedOn
      ? {
          silent: silentOn,
          later: schedOn,
          /* «Когда будет в сети» — всегда, в сети собеседник или нет (решение владельца 05.10): в сети — сервер отправит на
             ближайшем такте планировщика (5 с), «это ок». Прятать пункт по «в сети» в памяти не нужно. */
          /* С1 (`lastseen1`, сверено с Telegram `CanScheduleUntilOnline`): только если время захода собеседника мне видно —
             иначе момент доставки выдал бы, когда он зашёл (сервер такое отклонит). Старый сервер — как раньше, всегда. */
          /* Группа (`groups2`) и «Избранное» (`saved1`, сервер отвечает 409): у Telegram пункта нет (`CanScheduleUntilOnline` — только личная беседа с человеком). */
          whenOnline: schedOn && !group && !saved && (!lastSeenOn || lastSeen?.exact === true),
          media: schedMedia,
          /* С вложениями (`conv10`): файлы — сразу в закрытое хранилище тем же путём, что у отправки (`convUpload`: размеры
             картинки меряются при загрузке), по одному, затем отложенное с их id. Пока грузятся — тост «Загружаем файлы…»
             (поле уже пустое). Сбой — исключение: лента вернёт в поле текст и файлы; загруженное, но не отложенное
             останется незавершённым и уйдёт суточной уборкой сервера. */
          schedule: async ({ content, replyToId, at, files = [], silent, asFile, spoilers, captionAbove }) => {
            const clientId = newClientId();
            const busy = files.length > 0 ? toast('info', 'Загружаем файлы…', 'Сообщение будет отложено', { sticky: true }) : null;
            try {
              const attachments: OutboxRef[] = [];
              for (const file of files) attachments.push(toOutboxRef(await api.convUpload(dm.id, file)));
              // Пометки окна отправки файлов (G48): «как файл» и спойлер — подсказками у вложений, как у обычной отправки.
              const hinted = attachments.map((r, i) => ({
                ...r,
                ...(asFile ? { asFile: true as const } : {}),
                ...(spoilers?.includes(i) ? { spoiler: true as const } : {}),
              }));
              setScheduled(
                await api.convSchedule(dm.id, {
                  clientId,
                  content,
                  replyToId,
                  ...(attachments.length > 0 ? { attachments: hinted } : {}),
                  ...(silent && silentOn ? { silent: true } : {}),
                  ...(captionAbove ? { captionAbove: true } : {}),
                  ...(at ? { sendAt: at.toISOString() } : { whenOnline: true }),
                }),
              );
            } finally {
              if (busy !== null) useToasts.getState().dismiss(busy);
            }
          },
          scheduledCount: schedCount,
          openScheduled: () => setSchedOpen(true),
          view: schedOpen ? (
            <ScheduledView
              items={schedEntry?.list ?? null}
              peerName={peerName}
              me={{ name: user?.displayName ?? '', avatarUrl: user?.avatarUrl ?? null }}
              onBack={() => setSchedOpen(false)}
              silentToggle={silentOn}
              create={async (content, at, silent) => {
                setScheduled(
                  await api.convSchedule(dm.id, {
                    clientId: newClientId(),
                    content,
                    sendAt: at.toISOString(),
                    ...(silent && silentOn ? { silent: true } : {}),
                  }),
                );
              }}
              sendNow={async (id) => {
                const res = await api.convScheduledSendNow(dm.id, id);
                const st = useStore.getState();
                st.convAfterSend(dm.id, res.message);
                st.convSetScheduled(dm.id, { pts: res.pts, items: res.items });
              }}
              reschedule={async (id, at) => {
                setScheduled(await api.convScheduledEdit(dm.id, id, { sendAt: at.toISOString() }));
              }}
              edit={async (id, content) => {
                setScheduled(await api.convScheduledEdit(dm.id, id, { content }));
              }}
              remove={async (id) => {
                setScheduled(await api.convScheduledDelete(dm.id, id));
              }}
            />
          ) : undefined,
        }
      : undefined;

  /* Та же метка визита, что и в канале сервера (#15) — правила и телефонная ловушка описаны в
     `channelVisit.ts`. */
  const { newSince, readKey, visitKey, started } = useChannelVisit(dm.id, 'dm');
  /* Беседа дочитана (здесь или на другом устройстве) — убрать её уведомления ОС (G09, как у Telegram). */
  const unreadNow = useStore((s) => (convActive ? (s.conv.summaries[dm.id]?.unread ?? 0) : -1));
  useEffect(() => {
    if (unreadNow === 0) clearOsNotifications(dm.id);
  }, [unreadNow, dm.id]);

  /* Снимок на начало визита (шаг 2г): ключ прочитанного снят `useChannelVisit` ДО «прочитано» — черта «Новые
     сообщения» не ползёт, пока читаешь; место — только когда непрочитанного нет (последнее сообщение сводки против
     снятого ключа). */
  const visitStart = useMemo(() => {
    if (!feedWin) return null;
    const s = useStore.getState();
    const last = s.conv.summaries[dm.id]?.lastMessage;
    const unread = readKey !== null && !!last && last.sortKey > readKey && last.authorId !== s.user?.id;
    return { readKey, place: unread ? null : (s.places[dm.id] ?? null) };
  }, [visitKey, readKey, feedWin, dm.id]);
  const feedWindow: FeedWindowProps | undefined = visitStart
    ? {
        hasOlder: win?.hasMoreBefore ?? true,
        hasNewer: !!win?.hasMoreAfter,
        loadNewer: () => useStore.getState().convLoadNewer(dm.id),
        jumpLatest: () => useStore.getState().convJumpLatest(dm.id),
        jumpTo: (id) => useStore.getState().convJumpTo(dm.id, id),
        unreadBelow,
        place: visitStart.place,
        onPlace: (p) => useStore.getState().convSetPlace(dm.id, p),
        readKey: visitStart.readKey,
        stale: !!win?.stale,
      }
    : undefined;
  // Бывшая группа: поиск по её ленте сервер не отдаёт (`/conv/:id/search` — «нет такой»).
  const searchOn = searchFlag && !!feedWindow && !former;
  // Звонок 1:1 (С5, `calls1`): трубка в шапке, как tdesktop `TopBarWidget` / tweb `ChatTopbar` — между поиском и «⋯». Только
  // беседа 1:1 (не группа, не «Избранное»), заблокированному не звоним (сервер всё равно ответит 403).
  // «Кто может звонить» (`presence4`, решение владельца 08.10 п.25): собеседник запретил мне звонить (`canCall === false` из
  // `GET /users/:id/last-seen`) — трубка ОСТАЁТСЯ, по нажатию окно «ограничил(а) звонки» (как Telegram), звонка нет.
  const callsOn =
    useStore((s) => s.convActive && serverCalls(s.serverFeatures)) && !group && !saved && !former && !blocked;
  const callsDenied = lastSeen?.canCall === false;
  const inCall = useCall((s) => !!s.call);
  const chatSearch: ChatSearchSource | undefined = searchOn
    ? {
        open: searchOpen,
        setOpen: setSearchOpen,
        search: (q, before) => api.convSearch(dm.id, q, before, SEARCH_PAGE),
        jumpToDate: (day) => useStore.getState().convJumpToDate(dm.id, day),
      }
    : undefined;

  /* Медиатека беседы для просмотра (G11): порции истории за краем окна ленты. Беседы — `convHistory` в обе стороны (удалённое
     у меня — мимо), старый путь ЛС — только старше. */
  const loadMediaPage = async (dir: -1 | 1, edge: Message): Promise<{ messages: Message[]; more: boolean }> => {
    if (convActive) {
      const sortKey = (edge as Partial<ConvMessage>).sortKey;
      if (typeof sortKey !== 'number') return { messages: [], more: false };
      const cur = convCursor({ sortKey, id: edge.id });
      const res = await api.convHistory(dm.id, dir < 0 ? { before: cur, limit: 100 } : { after: cur, limit: 100 });
      const gone = useStore.getState().conv.gone;
      const list = res.messages.filter((m): m is ConvMessage => !('gone' in m) && !gone[m.id]);
      return { messages: list, more: dir < 0 ? res.hasMoreBefore : res.hasMoreAfter };
    }
    const cursor = dir < 0 ? olderCursor([edge]) : null;
    if (!cursor) return { messages: [], more: false };
    const page = await api.listDmMessages(dm.id, cursor);
    return { messages: page, more: hasMoreOlder(page) };
  };

  return (
    <MessagePane
      nameOf={nameOf}
      quoteNames
      // Файл до 512 МБ кусками (`bigfile1`) — только путём бесед (`api.convUpload`); старый путь ЛС — прежние 25 МБ.
      // Предел считает сама лента (`attachRules.dmAttachMaxBytes`): харнесс шапки грузит этот файл с перечнем импортов.
      bigFiles={convActive}
      onRedial={callsOn && !callsDenied && !inCall ? () => void useCall.getState().start(dm.id) : undefined}
      newSince={newSince}
      scrollKey={visitKey}
      feedId={dm.id}
      loadMediaPage={loadMediaPage}
      title={
        /* Шапка беседы (раунд 11, HANDOFF §5): аватар с точкой «в сети», имя и строка состояния — «в сети» или пусто (без
           связи с сервером — «Подключение…» / «Ожидание сети», 05.10);
           «печатает» ложится в ту же клетку поверх, ширина подписи не меняется. ПК — одной строкой, подпись как тема
           канала (`.topbar-topic`); телефон — имя над подписью, без подписи (`.solo`) имя по центру. На телефоне аватар
           крупнее: шапка там 56 px с кнопками 48, и маленький терялся между ними (#212). */
        <div
          className="topbar-title dm-open-profile"
          role="button"
          tabIndex={0}
          aria-label={group ? `Информация о группе: ${group.title}` : saved ? SAVED_NAME : `Профиль: ${peerName}`}
          onClick={(e) => (group ? (former ? undefined : openGroupInfo(dm.id)) : saved ? undefined : showProfile(e.currentTarget.querySelector('.dm-ava')))}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            if (group) {
              if (!former) openGroupInfo(dm.id);
            } else if (!saved) showProfile(e.currentTarget.querySelector('.dm-ava'));
          }}
        >
          <span className="dm-ava">
            {saved ? <SavedAvatar size={phone ? 36 : 28} /> : <Avatar url={dm.otherUser.avatarUrl} name={peerName} size={phone ? 36 : 28} />}
            {peerOnline && (
              <span className="mp-dot-wrap">
                <StatusDot status="online" size={phone ? 12 : 10} ringColor="var(--bg)" />
              </span>
            )}
          </span>
          <span className={`dm-who${peerTyping ? ' typing' : ''}${saved || (!group && !peerOnline && !peerTyping && !conn && !seenText) ? ' solo' : ''}`}>
            <strong>{peerName}</strong>
            <span className="topbar-topic dm-who-sub">
              {/* Скрытая из двух подписей прозрачна, но в дереве — скринридеру её не читать. */}
              <span className="dm-who-status" aria-hidden={peerTyping || undefined}>
                {conn ??
                  (saved
                    ? ''
                    : former
                    ? former.removed
                      ? 'вас удалили из группы'
                      : 'вы покинули группу'
                    : group
                      ? groupMembersLabel(group.members.length)
                      : online
                        ? 'в сети'
                        : seenText)}
              </span>
              <span className="dm-who-typing" aria-hidden={!peerTyping || undefined}>
                <span className="typing-dots">
                  <span />
                  <span />
                  <span />
                </span>
                {typingLabel}
              </span>
            </span>
          </span>
        </div>
      }
      headerActions={
        <>
          {prefsOn && !former && !phone && (
            <button
              type="button"
              className={`topbar-btn ${pinned ? 'active' : ''}`}
              title={pinned ? 'Открепить беседу' : 'Закрепить беседу в списке'}
              aria-pressed={pinned}
              onClick={() => toggleDmPinned(dm.id, !pinned)}
            >
              <Icon name={pinned ? 'pin-off' : 'pin'} size={18} />
            </button>
          )}
          {searchOn && !phone && (
            <button type="button" className="topbar-btn" title="Поиск · Ctrl+F" aria-label="Поиск" onClick={() => setSearchOpen(true)}>
              <Icon name="search" size={18} />
            </button>
          )}
          {callsOn && (
            <button
              type="button"
              className="topbar-btn"
              title="Позвонить"
              aria-label="Позвонить"
              disabled={inCall}
              onClick={() => (callsDenied ? explainCallPrivacy(peerName) : void useCall.getState().start(dm.id))}
            >
              <Icon name="phone" size={18} />
            </button>
          )}
          <button
            ref={moreBtnRef}
            type="button"
            className={`topbar-btn ${moreAt ? 'active' : ''}`}
            title="Меню беседы"
            aria-haspopup="menu"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMoreAt({ x: r.right, y: r.bottom + 4 });
            }}
          >
            <Icon name="more" size={18} />
          </button>
          {moreAt && (
            <ContextMenu pos={{ x: Math.max(0, moreAt.x - 264), y: moreAt.y }} width={264} fit onClose={() => setMoreAt(null)}>
              {/* Телефон (решение 49, 08.10), как Telegram Android: в шапке только звонок и ⋮, «Поиск» — первым пунктом меню. */}
              {phone && searchOn && (
                <MenuItem
                  icon="search"
                  label="Поиск"
                  onClick={() => {
                    setMoreAt(null);
                    setSearchOpen(true);
                  }}
                />
              )}
              {group && !former && (
                <MenuItem
                  icon="users"
                  label="Информация о группе"
                  onClick={() => {
                    setMoreAt(null);
                    openGroupInfo(dm.id);
                  }}
                />
              )}
              {/* Группа (`groups2`): тот же «Выключить уведомления ▸», цель заглушки — `group:<id>` (= `otherUser.id`). */}
              {!saved && !former && alwaysAct && (
                <MenuItem
                  icon={alwaysAct === 'enable' ? 'bell' : 'bell-off'}
                  label={alwaysAct === 'enable' ? 'Включить уведомления' : 'Выключить уведомления'}
                  onClick={() => {
                    setMoreAt(null);
                    useStore.getState().setPushAlways(dm.otherUser.id, alwaysAct === 'enable').catch(toastError);
                  }}
                />
              )}
              {!saved && !former && !alwaysAct && <MenuItem
                icon={pushMuted ? 'bell' : 'bell-off'}
                label={pushMuted ? 'Включить уведомления' : prefsOn ? 'Выключить уведомления…' : 'Отключить уведомления'}
                // Заглушена на время — остаток срока серым справа (решение 41, 08.10: в этом меню его не было вовсе).
                shortcut={(pushMuted && prefsOn && muteLeftLabel(mute, muteNow)) || undefined}
                note
                onClick={() => {
                  setMoreAt(null);
                  // Сервер умеет срок (conv11) и сейчас звук есть — выбор срока; иначе — прежний переключатель.
                  if (prefsOn && !pushMuted) setBellAt(new DOMRect(moreAt.x - 1, moreAt.y - 4, 1, 1));
                  else setPushMuted('dm_user', dm.otherUser.id, !pushMuted).catch(toastError);
                }}
              />}
              {archiveOn && !former && (
                <MenuItem
                  icon={dm.archived ? 'unarchive' : 'archive'}
                  label={archiveMenuLabel(dm.archived === true)}
                  onClick={() => {
                    setMoreAt(null);
                    archiveDms([dm.id], dm.archived !== true);
                  }}
                />
              )}
              {/* Телефон: закрепление беседы переехало из шапки в меню (тот же экшен, что у кнопки-пина на ПК). */}
              {phone && prefsOn && !former && (
                <MenuItem
                  icon={pinned ? 'pin-off' : 'pin'}
                  label={pinned ? 'Открепить' : 'Закрепить'}
                  onClick={() => {
                    setMoreAt(null);
                    toggleDmPinned(dm.id, !pinned);
                  }}
                />
              )}
              {!group && !saved && <MenuItem
                icon="user"
                label="Показать профиль"
                onClick={() => {
                  setMoreAt(null);
                  openUserCardAt({ x: moreAt.x - 320, y: moreAt.y }, peerTarget, 'profile');
                }}
              />}
              {searchOn && !phone && (
                <MenuItem
                  icon="search"
                  label="Поиск"
                  onClick={() => {
                    setMoreAt(null);
                    setSearchOpen(true);
                  }}
                />
              )}
              {/* Контакты (`contacts1`), как меню профиля Telegram: «Добавить в контакты» или «Изменить контакт» / «Удалить контакт». */}
              {contactsOn && !former && !peerContact && (
                <MenuItem
                  icon="user-plus"
                  label="Добавить в контакты"
                  onClick={() => {
                    setMoreAt(null);
                    useContacts.getState().openEdit(peerPerson, 'add');
                  }}
                />
              )}
              {contactsOn && !former && peerContact && (
                <MenuItem
                  icon="edit"
                  label="Изменить контакт"
                  onClick={() => {
                    setMoreAt(null);
                    useContacts.getState().openEdit(peerPerson, 'edit');
                  }}
                />
              )}
              {contactsOn && !former && peerContact && (
                <MenuItem
                  icon="trash"
                  label="Удалить контакт"
                  onClick={() => {
                    setMoreAt(null);
                    void removeContactAsk(peerPerson, contactLabel(peerContact));
                  }}
                />
              )}
              {/* С «Добавить в контакты» на плашке телефона «Пожаловаться» живёт здесь (как «Report» в меню Telegram Android). */}
              {strangerBar && contactsOn && (
                <MenuItem
                  icon="flag"
                  label="Пожаловаться"
                  onClick={() => {
                    setMoreAt(null);
                    setReportOpen(true);
                  }}
                />
              )}
              {!saved && !former && <MenuDivider />}
              {saved || former ? null : group ? (
                <MenuItem
                  icon="logout"
                  label="Покинуть группу"
                  danger
                  onClick={() => {
                    setMoreAt(null);
                    void leaveGroup(dm.id, group.title);
                  }}
                />
              ) : (
                <MenuItem
                  icon="ban"
                  label={blocked ? 'Разблокировать' : 'Заблокировать'}
                  danger={!blocked}
                  onClick={() => {
                    setMoreAt(null);
                    void switchBlock();
                  }}
                />
              )}
              {/* Как у Telegram (03·2.3.1 / 2.3.2): «Очистить историю» и «Удалить чат» — в конце меню; окна те же, что у меню строки. */}
              {/* Бывшая группа (Telegram Android `ChatActivity`: при `isNotInChat` нет «Покинуть», остаётся удалить): одно «Удалить группу». */}
              {former && (
                <MenuItem
                  icon="trash"
                  label="Удалить группу"
                  danger
                  onClick={() => {
                    setMoreAt(null);
                    void deleteFormerGroup(dm);
                  }}
                />
              )}
              {clearOn && !former && (
                <>
                  <MenuDivider />
                  <MenuItem
                    icon="close"
                    label="Очистить историю"
                    onClick={() => {
                      setMoreAt(null);
                      void clearHistory(dm, nameOf);
                    }}
                  />
                  <MenuItem
                    icon="trash"
                    label="Удалить чат"
                    danger
                    onClick={() => {
                      setMoreAt(null);
                      void deleteChat(dm, nameOf);
                    }}
                  />
                </>
              )}
            </ContextMenu>
          )}
          {bellAt && (
            <ContextMenu anchor={bellAt} align="end" onClose={() => setBellAt(null)} width={phone ? 288 : 256} fit>
              <DmMuteMenuItems peerId={dm.otherUser.id} mute={mute} now={muteNow} onDone={() => setBellAt(null)} />
            </ContextMenu>
          )}
          {userCard}
        </>
      }
      topBar={
        strangerBar ? (
          <>
            <StrangerBar
              peerName={peerName}
              onAdd={contactsOn ? () => useContacts.getState().openEdit(peerPerson, 'add') : undefined}
              onBlock={() => void switchBlock()}
              onReport={() => setReportOpen(true)}
              onHide={() => void useStore.getState().hideStrangerBar(dm.id).catch(toastError)}
            />
            {reportOpen && (
              <StrangerReportModal
                convId={dm.id}
                peer={{ id: peer.id, displayName: peer.displayName }}
                blocked={blocked}
                onBlock={blockQuiet}
                onClose={() => setReportOpen(false)}
              />
            )}
          </>
        ) : undefined
      }
      composerReplacement={
        former ? (
          <div className="composer-blocked">
            <span className="muted">{former.removed ? 'Вас удалили из группы.' : 'Вы покинули группу.'}</span>
            <button type="button" className="link" onClick={() => void deleteFormerGroup(dm)}>
              Удалить группу
            </button>
          </div>
        ) : blocked ? (
          <div className="composer-blocked">
            <span className="muted">Вы заблокировали {peerName}.</span>
            <button type="button" className="link" onClick={() => void switchBlock()}>
              Разблокировать
            </button>
          </div>
        ) : undefined
      }
      /* Как у Telegram Android: просто «Сообщение» (решение владельца 09.10), без имени собеседника. */
      placeholder="Сообщение"
      groupChat={!!group}
      // «@» в группе (`groups2`, tdesktop `field_autocomplete.cpp`): подсказка — участники, кроме себя; без @everyone.
      autocomplete={groupMentions}
      messages={messages}
      loading={messagesRaw === undefined && !failed}
      emptyState={failed ? <FeedLoadError onRetry={() => void refreshDmHistory(dm.id)} /> : saved ? <SavedEmpty /> : undefined}
      // История глубже одной порции (#212): сервер отдавал её с первого дня, лента не просила.
      onLoadOlder={() => loadOlderDmMessages(dm.id)}
      feedWindow={feedWindow}
      chatSearch={chatSearch}
      cornerThings={
        reactFlag
          ? {
              reactions: unreadReactions,
              mentions: unreadMentions,
              // К самому старому непрочитанному (tdesktop `CornerButtons::reactionsClick`): сервер отдаёт их по возрастанию ключа.
              onReactionsJump: async () => (await api.convUnreadReactions(dm.id)).messages[0]?.id ?? null,
              // «@» группы (`groups2`): к самому старому непрочитанному упоминанию (tdesktop `CornerButtons::mentionsClick`).
              ...(group ? { onMentionsJump: async () => (await api.convUnreadMentions(dm.id)).messages[0]?.id ?? null } : {}),
              onReactionsRead: (ids) => void useStore.getState().readConvReactions(dm.id, ids).catch((e) => toastError(e, 'Не удалось отметить реакции')),
            }
          : undefined
      }
      // «Прочитано» по видимому (G09): лента сообщает увиденное — с начала визита и только в режиме бесед.
      onSeen={convActive && started && (!feedWin || feedWindow) ? (key) => useStore.getState().convSeen(dm.id, key) : undefined}
      bubbles={bubbles}
      peerReadKey={peerReadKey}
      readAtConvId={bubbles && convActive && lastSeenOn && !saved ? dm.id : null}
      onTyping={saved ? undefined : (action) => sendTyping({ dmId: dm.id, recipientId: dm.otherUser.id }, action)}
      meId={user?.id}
      draft={initialDraft}
      draftRemote={draftRemote}
      onDraftChange={convActive ? (text, replyToId) => useStore.getState().setDraft(dm.id, text, replyToId) : undefined}
      sendFlags={sendFlagsOn}
      mediaFlags={mediaFlagsOn}
      quoteOn={quoteOn}
      outbox={
        convActive
          ? {
              items: outboxItems,
              enqueue: (item) => useStore.getState().outboxEnqueue(dm.id, item),
              retry: (key) => useStore.getState().outboxRetry(dm.id, key),
              discard: (key) => useStore.getState().outboxDiscard(dm.id, key),
            }
          : undefined
      }
      onSend={async (content, files, replyToId, sendKey) => {
        const signal = uploadSignal(sendKey);
        // Старый путь ЛС (без бесед): прогресс и отмена — как у каналов (07.10).
        const attachments = await Promise.all(
          files.map((f, i) =>
            api
              .uploadDmAttachment(dm.id, f, {
                signal,
                onProgress: (loaded, total) => setUploadProgress(sendKey, i, loaded, total),
              })
              .then((a) => {
                setUploadDone(sendKey, i);
                return a;
              }),
          ),
        );
        if (signal?.aborted) throw uploadAborted();
        const msg = await api.sendDmMessage(dm.id, content, attachments, replyToId);
        if (signal?.aborted) {
          await api.deleteDmMessage(dm.id, msg.id, 'both').catch(() => appendDmMessage(dm.id, msg));
          throw uploadAborted();
        }
        appendDmMessage(dm.id, msg);
      }}
      stickerPacks={stickersOn ? (myStickers ?? []) : undefined}
      onSendSticker={stickersOn ? (stickerId) => sendStickerRef.current(stickerId) : undefined}
      onSendGif={gifsOn ? sendGif : undefined}
      // Бывшая группа (`groups3`): сервер вышедшему сохранить не даст (404, нет участия) — пункта в меню нет (ревью 08.10).
      onSaveGif={gifsOn && !former ? saveGif : undefined}
      stickerRecent={stickersOn ? recentStickers : undefined}
      stickerCatalog={stickersOn ? <StickerCatalogPanel /> : undefined}
      onStickerUsed={stickersOn ? (st) => useDmStickers.getState().used(st) : undefined}
      onEscapeClose={() => {
        /* Последний Esc — закрыть беседу (07.10, G15; Telegram Desktop `HistoryWidget::escape` → `_cancelRequests` →
           `showBackFromStack`): на ПК справа «Выбери диалог», в одну колонку (узкое окно) — назад к списку. Фокус — в поиск
           бесед: у Telegram после закрытия набор уходит в поиск, а ↓ из поиска ведёт к строкам (G14). */
        const s = useStore.getState();
        if (phone) return s.setMobilePane('list');
        useStore.setState({ currentDmId: null });
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.dm-find input')?.focus());
      }}
      voiceOnce={voiceOnceOn}
      roundOk={roundOn}
      onSendVoice={async (take, opts) => {
        // ЛС голосовые умеют: это не серверная настройка, в отличие от стикеров и ников (#20).
        if (convActive) {
          const att = await api.convUpload(dm.id, take.file);
          // Кружок (`circles1`, G68): квадратное видео с пометкой `round`; огибающей у него нет.
          const ref = take.round
            ? {
                ...toOutboxRef({ ...att, width: take.round.side, height: take.round.side, durationMs: take.durationMs }),
                waveform: null,
                round: true as const,
              }
            : toOutboxRef({ ...att, waveform: take.waveform, durationMs: take.durationMs });
          const msg = await api.convSend(dm.id, {
            clientId: newClientId(),
            content: '',
            // «Один раз» (`voice3`) — пометка у ссылки на вложение; сервер оставит её только в личке 1:1.
            attachments: [voiceOnceOn && opts?.once ? { ...ref, once: true } : ref],
          });
          useStore.getState().convAfterSend(dm.id, msg);
          return;
        }
        const att = await api.uploadDmAttachment(dm.id, take.file);
        const msg = await api.sendDmMessage(dm.id, '', [
          { ...att, waveform: take.waveform, durationMs: take.durationMs },
        ]);
        appendDmMessage(dm.id, msg);
      }}
      onEdit={async (m, content) => {
        if (convActive) {
          useStore.getState().convAfterEdit(dm.id, await api.convEdit(dm.id, m.id, content));
          return;
        }
        const updated = await api.editDmMessage(dm.id, m.id, content);
        updateDmMessage(dm.id, updated);
      }}
      deletePeerName={peerName}
      batch={batch}
      deleteOthersForBoth={othersForBoth}
      pins={pins}
      readOnly={!!former}
      sendMenu={sendMenu}
      onDelete={async (m, scope) => {
        if (convActive) {
          await api.convDelete(dm.id, m.id, scope ?? 'me');
          useStore.getState().convAfterDelete(dm.id, m.id);
          return;
        }
        await api.deleteDmMessage(dm.id, m.id, scope);
        // Строку ленты убираем сразу; время беседы и число поправит событие `dm.delete` следом.
        removeDmMessage(dm.id, m.id);
      }}
      reactorOf={reactorOf}
      onReact={former ? undefined : (messageId, emoji, op) => {
        // Persist; the gateway echoes the change back to both participants → store update.
        (convActive ? api.convReact(dm.id, messageId, emoji, op) : api.reactDm(dm.id, messageId, emoji, op)).catch(toastError);
      }}
      onReactBig={
        former || !bigFlag
          ? undefined
          : (messageId, emoji) => {
              // Как Telegram: у отправителя анимация сразу, реакция ставится (повтор своей — снова «большая»), собеседнику — `reaction.big`.
              fireEffect({ kind: 'bigReaction', conversationId: dm.id, messageId, emoji });
              api.convReact(dm.id, messageId, emoji, 'add', true).catch(toastError);
            }
      }
    />
  );
}
