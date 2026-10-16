/**
 * Поиск из списка бесед ЛС (G35 темы 14 плейбука, #211, волна 5; признак сервера `gsearch1`). Правила — `dmListSearchRules.ts`
 * (источники Telegram там же), серверная ручка — `GET /api/conv/search` (`api.convSearchAll`).
 *
 * Три куска, которые `DmSidebar` ставит на свои места:
 * - `DmSearchHome` — поле в фокусе и пустое: «Недавние» (запросы и люди, на устройстве, с очисткой) и «Люди» (полоса аватаров);
 * - `DmSearchChips` — под полем: выбранные чипы «человек» / «дата» / «тип» и подсказки из набранного (Android `FiltersView`);
 * - `DmMessageHits` — под найденными беседами: «Сообщения» (по тексту во всех беседах, с чипами), порциями, переход к месту.
 */
import type { ConvFrequentItem, ConvSearchAllHit, DmChannel } from '@gusvoice/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { DM_ROW_HOLD_MS, DM_ROW_HOLD_SLOP } from '../dmListRules';
import { dmRowTime } from '../dmRowRules';
import {
  frequentStrip,
  FREQUENT_HIDDEN_KEY,
  type FrequentHidden,
  hasChips,
  hideFrequent,
  parseFrequentHidden,
  hitKindLabel,
  hitSnippet,
  KIND_CHIPS,
  MESSAGE_SEARCH_DELAY_MS,
  MESSAGE_SEARCH_PAGE,
  messageQuery,
  parseDateQuery,
  parseRecent,
  peopleStrip,
  personSuggestions,
  pushRecent,
  RECENT_STORAGE_KEY,
  removeRecent,
  type KindChip,
  type PersonChip,
  type RecentSearch,
  type SearchChips,
} from '../dmListSearchRules';
import { requestFeedJump } from '../feedJump';
import { SHARED_MEDIA_TITLES } from '../sharedMediaRules';
import { dmPeerLabel, usePeerName } from '../peerName';
import { useStore } from '../store';
import { toastError } from '../toast';
import { Avatar } from './Avatar';
import { ContextMenu, MenuItem, type MenuPos } from './ContextMenu';
import { Icon, type IconName } from './Icon';

/** «Недавние» на устройстве: чтение и запись в `localStorage`, ошибки хранилища глотаем (приватный режим). */
export function useRecentSearches(): {
  recents: RecentSearch[];
  push: (e: RecentSearch) => void;
  remove: (e: RecentSearch) => void;
  clear: () => void;
} {
  const [recents, setRecents] = useState<RecentSearch[]>(() => {
    try {
      return parseRecent(localStorage.getItem(RECENT_STORAGE_KEY));
    } catch {
      return [];
    }
  });
  const save = useCallback((next: RecentSearch[]) => {
    setRecents(next);
    try {
      if (next.length === 0) localStorage.removeItem(RECENT_STORAGE_KEY);
      else localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* хранилище недоступно — живёт до перезагрузки */
    }
  }, []);
  // Несколько записей подряд за один обработчик (запрос и человек) не затирают друг друга: считаем от последнего сохранённого.
  const last = useRef(recents);
  last.current = recents;
  const apply = useCallback(
    (f: (l: RecentSearch[]) => RecentSearch[]) => {
      const next = f(last.current);
      last.current = next;
      save(next);
    },
    [save],
  );
  const push = useCallback((e: RecentSearch) => apply((l) => pushRecent(l, e)), [apply]);
  const remove = useCallback((e: RecentSearch) => apply((l) => removeRecent(l, e)), [apply]);
  const clear = useCallback(() => save([]), [save]);
  return { recents, push, remove, clear };
}

/** Убранные на устройстве (`localStorage`, ошибки хранилища глотаем). */
function readFrequentHidden(): FrequentHidden {
  try {
    return parseFrequentHidden(localStorage.getItem(FREQUENT_HIDDEN_KEY));
  } catch {
    return {};
  }
}

/** Разовый перенос убранных на устройстве на сервер (`freq2`) — один на вкладку, повтор после сбоя — при следующем входе. */
let frequentMoving = false;

