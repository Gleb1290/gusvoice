import { useEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, ConvMediaInput, ConvMessage, ConvMute, ConvPin, ConvScheduled, DmChannel, Message, Sticker } from '@gusvoice/shared';
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
import { FED_NO_CALLS_TEXT, fedCallsLocked, serverCalls } from '../callView';
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
import { serverLastSeen } from '../lastSeenText';
import { lastSeenForms, useStatusFit } from '../statusFit';
import { SavedAvatar, SavedEmpty } from './SavedAvatar';
import { chatReadKeyOf, fedGroupDownText, groupHomeLabel, groupHostHome, groupMembersLabel, groupTypingLabel, typingNames } from '../groupChatRules';
import { leaveGroup, openGroupInfo } from './GroupDialogs';
import { newClientId } from '../clientId';
import { toOutboxRef } from '../convStore';
import {
  FED_VIA_TEXT_ONLY,
  fedViaBarText,
  fedFilesHint,
  serverFedFiles,
  convCursor,
  fedLinkBroken,
  fedLinkBrokenText,
  messagePrivacyPlateText,
  botUnavailablePlateText,
  fedLinkStale,
  fedLinkStaleText,
  fedPeerDown,
  fedPeerDownText,
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
  serverAlbumItemsOn,
  serverVoiceOnce,
  serverOnceMedia,
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
  serverGeoContact,
  serverConvPoll,
  serverGeoLive,
  serverPush4,
  peerPresenceShown,
  serverFedPresence,
  serverReaders,
} from '../convSyncRules';
import { notifyAlwaysAction } from '../notifyExceptionsRules';
import { DM_MUTE_PRESETS, MUTE_CUSTOM_EVENT, dmMuteOf, dmPinLimitText, muteActive, mutePeriodLabel, muteLeftLabel, muteSoundOff } from '../dmListRules';
import { loadMuteRecent, saveMuteRecent } from '../muteRecent';
import { usePhoneLayout } from '../phoneLayout';

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
 * `onBack` (телефон, #218) — подменю «Уведомления» внутри «⋮» беседы, как Telegram Android `ChatNotificationsPopupWrapper`
 * (`TA/ui/Components/ChatNotificationsPopupWrapper.java:76-135`): первым «Назад», дальше тот же состав без тонкой черты перед
 * «Выключить уведомления» (у Telegram пункты подменю идут подряд).
 */
export function DmMuteMenuItems({
  peerId,
  mute,
  now,
  onDone,
  onBack,
}: {
  peerId: string;
  mute: ConvMute | null;
  now: number;
  onDone: () => void;
  onBack?: () => void;
}) {
  const soundMenu = useStore((s) => serverUnreadMark(s.serverFeatures));
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
        <MenuItem icon="chevron-left" label="Выключить на время" back onClick={() => setView('main')} />
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
      {onBack && <MenuItem icon="chevron-left" label="Назад" back onClick={onBack} />}
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
      {!onBack && <MenuDivider />}
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

/**
 * Пустая беседа с ботом (#229) — как новый чат с ботом у Telegram: по центру ленты аватар, имя со значком «БОТ», понятная
 * подпись и кнопка «Старт» (шлёт `/start` обычным сообщением). Поля ввода в это время НЕТ (решение владельца 26.10; у
 * telegram-tt `MiddleColumn.tsx` `canPostFooter` = `!isBotNotStarted`), его прячет `botGate` в `DmChatView`.
 * `description` — «что умеет бот» (telegram-tt `MessageListAccountInfo.tsx`): `otherUser.botDescription` сводки беседы
 * (26.10; старый сервер поля не шлёт — блока нет). Свой вид не выдумываем — классы `.empty-goose`, что у пустой ленты, и `.bot-tag` шапки.
 * Здесь, а не модулем: харнессы шапки держат закрытый перечень импортов этого файла (текст команды — `botRules.BOT_START_COMMAND`).
 */
function BotStartEmpty({ name, avatarUrl, description, onStart }: { name: string; avatarUrl?: string | null; description?: string; onStart?: () => void }) {
  return (
    <div className="empty-goose bot-start-empty">
      <Avatar url={avatarUrl} name={name} size={72} />
      <div className="eg-title">
        {name}
        <span className="bot-tag">БОТ</span>
      </div>
      {/* «Что умеет этот бот?» (Telegram `MessageListAccountInfo`): описание бота из сводки беседы (`otherUser.botDescription`), многострочное. */}
      {description && (
        <div className="eg-sub bot-start-desc">
          <div className="bot-start-what">Что умеет этот бот?</div>
          {description}
        </div>
      )}
      {/* Писать боту нельзя (`botUnavailable`, 26.10) — «Старт» не рисуем: причина — на плашке вместо поля ввода. */}
      {onStart && (
        <>
          <div className="eg-sub">Это бот — им управляет программа. Нажмите «Старт», чтобы начать с ним разговор.</div>
          <button type="button" className="dm-start bot-start" onClick={onStart}>
            Старт
          </button>
        </>
      )}
    </div>
  );
}

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
  // Заглушка (07.10, G03): из сводки (`conv11`) или из списка заглушек; срок вышел — часы перерисуют шапку сами.
  const mutedUsers = useStore((s) => s.pushMutedDmUsers);
  const muteUntil = useStore((s) => s.pushMuteUntil);
  const mute = dmMuteOf(dm, mutedUsers, muteUntil);
  const muteNow = useMuteClock([mute]);
  const pushMuted = muteActive(mute, muteNow);
  const setPushMuted = useStore((s) => s.setPushMuted);
  // Закреп беседы и сроки заглушки — только у сервера с `conv11` и в режиме бесед; иначе колокольчик — прежний тумблер.
  const prefsOn = useStore((s) => serverChatPrefs(s.serverFeatures));
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
  const archiveOn = useStore((s) => serverArchive(s.serverFeatures));
  // «Прослушать один раз» (`voice3`, G54) — только личка 1:1 с человеком: не группа и не «Избранное» (tdesktop `TTLButton`).
  const voiceOnceOn = useStore((s) => serverVoiceOnce(s.serverFeatures)) && !dm.group && !dm.saved;
  // Одноразовые фото/видео (`ttlmedia1`, #226) — как «один раз» у голосового: только личка 1:1 с человеком.
  const mediaOnceOn = useStore((s) => serverOnceMedia(s.serverFeatures)) && !dm.group && !dm.saved;
  /** Кружки (`circles1`, G68) — только режим бесед и сервер с признаком; без него у кнопки записи нет режима камеры. */
  const roundOn = useStore((s) => serverRounds(s.serverFeatures));
  const clearOn = useStore((s) => serverChatClear(s.serverFeatures));
  // Поиск в беседе и «Перейти к дате» (G05, G25): сервер с `search1` и окно ленты (переход «вокруг» найденного).
  const searchFlag = useStore((s) => serverChatSearch(s.serverFeatures));
  // Кнопки «@» / «♥» над «вниз» (G24, `reactunread1`): числа — из сводки беседы, действия — из стора и `api`.
  const reactFlag = useStore((s) => serverReactionsUnread(s.serverFeatures));
  // «Большая» реакция удержанием (G43, `bigreact1`): только беседам нового сервера.
  const bigFlag = useStore((s) => serverBigReactions(s.serverFeatures));
  const unreadReactions = useStore((s) => s.conv.summaries[dm.id]?.unreadReactions ?? 0);
  const unreadMentions = useStore((s) => s.conv.summaries[dm.id]?.unreadMentions ?? 0);
  // Опрос в 1:1 с человеком соседа (`dmpoll1`): сервер разрешает, когда все дома беседы объявили признак, и отдаёт `fedPoll` в сводке.
  const fedPollOk = useStore((s) => s.conv.summaries[dm.id]?.fedPoll === true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [bellAt, setBellAt] = useState<DOMRect | null>(null);
  const pinned = !!dm.pinnedAt;
  const loadOlderDmMessages = useStore((s) => s.loadOlderDmMessages);
  const refreshDmHistory = useStore((s) => s.refreshDmHistory);
  const failed = useStore((s) => s.historyFailed.includes(dm.id));
  const blocked = useStore((s) => s.blockedUsers.some((u) => u.id === dm.otherUser.id));
  /* Беседа есть только в режиме бесед (ЛС этап 2; старого пути `/api/dm*` у клиента нет с 09.10): действия — через
     `/api/conv/*` с id отправки, события — `conv.change`, лента — пузыри (Р13) с окном (шаг 2г). */
  // Исходящие беседы (шаг 2в): в сторе по беседе — переживают смену беседы, голос и перезапуск, повторяются сами.
  const outboxItems = useStore((s) => s.outbox[dm.id] ?? NO_OUTBOX);
  // Черновик (шаг 2д): читается ОДИН раз при создании ленты — подписка на него перерисовывала бы беседу на каждую букву.
  const [initialDraft] = useState(() => useStore.getState().drafts[dm.id]);
  /* Черновик с другого моего устройства (Р7): подписка на СЧЁТЧИК пришедших, не на сам черновик — он меняется только
     пришедшим, а не каждой буквой здесь. */
  const draftRev = useStore((s) => s.draftRev[dm.id] ?? 0);
  const draftRemote = useMemo(() => {
    if (!draftRev) return undefined;
    const d = useStore.getState().drafts[dm.id];
    return { text: d?.text ?? '', replyToId: d?.replyToId ?? null, rev: draftRev };
  }, [draftRev, dm.id]);
  /* ✓✓ «прочитано собеседником» (Р6): ключ из сводки беседы. Подписка на ЧИСЛО: перерисовка — только когда собеседник
     прочитал дальше, а не на каждую сводку. */
  // «Избранное» (`saved1`): сообщения сразу «прочитаны» (✓✓, как у Telegram, где читать их некому, кроме меня).
  const saved = !!dm.saved;
  // Собеседник — бот (#229). В типе `otherUser` поля пока нет — читаем добавленное сервером (`botRules.isBotUser`).
  const peerBot = !saved && !dm.group && (dm.otherUser as { bot?: unknown }).bot === true;
  /* Бот ещё не начат (решение владельца 26.10, как у Telegram): пустая беседа с ботом — поля ввода нет, пока не нажата
     «Старт». Нажали — поле сразу, не дожидаясь ответа бота (`botStartedIn`; в очереди уже лежит `/start`). Пока лента
     грузится, поле тоже скрыто: иначе у пустой беседы оно мелькнуло бы и пропало. Не загрузилась — поле как обычно. */
  const [botStartedIn, setBotStartedIn] = useState<string | null>(null);
  // Писать боту нельзя (решение A, 26.10): выключен / приватный, а я не владелец — плашка вместо поля и без «Старт».
  const botUnavailable = peerBot ? (dm.otherUser as { botUnavailable?: string }).botUnavailable : undefined;
  const botGate =
    peerBot && !failed && messages.length === 0 && outboxItems.length === 0 && botStartedIn !== dm.id && !initialDraft?.text && !botUnavailable;
  const peerReadKey = useStore((s) =>
    saved
      ? Number.MAX_SAFE_INTEGER
      : s.conv.summaries[dm.id]?.group
        ? chatReadKeyOf(s.conv.summaries[dm.id])
        : peerReadKeyOf(s.conv.summaries[dm.id]),
  );
  const win = useStore((s) => s.conv.windows[dm.id]);
  const unreadBelow = useStore((s) => s.conv.summaries[dm.id]?.unread ?? 0);
  /* Раунд 12, порция 5: пересылка, выделение и удаление пачкой — только в режиме бесед и у сервера с `conv5` (ручки —
     `/api/conv/*`); чужое «у обоих» — с `conv6` (С1). Старый сервер — ни пунктов, ни выделения, ни галочки у чужого. */
  const batchOn = useStore((s) => serverBatchActions(s.serverFeatures));
  // «Без звука» (С3, `conv8`): и у меню «Отправить», и у «Переслать в…» (галочка в окне).
  const silentOn = useStore((s) => serverSilentSend(s.serverFeatures));
  /** «Скрыть имя отправителя / подписи» у пересылки (G71, `fwd2`). */
  const forwardOptsOn = useStore((s) => serverForwardOptions(s.serverFeatures));
  /** «Отправить позже» в окне «Переслать в…» (G71): тот же признак, что у отложенных (`schedOn` ниже). */
  const schedForward = useStore((s) => serverScheduled(s.serverFeatures));
  /** Флаги отправки (G19 + G48, `linkprev1`): «без превью» и «как файл». */
  const sendFlagsOn = useStore((s) => serverSendFlags(s.serverFeatures));
  /** «Высокое качество», спойлер и подпись над медиа в окне отправки файлов (G48, `media2`). */
  const mediaFlagsOn = useStore((s) => serverMediaFlags(s.serverFeatures));
  /** Цитата фрагмента и «Ответить в другом чате» (G55, `quote1`). */
  const quoteOn = useStore((s) => serverQuote(s.serverFeatures));
  // Стикеры в ЛС (С2, `stickers2`): мои наборы, недавние, каталог инстанса во вкладке панели; окно набора из ленты шлёт сюда.
  const stickersOn = useStore((s) => serverDmStickers(s.serverFeatures));
  const myStickers = useDmStickers((s) => s.mine);
  const recentStickers = useDmStickers((s) => s.recent);
  // GIF (`gifs1`, Р-7): «Мой GIF» или найденный — сервер копирует файл вложением этой беседы, дальше обычная отправка
  // с подсказкой `gif: true` (видео без звука по кругу). «Сохранить GIF» — из меню сообщения.
  const gifsOn = useStore((s) => serverGifs(s.serverFeatures));
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
  // Геопозиция и контакт (14.10, G69, `geocontact1`): отдельное сообщение без текста; запасной текст собирает сервер.
  const geoContactOn = useStore((s) => serverGeoContact(s.serverFeatures));
  // Опрос (14.10, `convpoll1`): провода опроса соседям нет — в 1:1 с человеком другого инстанса и в группе чужого хоста пункта
  // нет (группа своего хоста с людьми соседа — сервер ответит 403 `conv_poll_federated` с понятной фразой).
  const convPollFeature = useStore((s) => serverConvPoll(s.serverFeatures));
  // Трансляция геопозиции (14.10, `geolive1`): как опрос — провода соседям нет, в беседе с людьми других инстансов пункта нет.
  const geoLiveFeature = useStore((s) => serverGeoLive(s.serverFeatures));
  const sendMedia = async (media: ConvMediaInput) => {
    const msg = await api.convSend(dm.id, { clientId: newClientId(), content: '', attachments: [], media });
    useStore.getState().convAfterSend(dm.id, msg);
    // Трансляция пошла: точки обновляет менеджер (служба Android или страница), пока не выйдет срок или не нажмут «Остановить».
    if (media.kind === 'geolive' && msg.media && (msg.media as { kind?: string }).kind === 'geolive') {
      const live = msg.media as import('@gusvoice/shared').ConvGeoLiveMedia;
      // Закрытые перечни импортов в тестах: менеджер подгружается на месте (`import()`), как `pollActions` на сервере.
      void import('../geoLiveSharing').then((m) => m.beginGeoLive(dm.id, msg.id, live), toastError);
    }
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
  const othersForBoth = useStore((s) => serverDeletesOthersForBoth(s.serverFeatures));
  /* Бывшая группа (`groups3`): пересылка ИЗ неё и удаление пачкой — «нет такой» у сервера (`loadAccess` исходной беседы), потому пачки нет. */
  const former = useStore((s) => s.conv.summaries[dm.id]?.former ?? null);
  const peerHome = dm.group || dm.saved ? null : (dm.otherUser.homeInstance ?? null);
  const peerHomeLabel = peerHome ? peerHome.name?.trim() || peerHome.domain || 'другой инстанс' : null;
  /* Э2 часть Б (#141, Ф7): связка с инстансом собеседника разорвана или приостановлена — беседа архив ТОЛЬКО ДЛЯ ЧТЕНИЯ (`fedLink: 'broken'`
     в сводке): вместо поля ввода плашка, ни ответа, ни правки, ни реакций, ни звонка; сервер на запись отвечает 403 `federation.dm_link_broken`. */
  const linkBroken = useStore((s) => !!peerHome && fedLinkBroken(s.conv.summaries[dm.id]));
  /* Исправления ревью 12.10, п. 7 (`fedStale` в сводке): инстанс собеседника не забирает наши сообщения дольше 10 минут — плашка над
     полем «Сообщения ждут, пока «X» их заберёт»; писать можно. */
  const linkStale = useStore((s) => !!peerHome && fedLinkStale(s.conv.summaries[dm.id]));
  /* Хвост Э7 (14.10, `fedPeerDown` в сводке): дом собеседника не отвечает дольше 10 минут — плашка «Инстанс «X» недоступен — сообщения
     доедут, когда он вернётся» (как у группы, `fed-group-down`); писать можно. Одна плашка: она важнее «ждут, пока заберёт». */
  const peerDown = useStore((s) => !!peerHome && fedPeerDown(s.conv.summaries[dm.id]));
  /* Э7 (#141, `fedm6`): дом группы чужого инстанса недоступен (`fedGroupHost.down`) — плашка над полем в стиле `fed-stale`; писать можно,
     доставка остальным — когда он вернётся; состав и название не меняются (кнопки окна группы неактивны). */
  const groupDownText = useStore((s) => {
    const host = dm.group ? s.conv.summaries[dm.id]?.fedGroupHost : undefined;
    return host?.down ? fedGroupDownText(groupHomeLabel(groupHostHome(host.instanceId, dm.group?.members ?? [], s.dms))) : null;
  });
  /* Э3 (#141, `fedm3`): вложения с человеком соседа закрыты, только если сервер не объявил `fedm3` ИЛИ его инстанс вложений не принимает
     (`fedNoFiles` в сводке); иначе беседа как обычная ЛС. `null` — открыты. */
  const fedFiles = useStore((s) => serverFedFiles(s.serverFeatures));
  const fedNoFiles = useStore((s) => !!s.conv.summaries[dm.id]?.fedNoFiles);
  /* Э5 (#141, `fedm5`): дом недоступен, текст уходит через инстанс собеседника по долгой сессии (`fedVia.ts` ведёт `fedVia` в сторе):
     плашка над полем, вложения/голос/GIF/стикеры/правка/удаление/реакции закрыты с подсказкой «Дом недоступен — пока только текст». */
  /* Э7 часть 3 (#141): в группе чужого дома «через» идёт к её хосту (`fedGroupHost`) — тот же режим, плашка называет хост. */
  const groupHostId = useStore((s) => (dm.group ? (s.conv.summaries[dm.id]?.fedGroupHost?.instanceId ?? null) : null));
  const groupHostName = useStore((s) => (groupHostId ? groupHomeLabel(groupHostHome(groupHostId, dm.group?.members ?? [], s.dms)) : null));
  const viaPeerLabel = peerHomeLabel ?? (groupHostId ? (groupHostName ?? 'другой инстанс') : null);
  const viaOn = useStore((s) => (!!peerHome || !!groupHostId) && s.fedVia?.down === true && !!s.fedVia.ready?.includes(dm.id));
  /* Э7 ч.3 (D): у получателя подпись «через «…»» — название СВОЕГО инстанса (`GET /instance`, `selfInstanceName.ts`), а не локальное имя значка (адрес). */
  const selfInstanceName = useStore((s) => s.selfInstanceName ?? '');
  const viaSelfLocal = useStore((s) => s.fedVia?.self ?? '');
  const viaSelf = selfInstanceName || viaSelfLocal;
  const filesHint = viaOn ? FED_VIA_TEXT_ONLY : fedFilesHint(!!peerHome, fedFiles, fedNoFiles ? { fedNoFiles: true } : null);
  // G56: действия над одним элементом альбома — у сервера с `album1`.
  const albumOn = useStore((s) => serverAlbumItemsOn(s.serverFeatures));
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
            /* G56 (`album1`): один элемент альбома. Переслать — новое сообщение с ним одним (тот же id отправки на повтор, что у
               `forward`); удалить — элемент уходит событием `conv.change` (оно приходит и мне), последний — сообщение целиком. */
            ...(albumOn
              ? {
                  forwardItem: async (messageId: string, attachmentId: string, to: string, silent?: boolean, opts?: { hideSender?: boolean }) => {
                    const key = `${dm.id}>${to}:${messageId}/${attachmentId}`;
                    const clientId = forwardKeys.get(key) ?? newClientId();
                    forwardKeys.set(key, clientId);
                    const res = await api.convForward(to, {
                      clientId,
                      fromConversationId: dm.id,
                      messageIds: [messageId],
                      attachmentId,
                      ...(silent && silentOn ? { silent: true } : {}),
                      ...(forwardOptsOn && opts?.hideSender ? { hideSender: true } : {}),
                    });
                    forwardKeys.delete(key);
                    useStore.getState().convAfterForward(to, res.messages);
                  },
                  deleteItem: async (messageId: string, attachmentId: string, scope: 'me' | 'both') => {
                    // Отказ 409 `album_item_peer_old` переводит в слова `MessagePane.delItem` (`ALBUM_ITEM_PEER_OLD_TEXT`).
                    const res = await api.convDeleteAlbumItem(dm.id, messageId, attachmentId, scope);
                    if (res.removed === 'message') useStore.getState().convAfterDelete(dm.id, messageId);
                  },
                }
              : {}),
            peerName: (id) => {
              const u = useStore.getState().dms.find((d) => d.id === id)?.otherUser;
              return u ? peerNameNow(u.id, u.displayName) : '';
            },
            open: (id) => void useStore.getState().selectDm(id),
          }
        : undefined,
    [batchOn, former, silentOn, schedForward, forwardOptsOn, albumOn, dm.id],
  );
  /* Раунд 12, порция 7 — закреп в ЛС (С2, `conv7`): только за переключателем пузырей, в режиме бесед и у сервера с
     признаком; иначе ни запроса, ни пунктов, ни полосы. Список — в сторе (`conv.pins`): загрузка при открытии беседы,
     дальше его ведут `conv.change` с полем `pins` и догонка. Сброшен (смена токена, обрезанный журнал) — просим заново. */
  // Бывшая группа (`groups3`): закрепы — только участникам, запроса нет (сервер ответил бы «нет такой»).
  const pinsOn = useStore((s) => serverDmPins(s.serverFeatures) && !s.conv.summaries[dm.id]?.former && !fedLinkBroken(s.conv.summaries[dm.id]));
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
            pin: async (messageId, scope, notify) => {
              useStore.getState().convSetPins(dm.id, await api.convPin(dm.id, messageId, scope, notify));
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
  const strangerOn = useStore((s) => serverStranger(s.serverFeatures));
  const isStranger = useStore((s) => s.conv.summaries[dm.id]?.stranger === true);
  const [reportOpen, setReportOpen] = useState(false);
  /* Контакты (08.10, `contacts1`): у беседы 1:1 с живым человеком; гостю соседнего инстанса — нет (сервер ответит 403), и человеку другого
     инстанса — тоже (`contacts.guest`, Э2 часть Б): на плашке незнакомца остаются «Пожаловаться» и «Заблокировать». */
  const contactsOn =
    useStore((s) => serverContacts(s.serverFeatures)) && !user?.homeInstance && !dm.group && !dm.saved && !peerHome;
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
  const features = useStore((s) => s.serverFeatures);
  /* Э4 (#141, `fedm4`): статус человека другого инстанса (`peerHome`) показываем, только если сервер объявил `fedm4` — до него теневой
     пользователь «никогда не в сети», а `last-seen` врёт «был(а) давно». Выключено — как у собеседника без данных: ни запроса, ни точки, ни «в сети». */
  const presenceOn = peerPresenceShown(!!peerHome, features);
  // Э4: гейт присутствия человека соседа — на результате, сам вызов прежний (его выражение исполняет `presenceClient.test`).
  const rawOnline = useStore((s) => dmPresent(s, dm.otherUser.id));
  const gatedOnline = presenceOn && rawOnline;
  /* Связи с сервером нет (замечание владельца 05.10, как у Telegram): вместо статуса собеседника — «Соединение…» или
     «Ожидание сети…» (`connState.ts`); «в сети», точка у аватара и «печатает» в это время устарели и не показываются. */
  const conn = connLabel(useConnState());
  /* «Был(а) в сети» (С1, `lastseen1`): «был(а) 5 минут назад / сегодня в 14:30 / недавно» вместо пустой строки, как у
     Telegram; без признака сервера — `null`, шапка как раньше. «В сети» — по-прежнему точка шлюза. */
  const lastSeen = useLastSeen(group || saved || !presenceOn ? null : dm.otherUser.id);
  /* Р-2 (`lastseen2`, сервер без `presence4`): время захода собеседника мне скрыто — ни «в сети», ни точки, а «был(а) недавно».
     С `presence4` (решение владельца 08.10) «в сети» — по присутствию всегда, скрытое время даёт «был(а) недавно» только вышедшему. */
  const localOnline = useLocalOnline(group || saved || !presenceOn ? null : dm.otherUser.id);
  const online = dmDot(gatedOnline, lastSeen?.exact, features, localOnline);
  /* O5 (приёмка S20+, 09.10): снимок «был(а)» ещё `online:true` (приходит позже присутствия — `online.away` / `online.update`), а «в сети»
     уже нет — раньше строка была пустой ~1,5 с. Теперь сразу «был(а) только что» (время мне видно) или «был(а) недавно» (скрыто
     приватностью — точное не раскрываем). Пусто — только пока снимка нет вовсе или человек в сети. */
  const seenForms = !lastSeen || online ? [] : lastSeen.online ? [lastSeen.exact ? 'был(а) только что' : 'был(а) недавно'] : lastSeenForms(lastSeen, new Date());
  const seenText = seenForms[0] ?? '';
  const lastSeenOn = useStore((s) => serverLastSeen(s.serverFeatures));
  // «N прочитали» в меню своего сообщения группы (15.10, `readers1`); `read-at` — только 1:1 (группе он отвечает 404).
  const readersOn = useStore((s) => serverReaders(s.serverFeatures));
  // Бот (#229, 26.10): точки «в сети» у аватара нет, под именем — «бот» (как у Telegram), а не «был(а)…».
  const peerOnline = online && !conn && !peerBot;
  // Собеседник в «отошёл» (20.10): точка «нет на месте» и строка «нет на месте» вместо «в сети».
  const peerAway = useStore((s) => s.userStatuses?.[dm.otherUser.id]?.status === 'away');
  const peerTyping = typing && !conn;
  const phone = usePhoneLayout();
  /* Тесная шапка телефона (#218): «был(а) сегодня в 03:53» не влезает на 360 — показываем самую полную форму, что влезла (`lastSeenForms`, замер — `useStatusFit`). */
  const statusRef = useRef<HTMLSpanElement>(null);
  const shortForms = phone && seenForms.length > 1;
  useStatusFit(statusRef, shortForms ? seenForms.join('|') : '');

  /* Шапка кликабельна (G06, Telegram 03·2.2.1 / 2.2.3): аватар и имя открывают карточку собеседника — на ПК та же карточка,
     что по клику на аватар в ленте (`useUserMenu`, вид «profile»), на телефоне она же листом снизу. Меню «⋯» — те же
     действия, что раньше были отдельными кнопками (уведомления, заблокировать) + «Показать профиль». */
  const { openAt: openUserCardAt, menu: userCard } = useUserMenu();
  const [moreAt, setMoreAt] = useState<{ x: number; y: number; rect?: DOMRect } | null>(null);
  // Телефон (#218): «⋮» беседы показывает подменю «Уведомления» на месте своих пунктов (Telegram Android `openSwipeBack`).
  const [muteSub, setMuteSub] = useState(false);
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
    ...(peerBot ? { bot: true } : {}),
  };
  const showProfile = (el: HTMLElement | null) => {
    const r = el?.getBoundingClientRect();
    openUserCardAt({ x: r?.left ?? 0, y: (r?.bottom ?? 0) + 8 }, peerTarget, 'profile');
  };

  /* Раунд 12, порция 8 — меню кнопки «Отправить» и «Отложенные» (С3 `conv8`, С4 `conv9`): только за переключателем пузырей,
     в режиме бесед и у сервера с признаком; иначе ни пунктов, ни входа. Список отложенных — в сторе (`conv.scheduled`):
     загрузка при открытии вида, дальше его ведут `conv.change` с полем `scheduled` и догонка; число для входа — оттуда же
     или из сводки (`scheduledCount`). */
  const schedOn = useStore((s) => serverScheduled(s.serverFeatures));
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
  const unreadNow = useStore((s) => s.conv.summaries[dm.id]?.unread ?? 0);
  useEffect(() => {
    if (unreadNow === 0) clearOsNotifications(dm.id);
  }, [unreadNow, dm.id]);

  /* Снимок на начало визита (шаг 2г): ключ прочитанного снят `useChannelVisit` ДО «прочитано» — черта «Новые
     сообщения» не ползёт, пока читаешь; место — только когда непрочитанного нет (последнее сообщение сводки против
     снятого ключа). */
  const visitStart = useMemo(() => {
    const s = useStore.getState();
    const last = s.conv.summaries[dm.id]?.lastMessage;
    const unread = readKey !== null && !!last && last.sortKey > readKey && last.authorId !== s.user?.id;
    return { readKey, place: unread ? null : (s.places[dm.id] ?? null) };
  }, [visitKey, readKey, dm.id]);
  const feedWindow: FeedWindowProps = {
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
  };
  // Бывшая группа: поиск по её ленте сервер не отдаёт (`/conv/:id/search` — «нет такой»).
  const searchOn = searchFlag && !former;
  // Звонок 1:1 (С5, `calls1`): трубка в шапке, как tdesktop `TopBarWidget` / tweb `ChatTopbar` — между поиском и «⋯». Только
  // беседа 1:1 (не группа, не «Избранное»), заблокированному не звоним (сервер всё равно ответит 403).
  // «Кто может звонить» (`presence4`, решение владельца 08.10 п.25): собеседник запретил мне звонить (`canCall === false` из
  // `GET /users/:id/last-seen`) — трубка ОСТАЁТСЯ, по нажатию окно «ограничил(а) звонки» (как Telegram), звонка нет.
  // Бот (#229, 26.10) звонков не принимает (Telegram у бота трубку не рисует) — трубки нет (`!peerBot` у кнопки и «Перезвонить»),
  // сервер тоже отвечает 403.
  const callsOn =
    useStore((s) => serverCalls(s.serverFeatures)) && !group && !saved && !former && !blocked;
  const callsDenied = lastSeen?.canCall === false;
  // «Кто может мне писать» (`msgpriv1`, 13.10): собеседник пускает только контакты (и тех, кому писал сам), я не прохожу —
  // вместо поля ввода плашка, как tdesktop `lng_restricted_send_non_premium` в `history_view_compose_controls.cpp`.
  const messagesDenied = !group && !saved && !former && !blocked && lastSeen?.canMessage === false;
  // Э6 (`fedcall1`): человек другого инстанса — трубка неактивна с подсказкой, пока наш сервер без `fedcall1` или его инстанс не принимает звонки.
  const callsFedLocked = useStore((s) => fedCallsLocked(peerHome, s.serverFeatures, s.conv.summaries[dm.id]));
  // Подсказка — только когда отказал инстанс собеседника (`fedNoCalls`); подпись трубки без него прежняя (`R192`: кнопка ищется по «Позвонить»).
  const callsFedNoHint = useStore((s) => !!peerHome && s.conv.summaries[dm.id]?.fedNoCalls === true);
  const inCall = useCall((s) => !!s.call);
  const chatSearch: ChatSearchSource | undefined = searchOn
    ? {
        open: searchOpen,
        setOpen: setSearchOpen,
        search: (q, before) => api.convSearch(dm.id, q, before, SEARCH_PAGE),
        jumpToDate: (day) => useStore.getState().convJumpToDate(dm.id, day),
      }
    : undefined;

  /* Медиатека беседы для просмотра (G11): порции истории за краем окна ленты — `convHistory` в обе стороны (удалённое
     у меня — мимо). */
  const loadMediaPage = async (dir: -1 | 1, edge: Message): Promise<{ messages: Message[]; more: boolean }> => {
    const sortKey = (edge as Partial<ConvMessage>).sortKey;
    if (typeof sortKey !== 'number') return { messages: [], more: false };
    const cur = convCursor({ sortKey, id: edge.id });
    const res = await api.convHistory(dm.id, dir < 0 ? { before: cur, limit: 100 } : { after: cur, limit: 100 });
    const gone = useStore.getState().conv.gone;
    const list = res.messages.filter((m): m is ConvMessage => !('gone' in m) && !gone[m.id]);
    return { messages: list, more: dir < 0 ? res.hasMoreBefore : res.hasMoreAfter };
  };

  return (
    <MessagePane
      nameOf={nameOf}
      quoteNames
      // Файл до 512 МБ кусками (`bigfile1`) — путём бесед (`api.convUpload`).
      // Предел считает сама лента (`attachRules.dmAttachMaxBytes`): харнесс шапки грузит этот файл с перечнем импортов.
      bigFiles
      onRedial={callsOn && !peerBot && !linkBroken && !callsDenied && !callsFedLocked && !inCall ? () => void useCall.getState().start(dm.id) : undefined}
      newSince={newSince}
      scrollKey={visitKey}
      feedId={dm.id}
      botPeer={peerBot}
      loadMediaPage={loadMediaPage}
      title={
        /* Шапка беседы (раунд 11, HANDOFF §5): аватар с точкой «в сети», имя и строка состояния — «в сети» или пусто (без
           связи с сервером — «Подключение…» / «Ожидание сети», 05.10);
           «печатает» ложится в ту же клетку поверх, ширина подписи не меняется. ПК — одной строкой, подпись как тема
           канала (`.topbar-topic`); телефон — имя над подписью, без подписи (`.solo`) имя по центру. На телефоне аватар
           как у Telegram Android — 42 (`ChatAvatarContainer.java:265`, радиус 21) и БЕЗ точки «в сети»: присутствие там
           только словами в строке состояния (#218). ПК (tdesktop) — 28 с точкой, как было. */
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
            {saved ? <SavedAvatar size={phone ? 42 : 28} /> : <Avatar url={dm.otherUser.avatarUrl} name={peerName} size={phone ? 42 : 28} />}
            {peerOnline && !phone && (
              <span className="mp-dot-wrap">
                <StatusDot status={peerAway ? 'away' : 'online'} size={phone ? 12 : 10} ringColor="var(--bg)" />
              </span>
            )}
          </span>
          <span className={`dm-who${peerTyping ? ' typing' : ''}${saved || (!group && !peerBot && !peerOnline && !peerTyping && !conn && !seenText) ? ' solo' : ''}`}>
            <strong>
              {peerName}
              {peerBot && (
                <span className="bot-tag" title="Это бот: им управляет программа его владельца">
                  БОТ
                </span>
              )}
              {/* Э1 (`fedm1`): собеседник с другого инстанса — значок как `GuestMark` списка участников (импорт сюда нельзя, см. выше). */}
              {peerHomeLabel && (
                <span className="guest-mark" title={`С инстанса «${peerHomeLabel}»`} aria-label={`с инстанса «${peerHomeLabel}»`}>
                  <Icon name="globe" size={12} />
                </span>
              )}
            </strong>
            <span className="topbar-topic dm-who-sub">
              {/* Скрытая из двух подписей прозрачна, но в дереве — скринридеру её не читать. */}
              <span ref={statusRef} className="dm-who-status" aria-hidden={peerTyping || undefined}>
                {conn ??
                  (saved
                    ? ''
                    : former
                    ? former.removed
                      ? 'вас исключили из группы'
                      : 'вы покинули группу'
                    : group
                      ? groupMembersLabel(group.members.length)
                      : peerBot
                        ? 'бот'
                        : online
                        ? peerAway
                          ? 'нет на месте'
                          : 'в сети'
                        : shortForms
                          ? seenForms.map((f, i) => (
                              <span key={f} data-form hidden={i > 0}>
                                {f}
                              </span>
                            ))
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
          {callsOn && !linkBroken && (
            !peerBot && (
              <button
                type="button"
                className="topbar-btn"
                title={callsFedNoHint ? FED_NO_CALLS_TEXT : 'Позвонить'}
                aria-label="Позвонить"
                disabled={inCall || callsFedLocked}
                onClick={() => (callsDenied ? explainCallPrivacy(peerName) : void useCall.getState().start(dm.id))}
              >
                <Icon name="phone" size={18} />
              </button>
            )
          )}
          <button
            ref={moreBtnRef}
            type="button"
            className={`topbar-btn ${moreAt ? 'active' : ''}`}
            title="Меню беседы"
            aria-haspopup="menu"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              // `rect` — якорь выпадающего меню на телефоне (`drop`); ПК — меню по точке под кнопкой, как было.
              setMoreAt({ x: r.right, y: r.bottom + 4, rect: r });
              setMuteSub(false);
            }}
          >
            <Icon name="more" size={18} />
          </button>
          {moreAt &&
            (() => {
              const close = () => setMoreAt(null);
              const searchItem = searchOn && (
                <MenuItem
                  icon="search"
                  label="Поиск"
                  onClick={() => {
                    close();
                    setSearchOpen(true);
                  }}
                />
              );
              const groupInfoItem = group && !former && (
                <MenuItem
                  icon="users"
                  label="Информация о группе"
                  onClick={() => {
                    close();
                    openGroupInfo(dm.id);
                  }}
                />
              );
              /* Группа (`groups2`): тот же «Выключить уведомления ▸», цель заглушки — `group:<id>` (= `otherUser.id`). */
              const muteItem = saved || former ? null : alwaysAct ? (
                <MenuItem
                  icon={alwaysAct === 'enable' ? 'bell' : 'bell-off'}
                  label={alwaysAct === 'enable' ? 'Включить уведомления' : 'Выключить уведомления'}
                  onClick={() => {
                    close();
                    useStore.getState().setPushAlways(dm.otherUser.id, alwaysAct === 'enable').catch(toastError);
                  }}
                />
              ) : phone && moreAt.rect && prefsOn && !pushMuted ? (
                /* Телефон (#218): «Уведомления ▸» (подпись как у TG — решение владельца 12.10) открывает подменю в том же меню, как Telegram Android (`muteItem` —
                   `lazilyAddSwipeBackItem(…, chatNotificationsPopupWrapper.windowLayout)` → `openSwipeBack`, `TA/ui/ChatActivity.java:4373-4387`);
                   заглушена — «Включить уведомления» сразу, без подменю (ветка ниже). */
                <MenuItem icon="bell-off" label="Уведомления" submenu onClick={() => setMuteSub(true)} />
              ) : <MenuItem
                icon={pushMuted ? 'bell' : 'bell-off'}
                label={pushMuted ? 'Включить уведомления' : prefsOn ? 'Выключить уведомления…' : 'Отключить уведомления'}
                // Заглушена на время — остаток срока серым справа (решение 41, 08.10: в этом меню его не было вовсе).
                shortcut={(pushMuted && prefsOn && muteLeftLabel(mute, muteNow)) || undefined}
                note
                onClick={() => {
                  close();
                  // Сервер умеет срок (conv11) и сейчас звук есть — выбор срока; иначе — прежний переключатель.
                  if (prefsOn && !pushMuted) setBellAt(new DOMRect(moreAt.x - 1, moreAt.y - 4, 1, 1));
                  else setPushMuted('dm_user', dm.otherUser.id, !pushMuted).catch(toastError);
                }}
              />;
              const archiveItem = archiveOn && !former && (
                <MenuItem
                  icon={dm.archived ? 'unarchive' : 'archive'}
                  label={archiveMenuLabel(dm.archived === true)}
                  onClick={() => {
                    close();
                    archiveDms([dm.id], dm.archived !== true);
                  }}
                />
              );
              /* Телефон: закрепление беседы переехало из шапки в меню (тот же экшен, что у кнопки-пина на ПК). */
              const pinItem = phone && prefsOn && !former && (
                <MenuItem
                  icon={pinned ? 'pin-off' : 'pin'}
                  label={pinned ? 'Открепить' : 'Закрепить'}
                  onClick={() => {
                    close();
                    toggleDmPinned(dm.id, !pinned);
                  }}
                />
              );
              const profileItem = !group && !saved && (
                <MenuItem
                  icon="user"
                  label="Показать профиль"
                  onClick={() => {
                    close();
                    openUserCardAt({ x: moreAt.x - 320, y: moreAt.y }, peerTarget, 'profile');
                  }}
                />
              );
              /* Контакты (`contacts1`), как меню профиля Telegram: «Добавить в контакты» или «Изменить контакт» / «Удалить контакт». */
              const addContactItem = contactsOn && !former && !peerContact && (
                <MenuItem
                  icon="user-plus"
                  label="Добавить в контакты"
                  onClick={() => {
                    close();
                    useContacts.getState().openEdit(peerPerson, 'add');
                  }}
                />
              );
              const editContactItems = contactsOn && !former && peerContact && (
                <>
                  <MenuItem
                    icon="edit"
                    label="Изменить контакт"
                    onClick={() => {
                      close();
                      useContacts.getState().openEdit(peerPerson, 'edit');
                    }}
                  />
                  <MenuItem
                    icon="trash"
                    label="Удалить контакт"
                    onClick={() => {
                      close();
                      void removeContactAsk(peerPerson, contactLabel(peerContact));
                    }}
                  />
                </>
              );
              /* С «Добавить в контакты» на плашке телефона «Пожаловаться» живёт здесь (как «Report» в меню Telegram Android). */
              const reportItem = strangerBar && contactsOn && (
                <MenuItem
                  icon="flag"
                  label="Пожаловаться"
                  onClick={() => {
                    close();
                    setReportOpen(true);
                  }}
                />
              );
              const blockItem = saved || former ? null : group ? (
                <MenuItem
                  icon="logout"
                  label="Покинуть группу"
                  danger
                  onClick={() => {
                    close();
                    void leaveGroup(dm.id, group.title);
                  }}
                />
              ) : (
                <MenuItem
                  icon="ban"
                  label={blocked ? 'Разблокировать' : 'Заблокировать'}
                  danger={!blocked}
                  onClick={() => {
                    close();
                    void switchBlock();
                  }}
                />
              );
              /* Бывшая группа (Telegram Android `ChatActivity`: при `isNotInChat` нет «Покинуть», остаётся удалить): одно «Удалить группу». */
              const formerItem = former && (
                <MenuItem
                  icon="trash"
                  label="Удалить группу"
                  danger
                  onClick={() => {
                    close();
                    void deleteFormerGroup(dm);
                  }}
                />
              );
              const clearItems = clearOn && !former && (
                <>
                  <MenuItem
                    icon="close"
                    label="Очистить историю"
                    onClick={() => {
                      close();
                      void clearHistory(dm, nameOf);
                    }}
                  />
                  <MenuItem
                    icon="trash"
                    label="Удалить чат"
                    // В «⋮» телефона — обычным цветом, как у Telegram Android (окно подтверждения всё равно спросит); ПК — как было.
                    danger={!phone}
                    onClick={() => {
                      close();
                      void deleteChat(dm, nameOf);
                    }}
                  />
                </>
              );
              /* Телефон (10.10, #218): выпадающее меню у правого верхнего угла, как «⋮» Telegram Android (`ChatActivity`
                 `headerItem`, порядок `lazilyAddSubItem`): уведомления (`muteItem`) · разрыв (`lazilyAddColoredGap`) · Поиск ·
                 Добавить в контакты · Очистить историю · Удалить чат. Звонок у нас — кнопкой в шапке, перевода, таймера, обоев и
                 ярлыка нет. Наше, чего в этом меню у Telegram нет (в списке бесед, профиле, плашке), — после «Поиска» и «Добавить
                 в контакты», ПЕРЕД «Очистить историю / Удалить чат»: разрушающие остаются последними, как у Telegram (решение
                 владельца 10.10). ПК — прежнее меню по точке и прежний порядок. */
              if (phone && moreAt.rect && muteSub && !pushMuted) {
                // Тот же якорь и вид, что у основного меню ниже: подменю встаёт на его место.
                return (
                  <ContextMenu anchor={moreAt.rect} drop align="end" width={196} fit onClose={close}>
                    <DmMuteMenuItems peerId={dm.otherUser.id} mute={mute} now={muteNow} onDone={close} onBack={() => setMuteSub(false)} />
                  </ContextMenu>
                );
              }
              if (phone && moreAt.rect) {
                return (
                  <ContextMenu anchor={moreAt.rect} align="end" drop width={196} fit onClose={close}>
                    {muteItem}
                    {muteItem && <MenuDivider />}
                    {searchItem}
                    {addContactItem}
                    {groupInfoItem}
                    {archiveItem}
                    {pinItem}
                    {profileItem}
                    {editContactItems}
                    {reportItem}
                    {blockItem}
                    {formerItem}
                    {clearItems}
                  </ContextMenu>
                );
              }
              return (
                <ContextMenu pos={{ x: Math.max(0, moreAt.x - 264), y: moreAt.y }} width={264} fit onClose={close}>
                  {groupInfoItem}
                  {muteItem}
                  {archiveItem}
                  {pinItem}
                  {profileItem}
                  {searchItem}
                  {addContactItem}
                  {editContactItems}
                  {reportItem}
                  {!saved && !former && <MenuDivider />}
                  {blockItem}
                  {/* Как у Telegram (03·2.3.1 / 2.3.2): «Очистить историю» и «Удалить чат» — в конце меню; окна те же, что у меню строки. */}
                  {formerItem}
                  {clearItems && (
                    <>
                      <MenuDivider />
                      {clearItems}
                    </>
                  )}
                </ContextMenu>
              );
            })()}
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
              peerHome={peerHomeLabel}
              onAdd={contactsOn ? () => useContacts.getState().openEdit(peerPerson, 'add') : undefined}
              onBlock={() => void switchBlock()}
              onReport={() => setReportOpen(true)}
              onHide={() => void useStore.getState().hideStrangerBar(dm.id).catch(toastError)}
            />
            {reportOpen && (
              <StrangerReportModal
                convId={dm.id}
                peer={{ id: peer.id, displayName: peer.displayName }}
                holder={peerHomeLabel}
                blocked={blocked}
                onBlock={blockQuiet}
                onClose={() => setReportOpen(false)}
              />
            )}
          </>
        ) : undefined
      }
      composerNotice={
        peerDown && !linkBroken ? (
          <div className="composer-blocked fed-archive fed-stale fed-peer-down" role="status">
            <Icon name="clock" size={16} />
            <span className="muted">{fedPeerDownText(peerHomeLabel)}</span>
          </div>
        ) : linkStale && !linkBroken ? (
          <div className="composer-blocked fed-archive fed-stale" role="status">
            <Icon name="clock" size={16} />
            <span className="muted">{fedLinkStaleText(peerHomeLabel)}</span>
          </div>
        ) : groupDownText && !former ? (
          <div className="composer-blocked fed-archive fed-stale fed-group-down" role="status">
            <Icon name="clock" size={16} />
            <span className="muted">{groupDownText}</span>
          </div>
        ) : undefined
      }
      composerReplacement={
        former ? (
          <div className="composer-blocked">
            <span className="muted">{former.removed ? 'Вас исключили из группы.' : 'Вы покинули группу.'}</span>
            <button type="button" className="link" onClick={() => void deleteFormerGroup(dm)}>
              Удалить группу
            </button>
          </div>
        ) : linkBroken ? (
          <div className="composer-blocked fed-archive" role="status">
            <Icon name="lock" size={16} />
            <span className="muted">{fedLinkBrokenText(peerHomeLabel)}</span>
          </div>
        ) : blocked ? (
          <div className="composer-blocked">
            <span className="muted">Вы заблокировали {peerName}.</span>
            <button type="button" className="link" onClick={() => void switchBlock()}>
              Разблокировать
            </button>
          </div>
        ) : messagesDenied ? (
          <div className="composer-blocked" role="status">
            <Icon name="lock" size={16} />
            <span className="muted">{messagePrivacyPlateText(peerName)}</span>
          </div>
        ) : botUnavailable ? (
          <div className="composer-blocked" role="status">
            <Icon name="lock" size={16} />
            <span className="muted">{botUnavailablePlateText(botUnavailable, peerName)}</span>
          </div>
        ) : botGate ? (
          // Ничего на месте поля (не плашка): кнопка «Старт» — по центру ленты (`BotStartEmpty`).
          <></>
        ) : undefined
      }
      /* Как у Telegram Android: просто «Сообщение» (решение владельца 09.10), без имени собеседника. */
      placeholder="Сообщение"
      groupChat={!!group}
      // «@» в группе (`groups2`, tdesktop `field_autocomplete.cpp`): подсказка — участники, кроме себя; без @everyone.
      autocomplete={groupMentions}
      messages={messages}
      loading={messagesRaw === undefined && !failed}
      emptyState={failed ? (
        <FeedLoadError onRetry={() => void refreshDmHistory(dm.id)} />
      ) : saved ? (
        <SavedEmpty />
      ) : peerBot ? (
        <BotStartEmpty
          name={peerName}
          avatarUrl={dm.otherUser.avatarUrl}
          description={dm.otherUser.botDescription}
          onStart={botUnavailable ? undefined : () => {
            setBotStartedIn(dm.id);
            useStore.getState().outboxEnqueue(dm.id, { key: newClientId(), content: '/start', files: [], replyToId: null });
          }}
        />
      ) : undefined}
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
      // «Прочитано» по видимому (G09): лента сообщает увиденное — с начала визита.
      onSeen={started ? (key) => useStore.getState().convSeen(dm.id, key) : undefined}
      bubbles
      peerReadKey={peerReadKey}
      readAtConvId={lastSeenOn && !saved && !group ? dm.id : null}
      readersConvId={readersOn && group && !saved ? dm.id : null}
      onTyping={saved || (peerHome && !serverFedPresence(features)) ? undefined : (action) => sendTyping({ dmId: dm.id, recipientId: dm.otherUser.id }, action)}
      meId={user?.id}
      draft={initialDraft}
      draftRemote={draftRemote}
      onDraftChange={(text, replyToId) => useStore.getState().setDraft(dm.id, text, replyToId)}
      sendFlags={sendFlagsOn}
      mediaFlags={mediaFlagsOn}
      quoteOn={quoteOn}
      outbox={{
        items: outboxItems,
        enqueue: (item) => useStore.getState().outboxEnqueue(dm.id, item),
        retry: (key) => useStore.getState().outboxRetry(dm.id, key),
        discard: (key) => useStore.getState().outboxDiscard(dm.id, key),
      }}
      // ЛС шлёт очередь бесед (`outbox` выше); `onSend` ленты (путь без очереди — каналы) сюда не доходит.
      onSend={() => Promise.reject(new Error('ЛС отправляются очередью бесед'))}
      stickerPacks={stickersOn ? (myStickers ?? []) : undefined}
      onSendSticker={stickersOn ? (stickerId) => (viaOn ? Promise.reject(new Error(FED_VIA_TEXT_ONLY)) : sendStickerRef.current(stickerId)) : undefined}
      // Файлы людям других инстансов: закрыты без `fedm3` или при `fedNoFiles` (Э3) — скрепка неактивна с подсказкой, голосовое, кружок и GIF скрыты.
      filesBlocked={filesHint ?? undefined}
      viaNames={peerHome || groupHostId ? { self: viaSelf, peer: viaPeerLabel ?? '' } : undefined}
      composerNote={
        viaOn ? (
          <div className="fed-via-bar" role="status">
            <Icon name="globe" size={14} />
            <span>{fedViaBarText(viaSelf, viaPeerLabel ?? '')}</span>
          </div>
        ) : undefined
      }
      onSendGif={gifsOn && !filesHint ? sendGif : undefined}
      // «Через» (Э5) — только текст; у бывшей группы и архива поля ввода нет вовсе.
      onSendMedia={geoContactOn && !viaOn ? sendMedia : undefined}
      convPoll={convPollFeature && (!peerHome || fedPollOk) && !groupHostId && !viaOn}
      geoLive={geoLiveFeature && !peerHome && !groupHostId && !viaOn}
      // Бывшая группа (`groups3`): сервер вышедшему сохранить не даст (404, нет участия) — пункта в меню нет (ревью 08.10).
      onSaveGif={gifsOn && !former ? saveGif : undefined}
      stickerRecent={stickersOn ? recentStickers : undefined}
      stickerCatalog={stickersOn ? <StickerCatalogPanel /> : undefined}
      onStickerUsed={stickersOn ? (st) => useDmStickers.getState().used(st) : undefined}
      onEscapeClose={() => {
        /* Последний Esc — закрыть беседу (07.10, G15; Telegram Desktop `HistoryWidget::escape` → `_cancelRequests` →
           `showBackFromStack`): на ПК справа «Выбери диалог», в одну колонку (узкое окно) — назад к списку. Фокус в поиск
           бесед НЕ уводим (просьба владельца 10.10: Esc только закрывает беседу; раньше тут был `.dm-find input`.focus()). */
        const s = useStore.getState();
        if (phone) return s.setMobilePane('list');
        useStore.setState({ currentDmId: null });
      }}
      voiceOnce={voiceOnceOn}
      mediaOnce={mediaOnceOn}
      roundOk={roundOn && !filesHint}
      onSendVoice={filesHint ? undefined : async (take, opts) => {
        // ЛС голосовые умеют: это не серверная настройка, в отличие от стикеров и ников (#20).
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
      }}
      onEdit={async (m, content) => {
        if (viaOn) throw new Error(FED_VIA_TEXT_ONLY);
        useStore.getState().convAfterEdit(dm.id, await api.convEdit(dm.id, m.id, content));
      }}
      deletePeerName={peerName}
      batch={batch}
      deleteOthersForBoth={othersForBoth}
      pins={pins}
      readOnly={!!former || linkBroken}
      sendMenu={sendMenu}
      onDelete={async (m, scope) => {
        if (viaOn) throw new Error(FED_VIA_TEXT_ONLY);
        await api.convDelete(dm.id, m.id, scope ?? 'me');
        useStore.getState().convAfterDelete(dm.id, m.id);
      }}
      reactorOf={reactorOf}
      onReact={former || linkBroken ? undefined : (messageId, emoji, op) => {
        // Э5: дом недоступен — реакции закрыты с подсказкой (сервер соседа ответил бы 403 `federation.dm_via_limited`).
        if (viaOn) return void toastError(new Error(FED_VIA_TEXT_ONLY));
        // Persist; the gateway echoes the change back to both participants → store update.
        api.convReact(dm.id, messageId, emoji, op).catch(toastError);
      }}
      onReactBig={
        former || linkBroken || !bigFlag
          ? undefined
          : (messageId, emoji) => {
              if (viaOn) return void toastError(new Error(FED_VIA_TEXT_ONLY));
              // Как Telegram: у отправителя анимация сразу, реакция ставится (повтор своей — снова «большая»), собеседнику — `reaction.big`.
              fireEffect({ kind: 'bigReaction', conversationId: dm.id, messageId, emoji });
              api.convReact(dm.id, messageId, emoji, 'add', true).catch(toastError);
            }
      }
    />
  );
}
