import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useDialogChrome } from '../dialogChrome';
import { serverSaved } from '../convSyncRules';
import { matchDmName, matchDmUsername, plural } from '../dmRowRules';
import { usePhoneLayout } from '../phoneLayout';
import { dmPeerLabel, usePeerName } from '../peerName';
import { useStore } from '../store';
import { useVisibleOnline } from '../dmOnline';
import { BottomSheet } from './BottomSheet';
import { createPortal } from 'react-dom';
import { ContextMenu, MenuItem } from './ContextMenu';
import { DmRow, ForwardAva, ForwardCell } from './DmSidebar';
import { Icon } from './Icon';
import { SchedPick } from './SchedPick';
import { ShareChannelRow } from './ShareChannelRow';
import type { ShareChannel } from '../shareInbox';

export interface ForwardPickerProps {
  /** Сколько сообщений уйдёт — только для подписи («2 сообщения · уйдут сразу в выбранную беседу»). */
  count: number;
  /**
   * «Отправить» (07.10, G71; Telegram `ShareBox`): беседы отмечены галочками, внизу — «Комментарий» и кнопка «Отправить».
   * Вызывается не больше одного раза за жизнь окна, следом окно закрывается (`onClose`). Саму пересылку, комментарий, плашку
   * «Переслано» и снятие выделения делает вызывающий: окно ничего не знает ни о сообщениях, ни о сети. Беседы — в порядке
   * списка. `silent` — «Отправить без звука» из «⋯»; `at` — «Отправить позже» (время из `SchedPick`), иначе `null`;
   * `comment` — текст поля «Комментарий» (после `trim`, пусто — без него); `hideSender` / `hideCaptions` — переключатели
   * (только при `canHide`).
   */
  onSend: (
    conversationIds: string[],
    opts: { silent: boolean; at: Date | null; comment: string; hideSender: boolean; hideCaptions: boolean },
  ) => void;
  /** Сервер умеет «без звука» (`conv8`, `convSyncRules.serverSilentSend`): только тогда в «⋯» есть пункт. */
  canSilent?: boolean;
  /** «Отправить позже» доступно: сервер умеет отложенные и в выборе только текст (вложения в отложенные не пересылаются). */
  canLater?: boolean;
  /** Сервер умеет «скрыть имя отправителя» (`fwd2`): только тогда в окне есть переключатель. */
  canHide?: boolean;
  /** В выборе есть сообщения с вложением и подписью — тогда есть и «Скрыть подписи» (при `canHide`). */
  hasCaptions?: boolean;
  /** В выборе есть сообщения с файлами (Э2 часть Б, #141): беседы с людьми других инстансов файлы пока не примут — предупреждаем до отправки. */
  hasFiles?: boolean;
  /** Закрыть окно: крестик, щелчок мимо, Esc, «назад» на телефоне и сразу после выбора. */
  onClose: () => void;
  /** Беседы, отмеченные при открытии (G76: сообщения брошены на строку списка); нет — окно пустое. */
  initial?: readonly string[];
  /**
   * Выбор ОДНОЙ беседы (08.10, `quote1`, G55 — «Ответить в другом чате», Telegram `ShowReplyToChatBox`): без галочек,
   * комментария и «Отправить» — нажатие строки сразу зовёт `onPick` и закрывает окно. Текущей беседы в списке нет.
   */
  pickOne?: {
    title: string;
    what: string;
    onPick: (conversationId: string) => void;
    /** Текущая беседа тоже в списке («Поделиться в GusVoice», 09.10, G79: окно открывают не из ленты). */
    keepCurrent?: boolean;
  };
  /**
   * Черновик пересылки (08.10, решение владельца п.9; Telegram 5.11 / 5.14 — `ShowForwardMessagesBox` → `singleChosen` →
   * `setForwardDraft`, Android `DialogsActivity.onItemClick`): пока ничего не отмечено, нажатие строки — «одна беседа»:
   * окно закрывается и зовёт `onDraft` (беседа откроется с полосой «Пересылка» над полем). Несколько бесед — выбор:
   * правый щелчок (ПК) или удержание (телефон) отмечает строку, дальше нажатия переключают галочки, и «Отправить» уходит
   * сразу, как без этого пропа. «Избранное» из другой беседы — сразу, без черновика (Telegram `ForwardToSelf`). Нет —
   * прежнее окно: галочки с первого нажатия.
   */
  onDraft?: (conversationId: string) => void;
  /**
   * «Поделиться в GusVoice» (09.10; Telegram Android `DialogsActivity` в режиме «поделиться»: нажатие — одна беседа, удержание —
   * несколько, «Отправить (N)» шлёт всем сразу): окно на `onDraft` (нажатие — одна беседа / канал, `onDraft` получает её id),
   * но с заголовком и подписью принятого, БЕЗ ярлыка «Избранное — сразу» (принятое должно сперва лечь в поле) и с текстовыми
   * каналами серверов под беседами (`channels`, уже отфильтрованные по праву писать). `onSend` получает id и бесед, и каналов
   * (вызывающий различает по `channels`). `head` — что пришло («2 файла и текст»); подсказку про выбор нескольких окно
   * дописывает само.
   */
  share?: { title: string; head: string; channels: readonly ShareChannel[] };
}