/**
 * Убранные из «Частых»: id беседы → когда убрана. Без `server` (`freq1`) — на устройстве (`localStorage`). С `server` (09.10,
 * `freq2`, решение владельца; Telegram `contacts.resetTopPeerRating`) — на сервере: «Убрать» шлёт `POST /conv/frequent/hide`,
 * сервер сам не отдаёт убранные на всех моих устройствах; здесь — отметка до следующего ответа сервера (полоса не мигает).
 * Убранные раньше на устройстве один раз переносятся на сервер со своими отметками, после успеха запись устройства стирается.
 */
export function useFrequentHidden(server: boolean): { hidden: FrequentHidden; hide: (convId: string) => void } {
  const [hidden, setHidden] = useState<FrequentHidden>(readFrequentHidden);
  useEffect(() => {
    if (!server || frequentMoving) return;
    const local = readFrequentHidden();
    const ids = Object.keys(local);
    if (ids.length === 0) return;
    frequentMoving = true;
    api
      .convFrequentHide(ids.map((conversationId) => ({ conversationId, at: local[conversationId] })))
      .then(() => {
        try {
          localStorage.removeItem(FREQUENT_HIDDEN_KEY);
        } catch {
          /* хранилище недоступно — повтор безвреден (сервер берёт позднюю отметку) */
        }
      })
      .catch(() => {
        frequentMoving = false;
      });
  }, [server]);
  const hide = useCallback(
    (convId: string) => {
      const at = new Date().toISOString();
      setHidden((prev) => {
        const next = hideFrequent(prev, convId, at);
        if (!server) {
          try {
            localStorage.setItem(FREQUENT_HIDDEN_KEY, JSON.stringify(next));
          } catch {
            /* хранилище недоступно — живёт до перезагрузки */
          }
        }
        return next;
      });
      if (server) {
        api.convFrequentHide([{ conversationId: convId }]).catch((e: unknown) => {
          // Сервер не принял — беседа возвращается в полосу (иначе на других устройствах она осталась бы, а здесь нет).
          setHidden((prev) => {
            if (prev[convId] !== at) return prev;
            const next = { ...prev };
            delete next[convId];
            return next;
          });
          toastError(e);
        });
      }
    },
    [server],
  );
  return { hidden, hide };
}

/**
 * «Частые» с сервера (`freq1`): грузятся каждый раз, когда открывается пустой поиск (`active`), прежний ответ показан, пока идёт
 * новый. `undefined` — сервер не умеет или запрос упал, а прежнего ответа нет (клиент рисует «Люди» по свежести), `[]` — ещё
 * грузится / пока никого.
 */
export function useFrequent(enabled: boolean, active: boolean): readonly ConvFrequentItem[] | undefined {
  const [items, setItems] = useState<readonly ConvFrequentItem[] | undefined>(enabled ? [] : undefined);
  useEffect(() => {
    if (!enabled) {
      setItems(undefined);
      return;
    }
    if (!active) return;
    let stale = false;
    api
      .convFrequent()
      .then((r) => {
        if (!stale) setItems(r.items);
      })
      .catch(() => {
        // Упал повтор (429, сеть) — прежняя полоса остаётся; «Люди» по свежести — только если показывать нечего.
        if (!stale) setItems((prev) => (prev && prev.length > 0 ? prev : undefined));
      });
    return () => {
      stale = true;
    };
  }, [enabled, active]);
  return enabled ? items : undefined;
}

/**
 * Одна кнопка полосы «Частые»: тап — открыть беседу; ПКМ и удержание пальцем (`DM_ROW_HOLD_MS`) — «Убрать из частых»
 * (Telegram Desktop `dialogs_suggestions.cpp`: `showMenuRequests` → `topPeers().remove`, Android — удержание аватара в «Людях»).
 */
