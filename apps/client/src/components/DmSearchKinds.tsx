/**
 * Вкладки поиска на ТЕЛЕФОНЕ (12.10, #218; с пустым полем тоже): «Чаты / Медиа / Ссылки / Файлы / GIF / Голосовые» — как у Telegram Android
 * (`Components/SearchViewPager.java` — полоса вкладок, `ui/FilteredSearchView.java` — найденные вложения одного вида по запросу, без запроса — свежие из всех бесед:
 * сетка медиа по месяцам, строки файлов / ссылок / голосовых «размер · откуда», пусто — «Ничего не найдено»). Правила — в
 * `dmListSearchRules.ts` (`PHONE_SEARCH_TABS`, `phoneSearchTabsShown`); строки и плитки — те же, что у «Общих медиа»
 * (`SharedMedia.tsx`). Сервер: `GET /conv/search` с `kind` + `full=1` (целые сообщения) + `names=1` (имена вложений). Старый
 * сервер целых сообщений не шлёт — тогда строки найденного, как у чипа типа (`DmHitRow`).
 */
import type { ConvMessage, ConvSearchAllHit, DmChannel, SharedMediaKind } from '@gusvoice/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { MESSAGE_SEARCH_DELAY_MS, MESSAGE_SEARCH_PAGE, PHONE_SEARCH_TABS, phoneSearchTabLabel, type PhoneSearchTab, type SearchChips } from '../dmListSearchRules';
import { dmPeerLabel, usePeerName } from '../peerName';
import { groupByMonth, sharedItems, type SharedItem } from '../sharedMediaRules';
import { toastError } from '../toast';
import { DmHitRow } from './DmListSearch';
import { Lightbox, type LightboxAction, type LightboxImage } from './Lightbox';
import { FileRow, LinkRow, MediaTile, showInChat, VoiceRow } from './SharedMedia';

/** Полоса вкладок под полем (вид — как «Все / Личные / Серверы», но листается вбок: вкладок шесть). Мышь не уводит фокус из поля. */
export function DmSearchTabs({ tab, onTab }: { tab: PhoneSearchTab; onTab: (t: PhoneSearchTab) => void }) {
  return (
    <div className="dms-scopes dms-kinds" role="tablist" aria-label="Что искать" onMouseDown={(e) => e.preventDefault()}>
      {PHONE_SEARCH_TABS.map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={t === tab}
          data-tab={t}
          className={t === tab ? 'dms-scope on' : 'dms-scope'}
          onClick={() => onTab(t)}
        >
          {phoneSearchTabLabel(t)}
        </button>
      ))}
    </div>
  );
}

interface KindState {
  status: 'loading' | 'done' | 'error';
  hits: ConvSearchAllHit[];
  next: string | null;
  more: boolean;
}

const LOADING: KindState = { status: 'loading', hits: [], next: null, more: false };

/**
 * Найденные вложения вида `kind` по запросу во всех моих беседах (Telegram `FilteredSearchView`). `onLeave` — перед переходом в
 * беседу (убрать курсор из поля, запомнить запрос в «Недавних»). Следующая порция — когда низ списка доходит до экрана.
 */
