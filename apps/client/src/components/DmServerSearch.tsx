/**
 * Вкладки областей и «Серверы» в поиске из списка ЛС (G35, #211, признак `srvsearch1`). Правила (какие области видны) —
 * `dmListSearchRules.scopeView`; ответ — `GET /search/servers` (`serverSearch.ts` на бэкенде: те же права читать каналы, что у поиска по
 * одному серверу, только локальные серверы). Строка результата — как у «Сообщений» личных бесед (`DmMessageHits`): имя — «#канал · Сервер»,
 * сверху справа время, в превью «Автор: фрагмент» с подсветкой. Нажатие — открыть канал на этом сообщении (`openServerHit`).
 *
 * Источник поведения — Telegram Desktop `dialogs/ui/chat_search_in.cpp` (полоса вкладок под полем) и tweb `appSearchSuper.ts`.
 */
import { SERVER_SEARCH_MIN_CHARS, type ServerSearchHit } from '@gusvoice/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { dmRowTime } from '../dmRowRules';
import { hitSnippet, MESSAGE_SEARCH_DELAY_MS, MESSAGE_SEARCH_PAGE, SEARCH_SCOPES, SERVER_HITS_IN_ALL, type SearchScope } from '../dmListSearchRules';
import { requestFeedJump } from '../feedJump';
import { subscribeToServer } from '../sockets';
import { useStore } from '../store';
import { toast, toastError } from '../toast';
import { Avatar } from './Avatar';