function FrequentPerson({
  dm,
  label,
  onOpen,
  onMenu,
}: {
  dm: DmChannel;
  label: string;
  onOpen: () => void;
  onMenu?: (pos: MenuPos) => void;
}) {
  const hold = useRef<{ timer: number | null; x: number; y: number; fired: boolean } | null>(null);
  const stop = () => {
    const h = hold.current;
    if (h?.timer != null) window.clearTimeout(h.timer);
    if (h) h.timer = null;
  };
  useEffect(() => stop, []);
  return (
    <button
      type="button"
      className="dms-person"
      title={label}
      data-testid="dm-search-person"
      data-conv={dm.id}
      onClick={() => {
        if (hold.current?.fired) {
          hold.current = null;
          return;
        }
        onOpen();
      }}
      onContextMenu={
        onMenu
          ? (e) => {
              e.preventDefault();
              if (hold.current?.fired) return;
              onMenu({ x: e.clientX, y: e.clientY });
            }
          : undefined
      }
      onTouchStart={
        onMenu
          ? (e) => {
              stop();
              hold.current = null;
              if (e.touches.length !== 1) return;
              const p = e.touches[0];
              const h = { timer: null as number | null, x: p.clientX, y: p.clientY, fired: false };
              h.timer = window.setTimeout(() => {
                h.timer = null;
                h.fired = true;
                navigator.vibrate?.(8);
                onMenu({ x: h.x, y: h.y });
              }, DM_ROW_HOLD_MS);
              hold.current = h;
            }
          : undefined
      }
      onTouchMove={
        onMenu
          ? (e) => {
              const h = hold.current;
              const p = e.touches[0];
              if (!h || h.fired || !p) return;
              if (Math.abs(p.clientX - h.x) > DM_ROW_HOLD_SLOP || Math.abs(p.clientY - h.y) > DM_ROW_HOLD_SLOP) {
                stop();
                hold.current = null;
              }
            }
          : undefined
      }
      onTouchEnd={
        onMenu
          ? (e) => {
              stop();
              // Удержание сработало — отпускание не должно стать щелчком: иначе он придёт в подложку меню и закроет его.
              if (hold.current?.fired && e.cancelable) e.preventDefault();
            }
          : undefined
      }
    >
      <Avatar name={label} url={dm.otherUser.avatarUrl} size={48} />
      <span>{label.split(/\s+/)[0]}</span>
    </button>
  );
}

