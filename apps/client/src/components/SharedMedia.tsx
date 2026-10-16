/**
 * Общие медиа беседы (08.10, #211, G29, признак сервера `media1`) — как у Telegram: в профиле собеседника или группы
 * строки-счётчики («12 фото и видео», «3 файла»…, tdesktop `info/profile/info_profile_actions.cpp` — кнопки медиа под
 * профилем), по нажатию — окно с вкладками «Медиа / Файлы / Ссылки / GIF / Голосовые» (tweb `appSearchSuper.ts`, Web A
 * `right/Profile.tsx`). Медиа и GIF — сетка 3 колонки по месяцам, файлы — список со значком, размером и
 * датой, ссылки — домен и адрес, голосовые — общий плеер (`VoiceMessage`). Нажатие на фото или видео — наш просмотрщик
 * (`Lightbox`) с листанием по всем медиа беседы; у каждого элемента — «Показать в чате» (`requestFeedJump`, подсветка
 * — механизм перехода ленты). Порции по 50 при прокрутке. Правила — `sharedMediaRules.ts`, вид вложения — `shared/sharedMedia.ts`.
 * ПК — окно поверх, телефон — лист снизу на всю высоту (как остальные окна ЛС, `GroupDialogs.Shell`).
 * Телефонный профиль собеседника (`PhoneProfile.tsx`, #218) — вкладки прямо в профиле: `SharedMediaPanel`.
 */
import { isRoundVideo, type Attachment, type ConvMessage, type SharedMediaCounts, type SharedMediaKind } from '@gusvoice/shared';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { api } from '../api';
import { serverSharedMedia } from '../convSyncRules';
import { useDialogChrome } from '../dialogChrome';
import { requestFeedJump } from '../feedJump';
import { openAttachmentFile, sizeText } from '../fileActions';
import { viewerDate } from '../mediaViewerRules';
import { usePhoneLayout } from '../phoneLayout';
import {
  copyingRefusal,
  fileBadge,
  groupByMonth,
  linkDomain,
  mergeSharedPage,
  SHARED_MEDIA_PRELOAD_PX,
  SHARED_MEDIA_TITLES,
  sharedItems,
  sharedMediaCountLabel,
  visibleSharedTabs,
  viewerMedia,
  type SharedItem,
} from '../sharedMediaRules';
import { usePeerName } from '../peerName';
import { useStore } from '../store';
import { toastError } from '../toast';
import { BottomSheet } from './BottomSheet';
import { Icon, type IconName } from './Icon';
import { Lightbox, type LightboxAction, type LightboxImage } from './Lightbox';
import { SpoilerParticles, useSpoilerHidden } from './SpoilerCover';
import { BLANK_POSTER, videoFrameSrc } from './VideoAttachment';
import { RoundVideo } from './RoundVideo';
import { VoiceMessage } from './VoiceMessage';

// ——— Открытое окно (одно на приложение) ———
type Open = { convId: string; kind: SharedMediaKind; former: boolean } | null;
let open: Open = null;
const subs = new Set<() => void>();
function setOpen(v: Open): void {
  open = v;
  for (const f of subs) f();
}
/** Открыть общие медиа беседы на вкладке `kind`. */
export function openSharedMedia(convId: string, kind: SharedMediaKind, former = false): void {
  setOpen({ convId, kind, former });
}
function closeSharedMedia(): void {
  setOpen(null);
}
/**
 * Esc, подложка, смахивание: пока поверх открыт просмотрщик, окно не закрывается — Esc достаётся просмотрщику (оба слушают
 * `window`, окно подписалось раньше и иначе закрылось бы вместе с ним).
 */
function closeUnlessViewer(): void {
  if (!document.querySelector('.lightbox')) closeSharedMedia();
}
function useOpen(): Open {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => open,
    () => null,
  );
}

/** Сервер умеет общие медиа и включён режим бесед. */
function useSharedMediaOn(): boolean {
  return useStore((s) => s.convActive && serverSharedMedia(s.serverFeatures));
}