export function DmKindHits({
  q,
  chips,
  kind,
  dms,
  meId,
  onLeave,
}: {
  q: string;
  chips: SearchChips;
  kind: SharedMediaKind;
  dms: readonly DmChannel[];
  meId: string | undefined;
  onLeave: (hit: { conversationId: string }) => void;
}) {
  const [st, setSt] = useState<KindState>(LOADING);
  const [viewer, setViewer] = useState<number | null>(null);
  const seq = useRef(0);
  const tailRef = useRef<HTMLDivElement>(null);
  const text = q.trim();
  const person = chips.person?.convId;
  const since = chips.date?.since;
  const until = chips.date?.until;
  const byId = useMemo(() => new Map(dms.map((d) => [d.id, d])), [dms]);
  const nameOf = usePeerName();

  useEffect(() => {
    const mine = ++seq.current;
    setSt(LOADING);
    setViewer(null);
    const t = window.setTimeout(() => {
      api
        .convSearchAll({ q: text, conversationId: person, since, until, kind, limit: MESSAGE_SEARCH_PAGE, full: true })
        .then((r) => {
          if (seq.current === mine) setSt({ status: 'done', hits: r.hits, next: r.next, more: false });
        })
        .catch(() => {
          if (seq.current === mine) setSt({ status: 'error', hits: [], next: null, more: false });
        });
    }, text ? MESSAGE_SEARCH_DELAY_MS : 0); // пустое поле (вкладка открыта без запроса) — без задержки набора
    return () => window.clearTimeout(t);
  }, [text, person, since, until, kind]);

  const loadMore = () => {
    if (!st.next || st.more || st.status !== 'done') return;
    const mine = seq.current;
    const before = st.next;
    setSt((s) => ({ ...s, more: true }));
    api
      .convSearchAll({ q: text, conversationId: person, since, until, kind, before, limit: MESSAGE_SEARCH_PAGE, full: true })
      .then((r) => {
        if (seq.current !== mine) return;
        setSt((s) => {
          const seen = new Set(s.hits.map((h) => h.id));
          return { status: 'done', hits: [...s.hits, ...r.hits.filter((h) => !seen.has(h.id))], next: r.next, more: false };
        });
      })
      .catch((e) => {
        if (seq.current === mine) setSt((s) => ({ ...s, more: false, next: null }));
        toastError(e, 'Не удалось загрузить ещё');
      });
  };
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;

  // Низ выдачи дошёл до экрана — следующая порция (Telegram листает без кнопки «Показать ещё»).
  useEffect(() => {
    const el = tailRef.current;
    if (!el || !st.next || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) loadMoreRef.current();
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [st.next, st.hits.length]);

  const rows = useMemo(() => st.hits.filter((h) => byId.has(h.conversationId)), [st.hits, byId]);
  // Старый сервер (без `full`): целых сообщений нет — строки найденного с подписью вида.
  const legacy = rows.length > 0 && rows.every((h) => !h.message);
  const messages = useMemo(() => rows.map((h) => h.message).filter((m): m is ConvMessage => !!m), [rows]);
  const items = useMemo(() => sharedItems(messages, kind), [messages, kind]);
  const sourceOf = (it: SharedItem): string | undefined => {
    const dm = byId.get(it.msg.conversationId);
    return dm ? dmPeerLabel(dm, nameOf) : undefined;
  };
  const leave = (it: SharedItem) => () => onLeave({ conversationId: it.msg.conversationId });

  // Просмотрщик: найденные фото и видео от старых к новым (как у «Общих медиа»), «Показать в чате» — переход к сообщению.
  // Э3 (#141): нескачанные (`copying`) в ряд просмотра не входят — плитка скажет об этом тостом.
  const media = useMemo(() => (kind === 'media' ? [...items].reverse().filter((x) => x.att!.fedState !== 'copying') : []), [items, kind]);
  const images: LightboxImage[] = useMemo(
    () =>
      media.map((x) => ({
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
    [media, nameOf],
  );
  // Пришла порция старше — просмотрщик держит то же фото: индекс сдвигается на пришедшее слева.
  const prevLen = useRef(images.length);
  useEffect(() => {
    const added = images.length - prevLen.current;
    prevLen.current = images.length;
    if (added > 0) setViewer((v) => (v === null ? v : v + added));
  }, [images.length]);
  const viewerActions = (_img: LightboxImage, i: number): LightboxAction[] => {
    const x = media[i];
    if (!x) return [];
    return [{ id: 'goto', icon: 'eye', label: 'Показать в чате', run: () => showInChat(x.msg.conversationId, x.msg.id, leave(x)) }];
  };

  const label = phoneSearchTabLabel(kind);
  return (
    <section className="dms-hits dms-kind-hits" aria-label={label} data-testid="kind-search-hits" data-kind={kind}>
      {legacy
        ? rows.map((h) => {
            const dm = byId.get(h.conversationId);
            return dm ? (
              <DmHitRow key={h.id} h={h} dm={dm} text={text} kind={kind} meId={meId} onOpen={(x) => showInChat(x.conversationId, x.id, () => onLeave(x))} />
            ) : null;
          })
        : groupByMonth(items).map((g) => (
            <section key={g.key} className="smedia-month">
              <div className="smedia-month-head">{g.label}</div>
              {kind === 'media' || kind === 'gif' ? (
                <div className="smedia-grid">
                  {g.items.map((it) => (
                    <MediaTile
                      key={it.key}
                      it={it}
                      gif={kind === 'gif'}
                      onOpen={() => {
                        if (kind === 'gif') {
                          showInChat(it.msg.conversationId, it.msg.id, leave(it));
                          return;
                        }
                        const i = media.findIndex((x) => x.key === it.key);
                        if (i >= 0) setViewer(i);
                      }}
                    />
                  ))}
                </div>
              ) : (
                g.items.map((it) =>
                  kind === 'file' ? (
                    <FileRow key={it.key} it={it} convId={it.msg.conversationId} onLeave={leave(it)} source={sourceOf(it)} />
                  ) : kind === 'link' ? (
                    <LinkRow key={it.key} it={it} convId={it.msg.conversationId} onLeave={leave(it)} source={sourceOf(it)} />
                  ) : (
                    <VoiceRow key={it.key} it={it} convId={it.msg.conversationId} onLeave={leave(it)} source={sourceOf(it)} />
                  ),
                )
              )}
            </section>
          ))}
      {st.status === 'loading' && <div className="dm-empty dm-nores">Ищем…</div>}
      {st.status === 'error' && <div className="dm-empty dm-nores">Не удалось поискать</div>}
      {st.status === 'done' && (legacy ? rows.length === 0 : items.length === 0) && !st.next && <div className="dm-empty dm-nores">Ничего не найдено</div>}
      {st.next && (
        <div ref={tailRef} className="smedia-more muted">
          {st.more ? 'Загрузка…' : ''}
        </div>
      )}
      {viewer !== null && images[viewer] && (
        <Lightbox
          images={images}
          index={viewer}
          onClose={() => setViewer(null)}
          onIndex={setViewer}
          onNearEdge={(dir) => {
            if (dir === -1) loadMoreRef.current();
          }}
          actions={viewerActions}
        />
      )}
    </section>
  );
}