const TITLE_ID = 'fwd-pick-title';

/**
 * ПК — окно по центру, как остальные окна ПК (`.modal-overlay` > `.modal.create-channel.fwd-modal`, 420 px): заголовок
 * с крестиком, подпись, поле, список прокручивается внутри (`useDialogChrome`: Esc и возврат фокуса на кнопку, с которой
 * открыли).
 */
function ForwardDialog({
  title = 'Переслать в…',
  what,
  inputRef,
  onClose,
  children,
}: {
  title?: string;
  what: string;
  inputRef: RefObject<HTMLInputElement>;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useDialogChrome<HTMLDivElement>(onClose);
  // `useDialogChrome` ставит фокус на само окно (точка входа для читалок), а человеку сразу печатать имя — курсор в поле.
  // Эффект стоит ПОСЛЕ хука и потому выполняется после него: последнее слово за полем (так же у `ComposeDialog`).
  useEffect(() => {
    inputRef.current?.focus();
  }, [inputRef]);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal create-channel fwd-modal"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="admin-head">
          <h2 id={TITLE_ID}>{title}</h2>
          <button type="button" className="icon-close" aria-label="Закрыть" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <p className="modal-what">{what}</p>
        {children}
      </div>
    </div>
  );
}

/**
 * «Переслать в…» — выбор НЕСКОЛЬКИХ личных бесед (07.10, #211, G71; раньше — одна беседа и пересылка по нажатию, раунд 12).
 * Источник — Telegram Desktop `boxes/share_box.cpp` (`ShareBox`: строки с галочками, поле «Комментарий» появляется, когда
 * выбрана хоть одна беседа, кнопка «Отправить», правый щелчок по ней — `SendMenu`: «без звука» / «позже»), строки
 * `lng_forward_show_sender` («Скрыть имя отправителя» — `ForwardOptions::NoSenderNames`) и `lng_photos_comment`.
 * Поиск «Найти беседу» (`matchDmName`: начало любого слова, без регистра, «ё» = «е») и строки беседы раунда 11 (`DmRow`) —
 * как раньше, но нажатие строки ставит и снимает галочку, а не пересылает. «⋯» рядом с «Отправить» — «Отправить без звука» и
 * «Отправить позже» (окно `SchedPick`, там же колокольчик «без звука»).
 *
 * Телефон (`usePhoneLayout`, та же граница 760 px, что у мобильных стилей, а не `isMobile()`: тот истинен только в
 * приложении, и узкое окно браузера получило бы окно ПК внутри мобильных стилей) — `BottomSheet`, ПК — окно по центру.
 * Список бесед тот же, что у боковой панели ЛС (`store.dms` и сводки, черновики, очередь «не отправлено», «в сети»).
 */