/** Пустое поле в фокусе: «Частые» (или «Люди»), «Недавние» (Telegram Android `DialogsSearchAdapter`: «Недавние» с «Очистить», полоса «Люди»). */
export function DmSearchHome({
  dms,
  recents,
  onPerson,
  onQuery,
  onRemove,
  onClear,
  frequent,
  onMenuOpen,
}: {
  dms: readonly DmChannel[];
  /** «Частые» с сервера (`freq1`) и всё, чем их отсеять; нет — полоса «Люди» по свежести, как до признака. */
  frequent?: { items: readonly ConvFrequentItem[]; hidden: FrequentHidden; blockedIds: ReadonlySet<string>; onHide: (convId: string) => void };
  recents: readonly RecentSearch[];
  onPerson: (dm: DmChannel) => void;
  onQuery: (text: string) => void;
  onRemove: (e: RecentSearch) => void;
  onClear: () => void;
  /** Меню «Убрать из частых» открыто / закрыто: пока оно стоит, поиск не закрывается от потери фокуса полем (приёмка S20+ 09.10). */
  onMenuOpen?: (open: boolean) => void;
}) {
  const byId = useMemo(() => new Map(dms.map((d) => [d.id, d])), [dms]);
  const people = useMemo(
    () => (frequent ? frequentStrip(frequent.items, dms, frequent.hidden, frequent.blockedIds) : peopleStrip(dms)),
    [dms, frequent],
  );
  const [freqMenu, setFreqMenu] = useState<{ dm: DmChannel; pos: MenuPos } | null>(null);
  const menuOpen = !!freqMenu && !!frequent;
  const onMenuOpenRef = useRef(onMenuOpen);
  onMenuOpenRef.current = onMenuOpen;
  useEffect(() => {
    if (!menuOpen) return;
    onMenuOpenRef.current?.(true);
    return () => onMenuOpenRef.current?.(false);
  }, [menuOpen]);
  const nameOf = usePeerName(); // подпись контакта вместо имени (`peerName.ts`)
  const rows = recents.filter((r) => r.kind === 'query' || byId.has(r.convId));
  return (
    <div className="dms-home" data-testid="dm-search-home">
      {people.length > 0 && (
        <section aria-label={frequent ? 'Частые' : 'Люди'}>
          <div className="dms-head">
            <span>{frequent ? 'Частые' : 'Люди'}</span>
          </div>
          <div className="dms-people" data-testid="dm-search-people">
            {people.map((d) => (
              <FrequentPerson
                key={d.id}
                dm={d}
                label={dmPeerLabel(d, nameOf)}
                onOpen={() => onPerson(d)}
                onMenu={frequent ? (pos) => setFreqMenu({ dm: d, pos }) : undefined}
              />
            ))}
          </div>
        </section>
      )}
      {rows.length > 0 && (
        <section aria-label="Недавние">
          <div className="dms-head">
            <span>Недавние</span>
            <button type="button" className="link" onClick={onClear}>
              Очистить
            </button>
          </div>
          {rows.map((r) => {
            const dm = r.kind === 'person' ? byId.get(r.convId) : undefined;
            return (
              <div key={r.kind === 'query' ? `q:${r.text}` : `p:${r.convId}`} className="dms-recent">
                <button
                  type="button"
                  className="dms-recent-main"
                  onClick={() => (dm ? onPerson(dm) : r.kind === 'query' ? onQuery(r.text) : undefined)}
                >
                  {dm ? (
                    <Avatar name={dmPeerLabel(dm, nameOf)} url={dm.otherUser.avatarUrl} size={32} />
                  ) : (
                    <span className="dms-recent-ico">
                      <Icon name="clock" size={16} />
                    </span>
                  )}
                  <span className="dms-recent-text">{dm ? dmPeerLabel(dm, nameOf) : r.kind === 'query' ? r.text : ''}</span>
                </button>
                <button type="button" className="dms-recent-x" aria-label="Убрать из недавних" title="Убрать" onClick={() => onRemove(r)}>
                  <Icon name="close" size={14} />
                </button>
              </div>
            );
          })}
        </section>
      )}
      {rows.length === 0 && people.length === 0 && <div className="dm-empty">Ищите по имени, логину или тексту сообщений</div>}
      {freqMenu && frequent && (
        <ContextMenu pos={freqMenu.pos} onClose={() => setFreqMenu(null)} width={232}>
          {/* Нажатие по пункту не уводит фокус из поля поиска. На телефоне меню — нижний лист: он гасит всплытие `mousedown`
              (`ContextMenu`, `.ctx-menu.sheet`), до `.dms-home-wrap` оно не доходит — и касание закрывало поиск (а с ним меню)
              раньше `onClick` пункта (приёмка S20+ 09.10). */}
          <div onMouseDown={(e) => e.preventDefault()}>
            <MenuItem
              icon="close"
              label="Убрать из частых"
              onClick={() => {
                frequent.onHide(freqMenu.dm.id);
                setFreqMenu(null);
              }}
            />
          </div>
        </ContextMenu>
      )}
    </div>
  );
}

const KIND_ICON: Record<KindChip, IconName> = {
  media: 'photo',
  file: 'file',
  link: 'link',
  gif: 'play',
  voice: 'mic',
};

/**
 * Чипы под полем (Android `FiltersView`): выбранные — залитые с крестиком, подсказки из набранного — контурные. Нажатие на
 * подсказку ставит чип и очищает набранное (`onText('')`), как у Telegram. Дата — только когда текст разбирается как дата.
 */