/** Счётчики беседы; `null` — ещё не пришли или сервер не умеет. */
function useSharedCounts(convId: string | null, former: boolean): SharedMediaCounts | null {
  const on = useSharedMediaOn();
  const [counts, setCounts] = useState<SharedMediaCounts | null>(null);
  useEffect(() => {
    if (!on || !convId) return;
    let alive = true;
    api.convMediaCounts(convId, former).then(
      (c) => alive && setCounts(c),
      () => alive && setCounts(null),
    );
    return () => {
      alive = false;
    };
  }, [on, convId, former]);
  return on ? counts : null;
}

const ROW_ICON: Record<SharedMediaKind, IconName | null> = { media: 'photo', file: 'file', link: 'link', gif: null, voice: 'mic' };

/**
 * Строки-счётчики в профиле (карточка собеседника, «Информация о группе»): только непустые виды, как у Telegram.
 * `onOpen` — перед открытием окна (карточка профиля закрывается сама).
 */
export function SharedMediaRows({ convId, former = false, onOpen }: { convId: string; former?: boolean; onOpen?: () => void }) {
  const counts = useSharedCounts(convId, former);
  const kinds = visibleSharedTabs(counts, null);
  if (kinds.length === 0) return null;
  return (
    <div className="smedia-rows" role="group" aria-label="Общие медиа">
      {kinds.map((k) => {
        const ico = ROW_ICON[k];
        return (
          <button
            key={k}
            type="button"
            className="smedia-row"
            onClick={() => {
              onOpen?.();
              openSharedMedia(convId, k, former);
            }}
          >
            <span className="smedia-row-ico" aria-hidden="true">
              {ico ? <Icon name={ico} size={18} /> : <span className="smedia-gif-tag">GIF</span>}
            </span>
            <span className="smedia-row-label">{sharedMediaCountLabel(k, counts![k])}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Хост окна — у корня ЛС (рядом с `GroupDialogHost`). */
export function SharedMediaHost() {
  const o = useOpen();
  const on = useSharedMediaOn();
  if (!o || !on) return null;
  return <SharedMediaView key={o.convId} convId={o.convId} initial={o.kind} former={o.former} />;
}

type TabState = { messages: ConvMessage[]; next: string | null; loading: boolean; done: boolean };
const EMPTY_TAB: TabState = { messages: [], next: null, loading: false, done: false };

function Shell({ title, children }: { title: string; children: ReactNode }) {
  const phone = usePhoneLayout();
  const ref = useDialogChrome<HTMLDivElement>(closeUnlessViewer);
  if (phone)
    return (
      <BottomSheet title={title} onClose={closeUnlessViewer}>
        <div className="smedia smedia-phone">{children}</div>
      </BottomSheet>
    );
  return (
    <div className="modal-overlay" onClick={closeUnlessViewer}>
      <div
        className="modal smedia"
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="smedia-head">
          <h2>{title}</h2>
          <button type="button" className="icon-close" aria-label="Закрыть" title="Закрыть" onClick={closeSharedMedia}>
            <Icon name="close" size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * Перейти к сообщению в ленте беседы: окно закрывается, беседа открывается на сообщении с подсветкой. `onLeave` — экран,
 * в который медиа встроены (телефонный профиль, `PhoneProfile.tsx`), закрывается тоже.
 */
export function showInChat(convId: string, messageId: string, onLeave?: () => void): void {
  closeSharedMedia();
  onLeave?.();
  requestFeedJump(convId, messageId);
  void useStore.getState().selectDm(convId);
}

function SharedMediaView({ convId, initial, former }: { convId: string; initial: SharedMediaKind; former: boolean }) {
  const counts = useSharedCounts(convId, former);
  return (
    <Shell title="Общие медиа">
      <SharedMediaBody convId={convId} initial={initial} former={former} counts={counts} />
    </Shell>
  );
}

/**
 * Общие медиа прямо в профиле (телефон, #218) — как `SharedMediaLayout` под шапкой `ProfileActivity` Telegram Android: вкладки
 * только непустых видов, первая открыта, сетка от края до края. Листает не свой список, а экран профиля (`scroller`):
 * вкладки прилипают под его шапкой (CSS `.tgp .smedia-embed`). Пусто во всех видах — блока нет, как у Telegram.
 */
export function SharedMediaPanel({ convId, scroller, onLeave }: { convId: string; scroller: HTMLElement | null; onLeave?: () => void }) {
  const counts = useSharedCounts(convId, false);
  const kinds = visibleSharedTabs(counts, null);
  if (kinds.length === 0) return null;
  return (
    <div className="smedia smedia-embed">
      <SharedMediaBody convId={convId} initial={kinds[0]!} former={false} counts={counts} scroller={scroller} onLeave={onLeave} />
    </div>
  );
}

function SharedMediaBody({
  convId,
  initial,
  former,
  counts,
  scroller = null,
  onLeave,
}: {
  convId: string;
  initial: SharedMediaKind;
  former: boolean;
  counts: SharedMediaCounts | null;
  /** Встроено в чужой экран: прокрутку и подгрузку ведёт он (`SharedMediaPanel`); нет — свой список. */
  scroller?: HTMLElement | null;
  onLeave?: () => void;
}) {
  const embedded = scroller !== null;
  const [tab, setTab] = useState<SharedMediaKind>(initial);
  const [tabs, setTabs] = useState<Partial<Record<SharedMediaKind, TabState>>>({});
  const [viewer, setViewer] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Место вкладок в общем списке экрана (встроенный вид): к нему возвращает смена вкладки.
  const anchorRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const busy = useRef(new Set<SharedMediaKind>());
  const kinds = visibleSharedTabs(counts, tab);
  const cur = tabs[tab] ?? EMPTY_TAB;

  const load = useCallback(
    async (kind: SharedMediaKind) => {
      if (busy.current.has(kind)) return;
      const st = tabs[kind] ?? EMPTY_TAB;
      if (st.done) return;
      busy.current.add(kind);
      setTabs((t) => ({ ...t, [kind]: { ...(t[kind] ?? EMPTY_TAB), loading: true } }));
      try {
        const page = await api.convMedia(convId, kind, st.next, former);
        setTabs((t) => {
          const prev = t[kind] ?? EMPTY_TAB;
          return { ...t, [kind]: { messages: mergeSharedPage(prev.messages, page.messages), next: page.next, loading: false, done: !page.next } };
        });
      } catch (e) {
        toastError(e);
        setTabs((t) => ({ ...t, [kind]: { ...(t[kind] ?? EMPTY_TAB), loading: false, done: true } }));
      } finally {
        busy.current.delete(kind);
      }
    },
    [convId, former, tabs],
  );

  // Первая порция открытой вкладки.
  useEffect(() => {
    if (!tabs[tab]) void load(tab);
  }, [tab, tabs, load]);

  // Подгрузка при прокрутке и, пока список ниже окна, — сразу следующая порция.
  const onScroll = () => {
    const el = scroller ?? listRef.current;
    if (!el || cur.loading || cur.done) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < SHARED_MEDIA_PRELOAD_PX) void load(tab);
  };
  useEffect(() => {
    if (!scroller) return;
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  });
  useEffect(() => {
    const el = scroller ?? listRef.current;
    if (el && !cur.loading && !cur.done && cur.messages.length > 0 && el.scrollHeight <= el.clientHeight + SHARED_MEDIA_PRELOAD_PX)
      void load(tab);
  }, [cur, tab, load, scroller]);
  /** Новая вкладка — с её начала: свой список наверх; встроенный — экран к месту вкладок, если ушёл ниже. */
  const toTop = () => {
    if (!scroller) {
      listRef.current?.scrollTo({ top: 0 });
      return;
    }
    const a = anchorRef.current;
    const stick = tabsRef.current ? parseFloat(getComputedStyle(tabsRef.current).top) || 0 : 0;
    if (a && scroller.scrollTop > a.offsetTop - stick) scroller.scrollTo({ top: a.offsetTop - stick });
  };

  const items = useMemo(() => sharedItems(cur.messages, tab), [cur.messages, tab]);

  // Просмотрщик: все загруженные медиа беседы, от старых к новым; нескачанные с соседнего инстанса (Э3, `copying`) в ряд не входят.
  const mediaItems = useMemo(() => viewerMedia(sharedItems((tabs.media ?? EMPTY_TAB).messages, 'media')), [tabs.media]);
  const nameOf = usePeerName(); // подпись контакта вместо имени (`peerName.ts`)
  const images: LightboxImage[] = useMemo(
    () =>
      mediaItems.map((x) => ({
        url: x.att!.url,
        name: x.att!.name,
        size: x.att!.size,
        downloadUrl: api.attachmentDownloadUrl(x.att!),
        type: x.att!.contentType,
        video: x.att!.contentType.startsWith('video/'),
        from: nameOf(x.msg.author.id, x.msg.author.displayName),
        at: x.msg.createdAt,
        caption: x.msg.content.trim() || undefined,
      })),
    [mediaItems, nameOf],
  );
  const openViewer = (it: SharedItem) => {
    const i = mediaItems.findIndex((x) => x.key === it.key);
    if (i >= 0) setViewer(i);
  };
  // Дошли до самого старого загруженного — следующая порция; индекс сдвигается на пришедшее слева.
  const prevLen = useRef(images.length);
  useEffect(() => {
    const added = images.length - prevLen.current;
    prevLen.current = images.length;
    if (added > 0 && viewer !== null) setViewer((v) => (v === null ? v : v + added));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images.length]);
  const viewerActions = (_img: LightboxImage, i: number): LightboxAction[] => {
    const x = mediaItems[i];
    if (!x) return [];
    return [{ id: 'goto', icon: 'eye', label: 'Показать в чате', run: () => showInChat(convId, x.msg.id, onLeave) }];
  };

  return (
    <>
      {embedded && <div ref={anchorRef} aria-hidden="true" />}
      <div className="smedia-tabs" role="tablist" aria-label="Вид" ref={tabsRef}>
        {kinds.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={k === tab}
            className={k === tab ? 'smedia-tab on' : 'smedia-tab'}
            onClick={() => {
              setTab(k);
              toTop();
            }}
          >
            {SHARED_MEDIA_TITLES[k]}
            {counts && <span className="smedia-tab-n">{counts[k]}</span>}
          </button>
        ))}
      </div>
      <div className="smedia-list" ref={listRef} onScroll={embedded ? undefined : onScroll} role="tabpanel" aria-label={SHARED_MEDIA_TITLES[tab]}>
        {(tab === 'media' || tab === 'gif') &&
          groupByMonth(items).map((g) => (
            <section key={g.key} className="smedia-month">
              <div className="smedia-month-head">{g.label}</div>
              <div className="smedia-grid">
                {g.items.map((it) => (
                  <MediaTile key={it.key} it={it} gif={tab === 'gif'} onOpen={() => (tab === 'gif' ? showInChat(convId, it.msg.id, onLeave) : openViewer(it))} />
                ))}
              </div>
            </section>
          ))}
        {(tab === 'file' || tab === 'link' || tab === 'voice') &&
          groupByMonth(items).map((g) => (
            <section key={g.key} className="smedia-month">
              <div className="smedia-month-head">{g.label}</div>
              {g.items.map((it) =>
                tab === 'file' ? (
                  <FileRow key={it.key} it={it} convId={convId} onLeave={onLeave} />
                ) : tab === 'link' ? (
                  <LinkRow key={it.key} it={it} convId={convId} onLeave={onLeave} />
                ) : (
                  <VoiceRow key={it.key} it={it} convId={convId} onLeave={onLeave} />
                ),
              )}
            </section>
          ))}
        {cur.loading && <div className="smedia-more muted">Загрузка…</div>}
        {!cur.loading && cur.done && items.length === 0 && <div className="smedia-empty muted">Здесь пока пусто</div>}
      </div>
      {viewer !== null && images[viewer] && (
        <Lightbox
          images={images}
          index={viewer}
          onClose={() => setViewer(null)}
          onIndex={setViewer}
          onNearEdge={(dir) => {
            if (dir === -1) void load('media');
          }}
          actions={viewerActions}
        />
      )}
    </>
  );
}

export function MediaTile({ it, gif, onOpen }: { it: SharedItem; gif: boolean; onOpen: () => void }) {
  const a = it.att!;
  const video = a.contentType.startsWith('video/');
  // Спойлер (G48, `media2`): плитка общих медиа размыта, пока смотрящий не снял его в ленте.
  const hidden = useSpoilerHidden(a);
  // Э3 (#141, `fedm3`): копия файла с инстанса автора ещё едет — к файлу не обращаемся (503), та же заглушка, что в ленте
  // (`AttachmentView.CopyingAttachment`): затенённая плитка с крутилкой; нажатие — «Файл ещё загружается…», а не просмотр.
  if (a.fedState === 'copying') {
    return (
      <button
        type="button"
        className="smedia-tile att-copying"
        onClick={() => toastError(copyingRefusal())}
        aria-busy="true"
        aria-label={`${gif ? 'GIF' : video ? 'Видео' : 'Фото'}: загружается`}
        title={a.name}
      >
        <span className="confirm-spin att-spin big" aria-hidden="true" />
      </button>
    );
  }
  return (
    <button type="button" className={`smedia-tile${hidden ? ' spoiled' : ''}`} onClick={onOpen} aria-label={gif ? 'GIF — показать в чате' : video ? 'Видео' : 'Фото'}>
      {video ? (
        <video src={gif ? a.url : videoFrameSrc(a.url)} poster={BLANK_POSTER} muted playsInline preload="metadata" autoPlay={gif} loop={gif} />
      ) : (
        <img src={a.url} alt="" loading="lazy" draggable={false} />
      )}
      {hidden && <SpoilerParticles />}
      {video && !gif && !hidden && (
        <span className="smedia-tile-badge" aria-hidden="true">
          <Icon name="play" size={12} />
        </span>
      )}
    </button>
  );
}

/** «Показать в чате» — кнопка справа у строки (Telegram: пункт меню элемента; у нас — видимая кнопка, без меню). */
function GotoBtn({ convId, id, onLeave }: { convId: string; id: string; onLeave?: () => void }) {
  return (
    <button type="button" className="icon-close smedia-goto" title="Показать в чате" aria-label="Показать в чате" onClick={() => showInChat(convId, id, onLeave)}>
      <Icon name="eye" size={16} />
    </button>
  );
}

/**
 * Строки файлов / ссылок / голосовых. `source` — откуда сообщение (вкладки поиска на телефоне, 12.10): у Telegram в общем поиске
 * строка файла — «размер · откуда» (`SharedDocumentCell` `VIEW_TYPE_GLOBAL_SEARCH` → `FilteredSearchView.createFromInfoString`).
 */
export function FileRow({ it, convId, onLeave, source }: { it: SharedItem; convId: string; onLeave?: () => void; source?: string }) {
  const a = it.att!;
  // Э3 (#141): копия ещё едет — в подписи «загружается» (как у карточки в ленте); нажатие скажет об этом тостом (`fileActions.run`).
  const copying = a.fedState === 'copying';
  return (
    <div className="smedia-item">
      <button type="button" className="smedia-item-main" onClick={() => openAttachmentFile(a)} title={a.name}>
        <span className="smedia-file-ico" aria-hidden="true">
          {fileBadge(a.name)}
        </span>
        <span className="smedia-item-text">
          <span className="smedia-item-title">{a.name}</span>
          <span className="smedia-item-sub">
            {sizeText(a.size)} · {copying ? 'загружается · ' : ''}
            {source ? `${source} · ` : ''}
            {viewerDate(it.msg.createdAt)}
          </span>
        </span>
      </button>
      <GotoBtn convId={convId} id={it.msg.id} onLeave={onLeave} />
    </div>
  );
}

export function LinkRow({ it, convId, onLeave, source }: { it: SharedItem; convId: string; onLeave?: () => void; source?: string }) {
  const url = it.url!;
  const domain = linkDomain(url);
  // Строка — сообщение (как у Telegram: счётчик ссылок — по сообщениям): заголовок — домен первой, ниже все ссылки.
  return (
    <div className="smedia-item">
      <div className="smedia-item-main">
        <span className="smedia-link-ico" aria-hidden="true">
          {domain.charAt(0).toUpperCase()}
        </span>
        <span className="smedia-item-text">
          <span className="smedia-item-title">{domain}</span>
          {(it.urls ?? [url]).map((u) => (
            <a key={u} className="smedia-item-sub smedia-link-url" href={u} target="_blank" rel="noopener noreferrer">
              {u}
            </a>
          ))}
          {source && (
            <span className="smedia-item-sub">
              {source} · {viewerDate(it.msg.createdAt)}
            </span>
          )}
        </span>
      </div>
      <GotoBtn convId={convId} id={it.msg.id} onLeave={onLeave} />
    </div>
  );
}

/**
 * Э3 (#141): голосовое или кружок, чья копия с инстанса автора ещё едет, — те же заглушки, что в ленте (`AttachmentView.CopyingAttachment`):
 * без плеера и без запроса к файлу (он ответил бы 503).
 */
function CopyingVoice({ a }: { a: Attachment }) {
  if (isRoundVideo(a)) {
    return (
      <div className="round-msg" aria-busy="true" aria-label="Видеосообщение загружается">
        <div className="round-msg-btn att-copying">
          <span className="confirm-spin att-spin big" aria-hidden="true" />
        </div>
      </div>
    );
  }
  const bars = a.waveform?.length ? a.waveform : Array.from({ length: 40 }, () => 20);
  return (
    <div className="voice-msg voice-copying" aria-busy="true" aria-label="Голосовое сообщение загружается">
      <span className="voice-play" aria-disabled="true">
        <span className="confirm-spin att-spin" aria-hidden="true" />
      </span>
      <div className="voice-wave" role="presentation">
        {bars.map((v, i) => (
          <span key={i} className="voice-bar" style={{ height: `${Math.max(8, v)}%` }} />
        ))}
      </div>
      <span className="voice-copying-note">загружается</span>
    </div>
  );
}

export function VoiceRow({ it, convId, onLeave, source }: { it: SharedItem; convId: string; onLeave?: () => void; source?: string }) {
  const m = it.msg;
  const me = useStore((s) => s.user?.id);
  const author = usePeerName()(m.author.id, m.author.displayName); // подпись контакта (`peerName.ts`)
  const meta = {
    conversationId: convId,
    messageId: m.id,
    mine: m.author.id === me,
    listened: m.voiceListened,
    author,
    createdAt: m.createdAt,
  };
  return (
    <div className="smedia-item smedia-voice">
      <div className="smedia-item-text">
        <span className="smedia-voice-head">
          <span className="smedia-item-title">{author}</span>
          <span className="smedia-item-sub">{source && source !== author ? `${source} · ${viewerDate(m.createdAt)}` : viewerDate(m.createdAt)}</span>
        </span>
        {/* Кружок (`circles1`) с 0125 живёт во вкладке «Голосовые», как Telegram `RoundVoice`: тот же круг, что в ленте, меньше
            (`.smedia-voice .round-msg`), без беззвучного автоповтора — играет по нажатию. */}
        {it.att!.fedState === 'copying' ? <CopyingVoice a={it.att!} /> : isRoundVideo(it.att!) ? <RoundVideo a={it.att!} meta={meta} autoplay={false} /> : <VoiceMessage a={it.att!} meta={meta} />}
      </div>
      <GotoBtn convId={convId} id={m.id} onLeave={onLeave} />
    </div>
  );
}