export function ForwardPicker({
  count,
  onSend,
  canSilent = false,
  canLater = false,
  canHide = false,
  hasCaptions = false,
  hasFiles = false,
  onClose,
  initial,
  pickOne,
  onDraft,
  share,
}: ForwardPickerProps) {
  const phone = usePhoneLayout();
  const allDms = useStore((s) => s.dms);
  // «Избранное» (08.10, `saved1`, G72) — первая строка, как у Telegram. Беседы может ещё не быть: окно просит её завести
  // (`convOpenSaved`, без перехода), и строка появляется, как только пришла сводка.
  const savedServer = useStore((s) => s.convActive && serverSaved(s.serverFeatures));
  const isGuest = useStore((s) => !!s.user?.homeInstance);
  const savedOn = savedServer && !isGuest;
  const hasSaved = allDms.some((d) => d.saved);
  const ensureSaved = useStore((s) => s.convOpenSaved);
  useEffect(() => {
    if (savedOn && !hasSaved) void ensureSaved().catch(() => {});
  }, [savedOn, hasSaved, ensureSaved]);
  const dms = useMemo(() => (hasSaved ? [...allDms.filter((d) => d.saved), ...allDms.filter((d) => !d.saved)] : allDms), [allDms, hasSaved]);
  // Окно открывают из ленты открытой беседы, и пока оно поверх, лента на экране: числа непрочитанного у этой беседы не
  // рисуем — как `DmSidebar.shownDmId` в этом случае (там ещё разбирают ПК / телефон и раздел приложения, окну не нужно).
  const currentDmId = useStore((s) => s.currentDmId);
  const unreadDms = useStore((s) => s.unreadDms);
  const meId = useStore((s) => s.user?.id);
  // Сводки (превью, ✓ / ✓✓), черновики (Р7) и своя очередь отправки — беседы есть только в режиме бесед.
  const summaries = useStore((s) => s.conv.summaries);
  // Э3: сервер возит вложения между инстансами (`fedm3`, как `serverFedFiles` в `convSyncRules`; здесь строкой — модуль у тестов заглушён).
  const fedFiles = useStore((s) => !!s.serverFeatures?.includes('fedm3'));
  const drafts = useStore((s) => s.drafts);
  const outbox = useStore((s) => s.outbox);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<readonly string[]>(initial ?? []);
  const [comment, setComment] = useState('');
  const [hideSender, setHideSender] = useState(false);
  const [hideCaptions, setHideCaptions] = useState(false);
  // «⋯» у кнопки «Отправить» (и правый щелчок по ней): меню «без звука» / «позже»; «позже» открывает окно времени.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [later, setLater] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Обработчики вызывающего читаем через ref: окно живёт, пока вызывающий перерисовывается.
  const onSendRef = useRef(onSend);
  const onCloseRef = useRef(onClose);
  onSendRef.current = onSend;
  onCloseRef.current = onClose;
  // Меню «⋯» и окно времени закрываются своим Esc, и тот же Esc дошёл бы до окна «Переслать» и закрыл его целиком: пока
  // что-то из них открыто, закрытие самого окна (Esc, щелчок мимо, «назад») пропускаем.
  const overlayOpen = useRef(false);
  const close = useCallback(() => {
    if (overlayOpen.current) return;
    onCloseRef.current();
  }, []);
  // Второе нажатие, пока окно ещё не успело исчезнуть, второй раз не перешлёт: пересылка уходит сразу и не отменяется.
  // `finally` — окно закрывается, даже если обработчик вызывающего упал (само исключение никуда не девается).
  const sent = useRef(false);
  const shareRef = useRef(share);
  shareRef.current = share;
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const dmsRef = useRef(dms);
  dmsRef.current = dms;
  const formRef = useRef({ comment, hideSender: false, hideCaptions: false });
  formRef.current = { comment, hideSender: canHide && hideSender, hideCaptions: canHide && hasCaptions && hideCaptions };
  const send = useCallback((opts: { silent: boolean; at: Date | null }) => {
    if (sent.current || pickedRef.current.length === 0) return;
    sent.current = true;
    const f = formRef.current;
    try {
      // Выбранные уходят в порядке СПИСКА, а не кликов (R52, Telegram: пересылка идёт сверху вниз по списку).
      const order = new Map(dmsRef.current.map((d, i) => [d.id, i] as const));
      // Каналы (режим «поделиться») — после бесед, в порядке списка каналов.
      for (const [i, c] of (shareRef.current?.channels ?? []).entries()) order.set(c.id, dmsRef.current.length + i);
      const ids = [...pickedRef.current].sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity));
      onSendRef.current(ids, {
        silent: opts.silent,
        at: opts.at,
        comment: f.comment.trim(),
        hideSender: f.hideSender,
        hideCaptions: f.hideCaptions,
      });
    } finally {
      onCloseRef.current();
    }
  }, []);
  const toggle = useCallback((id: string) => {
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }, []);
  // «Одна беседа» (`onDraft`, Telegram `singleChosen`): ничего не отмечено — черновик в этой беседе, окно закрывается;
  // «Избранное» из другой беседы — сразу, без черновика (`ForwardToSelf`). Отмечено — нажатие переключает галочку.
  const draftMode = !!onDraft && !pickOne;
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  const currentRef = useRef(currentDmId);
  currentRef.current = currentDmId;
  const choose = useCallback(
    (id: string) => {
      if (sent.current) return;
      if (pickedRef.current.length > 0) return toggle(id);
      sent.current = true;
      try {
        // «Поделиться» (`share`): «Избранное» тоже сперва принимает принятое в поле, поэтому ярлыка «сразу» нет.
        const d = shareRef.current ? undefined : dmsRef.current.find((x) => x.id === id);
        if (d?.saved && id !== currentRef.current) {
          onSendRef.current([id], { silent: false, at: null, comment: '', hideSender: false, hideCaptions: false });
        } else onDraftRef.current?.(id);
      } finally {
        onCloseRef.current();
      }
    },
    [toggle],
  );
  const pickByMenu = useCallback((d: { id: string }) => toggle(d.id), [toggle]);

  const peerIds = useMemo(() => dms.map((d) => d.otherUser.id), [dms]);
  const onlineSet = useVisibleOnline(peerIds);
  const unreadSet = useMemo(() => new Set(unreadDms), [unreadDms]);
  const pickedSet = useMemo(() => new Set(picked), [picked]);
  const q = query.trim();
  const nameOf = usePeerName();
  // Выбранные беседы с людьми другого инстанса, куда файлы не уйдут (Э2 часть Б; с Э3 — только без `fedm3` у сервера или с `fedNoFiles` в сводке):
  // при пересылке файлов — их имена в предупреждении.
  const fedNoFiles = useMemo(
    () => (hasFiles ? dms.filter((d) => pickedSet.has(d.id) && !d.group && !d.saved && !!d.otherUser.homeInstance && (!fedFiles || !!summaries[d.id]?.fedNoFiles)).map((d) => dmPeerLabel(d, nameOf)) : []),
    [hasFiles, dms, pickedSet, nameOf, fedFiles, summaries],
  );
  // Имя — по началу любого слова, «@логин» (и логин без «@») — по началу логина, как в «Найти беседу» списка ЛС (05.10).
  const shown = useMemo(
    () => {
      // Бывшая группа (08.10, `groups3`) и архив разорванной связки с инстансом (Э2 часть Б) — только на чтение: переслать в них нельзя.
      const open = dms.filter((d) => !summaries[d.id]?.former && (summaries[d.id] as { fedLink?: string } | undefined)?.fedLink !== 'broken' && !(pickOne && !pickOne.keepCurrent && d.id === currentDmId));
      // Подпись контакта и имя — оба (Telegram `data_peer.cpp` кладёт в индекс и то и другое, `peerName.ts`).
      return q
        ? open.filter(
            (d) => matchDmName(dmPeerLabel(d, nameOf), q) || matchDmName(d.otherUser.displayName, q) || matchDmUsername(d.otherUser.username, q),
          )
        : open;
    },
    [dms, summaries, q, pickOne, currentDmId, nameOf],
  );
  // Каналы серверов (режим «поделиться»): поиск — по имени канала и сервера, как у беседы по началу слов.
  const shownCh = useMemo(
    () => (share?.channels ?? []).filter((c) => !q || matchDmName(c.name, q) || matchDmName(c.serverName, q)),
    [share, q],
  );
  // Esc в поле сперва чистит запрос, и только пустое поле отдаёт Esc окну. Окно ПК (`useDialogChrome`) не закрывается по
  // Esc, которого коснулся `preventDefault`; лист телефона (`BottomSheet`) ловит Esc на window и `defaultPrevented` не
  // читает — ему событие не отдаём вовсе.
  const clearOnEscape = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape' || !query) return;
    e.preventDefault();
    e.stopPropagation();
    setQuery('');
  };

  // «1 сообщение · выберите беседы», «5 сообщений · выберите беседы».
  // С черновиком пересылки (`onDraft`) нажатие выбирает одну беседу — подпись подсказывает, как отметить несколько.
  const pickHint = !draftMode ? 'выберите беседы' : phone ? 'несколько — удержанием' : 'несколько — правой кнопкой';
  const what = pickOne?.what ?? (share ? `${share.head} · ${pickHint}` : `${count} ${plural(count, 'сообщение', 'сообщения', 'сообщений')} · ${pickHint}`);
  const pickOneRef = useRef(pickOne);
  pickOneRef.current = pickOne;
  const pickSingle = useCallback((id: string) => {
    if (sent.current) return;
    sent.current = true;
    try {
      pickOneRef.current?.onPick(id);
    } finally {
      onCloseRef.current();
    }
  }, []);
  const n = picked.length;
  overlayOpen.current = !!menu || later;
  const openMenu = (x: number, y: number) => {
    if (!canSilent && !canLater) return;
    setMenu({ x, y });
  };

  // Сетка телефона (`ShareAlert`): нажатие ячейки переключает галочку (Telegram `ShareAlert` — выбор нескольких тапом); «одной
  // беседой» остаются выбор одного адресата (`pickOne`) и режим «поделиться» (`share`: нажатие — одна беседа, принятое ложится в
  // её поле, удержание — несколько).
  const gridSelecting = !pickOne && (!share || n > 0);
  const gridOpen = pickOne ? pickSingle : share ? choose : toggle;

  // Поле и список — в ОДНОЙ обёртке, как в макете (`FwdPick`): окно и лист кладут между своими детьми зазор (12 / 4 px), а
  // в макете список стоит вплотную к полю, и между ними остаётся только отступ самого `.sheet-search`. `.fwd-pick` —
  // сжимаемая колонка (порция 5, блок «Раунд 12» в `styles.css`): в низком окне список прокручивается внутри него.
  const picker = (
    <div className={phone ? 'fwd-pick fwd-pick-grid' : 'fwd-pick'}>
      <input
        ref={inputRef}
        className="sheet-search"
        placeholder="Найти беседу"
        aria-label="Найти беседу"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={clearOnEscape}
      />
      {dms.length === 0 && shownCh.length === 0 ? (
        <div className="sheet-empty">Бесед пока нет</div>
      ) : shown.length === 0 && shownCh.length === 0 ? (
        <div className="sheet-empty">По запросу «{q}» бесед нет</div>
      ) : (
        phone ? (
          // Телефон — сетка 4 в ряд, как `ShareAlert` Telegram (`ForwardCell`); заголовков «Беседы / Каналы» в ней нет, как и там.
          <div className="fwd-grid">
            {shown.map((d) => (
              <ForwardCell
                key={d.id}
                id={d.id}
                label={dmPeerLabel(d, nameOf)}
                avatar={<ForwardAva saved={d.saved} name={dmPeerLabel(d, nameOf)} url={d.otherUser.avatarUrl} />}
                online={onlineSet.has(d.otherUser.id)}
                picked={pickedSet.has(d.id)}
                selecting={gridSelecting}
                holdable={!!share}
                onOpen={gridOpen}
                onPick={toggle}
              />
            ))}
            {shownCh.map((c) => (
              <ForwardCell
                key={c.id}
                id={c.id}
                label={`# ${c.name}`}
                avatar={<ForwardAva name={c.serverName} url={c.serverIconUrl} />}
                picked={pickedSet.has(c.id)}
                selecting={gridSelecting}
                holdable
                onOpen={gridOpen}
                onPick={toggle}
              />
            ))}
          </div>
        ) : (
        <div className="dm-list fwd-list">
          {shown.length > 0 && shownCh.length > 0 && <div className="mp-head">Беседы</div>}
          {shown.map((d) => {
            const unread = unreadSet.has(d.id) && d.id !== currentDmId;
            return (
              <DmRow
                key={d.id}
                dm={d}
                summary={summaries[d.id]}
                meId={meId}
                online={onlineSet.has(d.otherUser.id)}
                active={false}
                unread={unread}
                unreadN={unread ? (d.unread ?? 0) : 0}
                draft={drafts[d.id]?.text}
                failed={!!outbox[d.id]?.some((x) => x.status === 'failed')}
                query={q}
                // Аватар 40 и точка 12 и на телефоне (макет `FwdPick`, строка 56 px): `phone` у строки — это 48 / 14 для
                // списка бесед на всю ширину экрана, в листе выбора их нет.
                phone={false}
                showTyping={false}
                // Режим выбора: нажатие ставит и снимает галочку (`onPick`), а не открывает беседу. С черновиком пересылки
                // (`onDraft`) он включается первой отметкой — правым щелчком или удержанием; до неё нажатие — «одна беседа».
                selecting={!pickOne && (!draftMode || n > 0)}
                picked={pickedSet.has(d.id)}
                onPick={pickOne ? pickSingle : toggle}
                onOpen={pickOne ? pickSingle : draftMode ? choose : toggle}
                onMenu={draftMode ? pickByMenu : undefined}
              />
            );
          })}
          {shownCh.length > 0 && (
            <>
              {shown.length > 0 && <div className="mp-head">Каналы</div>}
              {shownCh.map((c) => (
                <ShareChannelRow key={c.id} ch={c} selecting={n > 0} picked={pickedSet.has(c.id)} onOpen={choose} onPick={toggle} />
              ))}
            </>
          )}
        </div>
        )
      )}
      {n > 0 && (
        <div className="fwd-foot">
          {fedNoFiles.length > 0 && (
            <div className="fwd-warn" role="note">
              Файлы людям других инстансов пока не пересылаются — в {fedNoFiles.length === 1 ? 'беседу' : 'беседы'}{' '}
              {fedNoFiles.join(', ')} такие сообщения не уйдут.
            </div>
          )}
          <input
            className="sheet-search fwd-comment"
            placeholder="Комментарий"
            aria-label="Комментарий"
            value={comment}
            maxLength={4096}
            onChange={(e) => setComment(e.target.value)}
          />
          {canHide && (
            <label className="confirm-option fwd-opt">
              <input type="checkbox" checked={hideSender} onChange={(e) => setHideSender(e.target.checked)} />
              <span>Скрыть имя отправителя</span>
            </label>
          )}
          {canHide && hasCaptions && (
            <label className="confirm-option fwd-opt">
              <input type="checkbox" checked={hideCaptions} onChange={(e) => setHideCaptions(e.target.checked)} />
              <span>Скрыть подписи</span>
            </label>
          )}
          <div className="fwd-send-row">
            <button
              type="button"
              className={phone ? 'fwd-send round' : 'fwd-send'}
              aria-label={phone ? `Отправить (${n})` : undefined}
              onClick={() => send({ silent: false, at: null })}
              onContextMenu={(e) => {
                if (!canSilent && !canLater) return;
                e.preventDefault();
                openMenu(e.clientX, e.clientY);
              }}
            >
              {phone ? (
                <>
                  <Icon name="send" size={22} />
                  <span className="fwd-send-n">{n}</span>
                </>
              ) : (
                `Отправить (${n})`
              )}
            </button>
            {(canSilent || canLater) && (
              <button
                type="button"
                className="fwd-more"
                aria-label="Ещё: без звука, позже"
                title="Ещё: без звука, позже"
                aria-haspopup="menu"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  // Над кнопкой, правым краем к её правому краю (меню — на 2 пункта, ~100 px).
                  openMenu(Math.max(8, r.right - 232), Math.max(8, r.top - 104));
                }}
              >
                <Icon name="more" size={20} />
              </button>
            )}
          </div>
        </div>
      )}
      {menu && (
        <ContextMenu pos={menu} onClose={() => setMenu(null)} width={232}>
          {canSilent && (
            <MenuItem
              icon="bell-off"
              label="Отправить без звука"
              onClick={() => {
                setMenu(null);
                send({ silent: true, at: null });
              }}
            />
          )}
          {canLater && (
            <MenuItem
              icon="calendar-time"
              label="Отправить позже"
              onClick={() => {
                setMenu(null);
                setLater(true);
              }}
            />
          )}
        </ContextMenu>
      )}
      {later &&
        /* Окно времени — порталом в `body`: окно «Переслать» уже модальное, второе внутри него легло бы под его рамку. */
        createPortal(
          <SchedPick
            text={comment.trim() || `${count} ${plural(count, 'сообщение', 'сообщения', 'сообщений')}`}
            onPick={(at, silent) => send({ silent: !!silent, at })}
            onClose={() => setLater(false)}
            silentToggle={canSilent}
          />,
          document.body,
        )}
    </div>
  );

  return phone ? (
    <BottomSheet title={pickOne?.title ?? share?.title ?? 'Переслать в…'} subtitle={what} onClose={close}>
      {picker}
    </BottomSheet>
  ) : (
    <ForwardDialog title={pickOne?.title ?? share?.title} what={what} inputRef={inputRef} onClose={close}>
      {picker}
    </ForwardDialog>
  );
}