export function DmSearchChips({
  q,
  dms,
  chips,
  onChips,
  onText,
  phone,
}: {
  q: string;
  dms: readonly DmChannel[];
  chips: SearchChips;
  onChips: (c: SearchChips) => void;
  onText: (t: string) => void;
  /** Телефон: чипов типа нет — их роль играют вкладки поиска (`DmSearchKinds.tsx`). */
  phone?: boolean;
}) {
  const nameOf = usePeerName();
  const people = useMemo(() => (chips.person ? [] : personSuggestions(dms, q, 3, nameOf)), [dms, q, chips.person, nameOf]);
  const date = useMemo(() => (chips.date ? null : parseDateQuery(q)), [q, chips.date]);
  // Чипы типа (Telegram Android `FiltersView`): пока поле пусто — все пять, выбран один — только он (с крестиком).
  const kinds = chips.kind || phone ? [] : q.trim() === '' ? KIND_CHIPS : [];
  if (!chips.person && !chips.date && !chips.kind && people.length === 0 && !date && kinds.length === 0) return null;
  return (
    <div className="dms-chips" role="group" aria-label="Фильтры поиска">
      {chips.person && (
        <button type="button" className="dms-chip on" onClick={() => onChips({ ...chips, person: undefined })} title="Убрать фильтр">
          <Icon name="user" size={13} />
          {chips.person.name}
          <Icon name="close" size={12} />
        </button>
      )}
      {chips.date && (
        <button type="button" className="dms-chip on" onClick={() => onChips({ ...chips, date: undefined })} title="Убрать фильтр">
          <Icon name="calendar-time" size={13} />
          {chips.date.label}
          <Icon name="close" size={12} />
        </button>
      )}
      {chips.kind && (
        <button type="button" className="dms-chip on" onClick={() => onChips({ ...chips, kind: undefined })} title="Убрать фильтр">
          <Icon name={KIND_ICON[chips.kind]} size={13} />
          {SHARED_MEDIA_TITLES[chips.kind]}
          <Icon name="close" size={12} />
        </button>
      )}
      {kinds.map((k) => (
        <button key={k} type="button" className="dms-chip" data-kind={k} onClick={() => onChips({ ...chips, kind: k })}>
          <Icon name={KIND_ICON[k]} size={13} />
          {SHARED_MEDIA_TITLES[k]}
        </button>
      ))}
      {people.map((p: PersonChip) => (
        <button
          key={p.convId}
          type="button"
          className="dms-chip"
          onClick={() => {
            onChips({ ...chips, person: p });
            onText('');
          }}
        >
          <Icon name="user" size={13} />
          {p.name}
        </button>
      ))}
      {date && (
        <button
          type="button"
          className="dms-chip"
          onClick={() => {
            onChips({ ...chips, date });
            onText('');
          }}
        >
          <Icon name="calendar-time" size={13} />
          {date.label}
        </button>
      )}
    </div>
  );
}

/** Строка найденного сообщения личной беседы: имя собеседника, время, фрагмент с подсветкой (общая для «Сообщений» и «Все»). */
export function DmHitRow({
  h,
  dm,
  text,
  kind,
  meId,
  onOpen,
}: {
  h: ConvSearchAllHit;
  dm: DmChannel;
  text: string;
  kind: SearchChips['kind'];
  meId: string | undefined;
  onOpen: (hit: ConvSearchAllHit) => void;
}) {
  const snip = hitSnippet(h.content, text);
  const kindText = hitKindLabel(h.content, kind);
  const when = dmRowTime(h.createdAt);
  const name = dmPeerLabel(dm, usePeerName());
  return (
    <button type="button" className="dm-row dm-msg-hit" onClick={() => onOpen(h)}>
      <span className="dm-ava">
        <Avatar name={name} url={dm.otherUser.avatarUrl} size={40} />
      </span>
      <span className="dm-name">
        <span className="dm-name-text">{name}</span>
      </span>
      <span className="dm-when">
        {when && (
          <time className="dm-time" dateTime={when.dateTime}>
            {when.label}
          </time>
        )}
      </span>
      <span className="dm-preview">
        {meId && h.authorId === meId && <span className="dm-from">Вы: </span>}
        {snip.pre}
        {snip.hit && <mark className="dm-hit">{snip.hit}</mark>}
        {snip.post}
        {kindText}
      </span>
    </button>
  );
}

interface HitsState {
  status: 'idle' | 'loading' | 'done' | 'error';
  hits: ConvSearchAllHit[];
  next: string | null;
  more: boolean;
}

const IDLE: HitsState = { status: 'idle', hits: [], next: null, more: false };