/** Полоса вкладок под полем. Мышь по ней не уводит фокус из поля (иначе панель закрылась бы раньше щелчка). */
export function DmSearchScopes({ scope, onScope }: { scope: SearchScope; onScope: (s: SearchScope) => void }) {
  return (
    <div className="dms-scopes" role="tablist" aria-label="Где искать" onMouseDown={(e) => e.preventDefault()}>
      {SEARCH_SCOPES.map((s) => (
        <button
          key={s.id}
          type="button"
          role="tab"
          aria-selected={s.id === scope}
          data-scope={s.id}
          className={s.id === scope ? 'dms-scope on' : 'dms-scope'}
          onClick={() => onScope(s.id)}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

/** Строка найденного сообщения канала сервера: «#канал · Сервер», время, «Автор: фрагмент» (общая для «Серверов» и «Все»). */
export function ServerHitRow({ h, text, onOpen }: { h: ServerSearchHit; text: string; onOpen: (hit: ServerSearchHit) => void }) {
  const snip = hitSnippet(h.content, text);
  const when = dmRowTime(h.createdAt);
  return (
    <button type="button" className="dm-row dm-msg-hit" data-channel={h.channelId} onClick={() => onOpen(h)}>
      <span className="dm-ava">
        <Avatar name={h.authorName} url={h.authorAvatarUrl} size={40} />
      </span>
      <span className="dm-name">
        <span className="dm-name-text">
          #{h.channelName} · {h.serverName}
        </span>
      </span>
      <span className="dm-when">
        {when && (
          <time className="dm-time" dateTime={when.dateTime}>
            {when.label}
          </time>
        )}
      </span>
      <span className="dm-preview">
        <span className="dm-from">{h.authorName}: </span>
        {snip.pre}
        {snip.hit && <mark className="dm-hit">{snip.hit}</mark>}
        {snip.post}
      </span>
    </button>
  );
}

/** Сервер ответил 429 на частый поиск (`api.ts` кладёт код в `status` ошибки). */
export function isTooManyRequests(e: unknown): boolean {
  return (e as { status?: number } | null)?.status === 429;
}

/** Мягкий текст на 429: слова сервера («Слишком много попыток. Попробуйте через 1 мин.»), нет их — свои. */
export function limitedText(e: unknown): string {
  const m = e instanceof Error ? e.message.trim() : '';
  return m && !/^HTTP \d+$/.test(m) ? m : 'Слишком часто — попробуйте через минуту';
}

interface HitsState {
  status: 'idle' | 'loading' | 'done' | 'error' | 'limited';
  /** Текст при `limited` (ответ сервера на частый поиск, 429). */
  note?: string;
  hits: ServerSearchHit[];
  next: string | null;
  more: boolean;
}

const IDLE: HitsState = { status: 'idle', hits: [], next: null, more: false };

/**
 * «Сообщения серверов»: пауза набора, опоздавший ответ отбрасывается по номеру запроса. `full` — вкладка «Серверы» (страницы по
 * «Показать ещё»), иначе вкладка «Все»: несколько первых и «Показать все» (`onShowAll`). Пустой результат во вкладке «Все» ничего не рисует.
 */
export function ServerMessageHits({
  q,
  full,
  onOpen,
  onShowAll,
}: {
  q: string;
  full: boolean;
  onOpen: (hit: ServerSearchHit) => void;
  onShowAll: () => void;
}) {
  const [st, setSt] = useState<HitsState>(IDLE);
  const seq = useRef(0);
  const text = q.trim();
  const limit = full ? MESSAGE_SEARCH_PAGE : SERVER_HITS_IN_ALL;

  // Сервер ищет от `SERVER_SEARCH_MIN_CHARS` (3) знаков (решение владельца 08.10): короче не спрашиваем — вкладка «Серверы»
  // подсказывает «Введите от 3 символов», «Все» молчит. Вкладки и личные беседы — по-прежнему от 2.
  const short = [...text].length < SERVER_SEARCH_MIN_CHARS;

  useEffect(() => {
    if (short) {
      seq.current += 1;
      setSt(IDLE);
      return;
    }
    const mine = ++seq.current;
    setSt((s) => ({ ...s, status: 'loading' }));
    const t = window.setTimeout(() => {
      api
        .searchServers({ q: text, limit })
        .then((r) => {
          if (seq.current === mine) setSt({ status: 'done', hits: r.hits, next: r.next, more: false });
        })
        .catch((e) => {
          if (seq.current !== mine) return;
          // 429 — не поломка, а «слишком часто» (решение 21, 08.10): мягкая строка с текстом сервера, не «не удалось».
          if (isTooManyRequests(e)) setSt({ status: 'limited', note: limitedText(e), hits: [], next: null, more: false });
          else setSt({ status: 'error', hits: [], next: null, more: false });
        });
    }, MESSAGE_SEARCH_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [text, limit, short]);

  const loadMore = () => {
    if (!st.next || st.more || short) return;
    const mine = seq.current;
    const before = st.next;
    setSt((s) => ({ ...s, more: true }));
    api
      .searchServers({ q: text, before, limit })
      .then((r) => {
        if (seq.current === mine) setSt((s) => ({ status: 'done', hits: [...s.hits, ...r.hits], next: r.next, more: false }));
      })
      .catch((e) => {
        if (seq.current === mine) setSt((s) => ({ ...s, more: false }));
        toastError(e, 'Не удалось загрузить ещё');
      });
  };

  if (short) {
    if (!full || text.length === 0) return null;
    return (
      <section className="dms-hits" aria-label="Сообщения серверов" data-testid="srv-search-hits">
        <div className="dm-empty dm-nores">Введите от {SERVER_SEARCH_MIN_CHARS} символов</div>
      </section>
    );
  }
  // Во вкладке «Все» пустое и сбойное не шумит: личные результаты — главное, серверы — добавка.
  if (!full && st.hits.length === 0) return null;
  return (
    <section className="dms-hits" aria-label="Сообщения серверов" data-testid="srv-search-hits">
      <div className="dms-head">
        <span>Серверы</span>
      </div>
      {st.hits.map((h) => (
        <ServerHitRow key={h.id} h={h} text={text} onOpen={onOpen} />
      ))}
      {full && st.status === 'loading' && st.hits.length === 0 && <div className="dm-empty dm-nores">Ищем…</div>}
      {full && st.status === 'limited' && <div className="dm-empty dm-nores">{st.note}</div>}
      {full && st.status === 'error' && <div className="dm-empty dm-nores">Не удалось поискать по серверам</div>}
      {full && st.status === 'done' && st.hits.length === 0 && <div className="dm-empty dm-nores">На серверах ничего не найдено</div>}
      {full && st.next && (
        <button type="button" className="dms-more link" disabled={st.more} onClick={loadMore}>
          {st.more ? 'Загрузка…' : 'Показать ещё'}
        </button>
      )}
      {!full && (st.next || st.hits.length >= SERVER_HITS_IN_ALL) && (
        <button type="button" className="dms-more link" onClick={onShowAll}>
          Показать все на серверах
        </button>
      )}
    </section>
  );
}

/** Сколько страниц истории канала подгружаем в поисках найденного сообщения (50 в странице): дальше — «пролистайте вверх». */
const MAX_BACK_PAGES = 40;

const has = (channelId: string, messageId: string): boolean =>
  !!useStore.getState().messagesByChannel[channelId]?.some((m) => m.id === messageId);

/** Лента канала хранит окно последних сообщений; найденное может лежать глубже — подгружаем страницы назад, пока оно не появится. */
async function loadUntilPresent(channelId: string, messageId: string): Promise<boolean> {
  const t0 = Date.now();
  for (let i = 0; i < MAX_BACK_PAGES; i += 1) {
    if (has(channelId, messageId)) return true;
    if (useStore.getState().messagesByChannel[channelId] === undefined) {
      // Лента ещё не пришла (первое открытие): ждём не дольше 4 с.
      if (Date.now() - t0 > 4000) return false;
      await new Promise((r) => window.setTimeout(r, 100));
      i -= 1;
      continue;
    }
    if (!(await useStore.getState().loadOlderMessages(channelId))) return has(channelId, messageId);
  }
  return has(channelId, messageId);
}

/** Перейти к найденному на сервере: открыть сервер и канал, подгрузить историю до сообщения, затем заказать прыжок (`feedJump`). */
export async function openServerHit(h: ServerSearchHit): Promise<void> {
  const st = useStore.getState();
  try {
    if (st.currentServerId !== h.serverId) {
      await st.openServer(h.serverId, h.channelId);
      subscribeToServer(h.serverId);
    } else {
      await st.openChannel(h.channelId);
    }
    useStore.getState().setView('server');
    if (await loadUntilPresent(h.channelId, h.id)) requestFeedJump(h.channelId, h.id);
    else toast('info', 'Это сообщение слишком глубоко в истории — пролистайте вверх');
  } catch (e) {
    toastError(e, 'Не удалось открыть сообщение');
  }
}