/**
 * «Сообщения»: поиск по тексту во всех беседах с паузой набора, опоздавший ответ отбрасывается по номеру запроса. Нет текста
 * и чипов — ничего не рисуется. Нажатие — открыть беседу на этом сообщении (`feedJump`) и запомнить запрос в «Недавних».
 */
export function DmMessageHits({
  q,
  chips,
  dms,
  meId,
  quietEmpty,
  onOpen,
}: {
  q: string;
  chips: SearchChips;
  dms: readonly DmChannel[];
  meId: string | undefined;
  /** Вкладка «Все» (`srvsearch1`): личных совпадений нет — раздел молчит, под ним серверы (`scopeView`). */
  quietEmpty?: boolean;
  onOpen: (hit: ConvSearchAllHit) => void;
}) {
  const [st, setSt] = useState<HitsState>(IDLE);
  const seq = useRef(0);
  const query = messageQuery(q, chips);
  const text = query?.text ?? null;
  const person = chips.person?.convId;
  const since = chips.date?.since;
  const until = chips.date?.until;
  const kind = chips.kind;
  const byId = useMemo(() => new Map(dms.map((d) => [d.id, d])), [dms]);

  useEffect(() => {
    if (text === null) {
      seq.current += 1;
      setSt(IDLE);
      return;
    }
    const mine = ++seq.current;
    setSt((s) => ({ ...s, status: 'loading' }));
    const t = window.setTimeout(() => {
      api
        .convSearchAll({ q: text, conversationId: person, since, until, kind, limit: MESSAGE_SEARCH_PAGE })
        .then((r) => {
          if (seq.current === mine) setSt({ status: 'done', hits: r.hits, next: r.next, more: false });
        })
        .catch(() => {
          if (seq.current === mine) setSt({ status: 'error', hits: [], next: null, more: false });
        });
    }, MESSAGE_SEARCH_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [text, person, since, until, kind]);

  const loadMore = () => {
    if (!st.next || st.more || text === null) return;
    const mine = seq.current;
    const before = st.next;
    setSt((s) => ({ ...s, more: true }));
    api
      .convSearchAll({ q: text, conversationId: person, since, until, kind, before, limit: MESSAGE_SEARCH_PAGE })
      .then((r) => {
        if (seq.current === mine) setSt((s) => ({ status: 'done', hits: [...s.hits, ...r.hits], next: r.next, more: false }));
      })
      .catch((e) => {
        if (seq.current === mine) setSt((s) => ({ ...s, more: false }));
        toastError(e, 'Не удалось загрузить ещё');
      });
  };

  if (text === null) return null;
  const rows = st.hits.filter((h) => byId.has(h.conversationId));
  if (quietEmpty && rows.length === 0 && st.status !== 'idle') return null;
  return (
    <section className="dms-hits" aria-label="Сообщения" data-testid="dm-search-hits">
      <div className="dms-head">
        <span>Сообщения</span>
      </div>
      {rows.map((h) => {
        const dm = byId.get(h.conversationId);
        return dm ? <DmHitRow key={h.id} h={h} dm={dm} text={text} kind={kind} meId={meId} onOpen={onOpen} /> : null;
      })}
      {st.status === 'loading' && rows.length === 0 && <div className="dm-empty dm-nores">Ищем…</div>}
      {st.status === 'error' && <div className="dm-empty dm-nores">Не удалось поискать по сообщениям</div>}
      {st.status === 'done' && rows.length === 0 && (
        <div className="dm-empty dm-nores">{hasChips(chips) || q.trim() ? 'В сообщениях ничего не найдено' : ''}</div>
      )}
      {st.next && (
        <button type="button" className="dms-more link" disabled={st.more} onClick={loadMore}>
          {st.more ? 'Загрузка…' : 'Показать ещё'}
        </button>
      )}
    </section>
  );
}

/** Перейти к найденному: беседа открывается, лента встаёт на сообщение (заказ забирает `MessagePane`). */
export function openSearchHit(h: ConvSearchAllHit): void {
  requestFeedJump(h.conversationId, h.id);
  void useStore.getState().selectDm(h.conversationId);
}
