/**
 * Вкладка «Все» поиска из списка ЛС (`srvsearch1`, решение владельца 08.10): сообщения личных бесед и каналов серверов ОДНИМ
 * списком по времени, без разделов «Сообщения» / «Серверы» (раньше — личные сверху и пять серверных под ними). Правило слияния —
 * `dmListSearchRules.mergeSearchHits` (два источника листаются своими курсорами; показано только то, что новее «горизонта»).
 * Строки — те же, что на вкладках «Личные» (`DmHitRow`) и «Серверы» (`ServerHitRow`). Сбой серверов во «Все» не шумит.
 */
import type { ConvSearchAllHit, DmChannel, ServerSearchHit } from '@gusvoice/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { MESSAGE_SEARCH_DELAY_MS, MESSAGE_SEARCH_PAGE, mergeSearchHits } from '../dmListSearchRules';
import { toastError } from '../toast';
import { DmHitRow } from './DmListSearch';
import { ServerHitRow } from './DmServerSearch';

/** Вкладки поиска на телефоне (12.10, #218) — свой модуль; список бесед берёт их отсюда вместе с вкладкой «Все». */
export { DmKindHits, DmSearchTabs } from './DmSearchKinds';

interface Side<T> {
  status: 'idle' | 'loading' | 'done' | 'error';
  hits: T[];
  next: string | null;
  more: boolean;
}

const idle = <T,>(): Side<T> => ({ status: 'idle', hits: [], next: null, more: false });

export function AllMessageHits({
  q,
  dms,
  meId,
  onOpenDm,
  onOpenServer,
}: {
  q: string;
  dms: readonly DmChannel[];
  meId: string | undefined;
  onOpenDm: (hit: ConvSearchAllHit) => void;
  onOpenServer: (hit: ServerSearchHit) => void;
}) {
  const [dm, setDm] = useState<Side<ConvSearchAllHit>>(idle);
  const [srv, setSrv] = useState<Side<ServerSearchHit>>(idle);
  const seq = useRef(0);
  const text = q.trim();
  const byId = useMemo(() => new Map(dms.map((d) => [d.id, d])), [dms]);

  useEffect(() => {
    if (text.length < 2) {
      seq.current += 1;
      setDm(idle());
      setSrv(idle());
      return;
    }
    const mine = ++seq.current;
    setDm((s) => ({ ...s, status: 'loading' }));
    setSrv((s) => ({ ...s, status: 'loading' }));
    const t = window.setTimeout(() => {
      api
        .convSearchAll({ q: text, limit: MESSAGE_SEARCH_PAGE })
        .then((r) => seq.current === mine && setDm({ status: 'done', hits: r.hits, next: r.next, more: false }))
        .catch(() => seq.current === mine && setDm({ status: 'error', hits: [], next: null, more: false }));
      api
        .searchServers({ q: text, limit: MESSAGE_SEARCH_PAGE })
        .then((r) => seq.current === mine && setSrv({ status: 'done', hits: r.hits, next: r.next, more: false }))
        .catch(() => seq.current === mine && setSrv({ status: 'error', hits: [], next: null, more: false }));
    }, MESSAGE_SEARCH_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [text]);

  const merged = useMemo(() => mergeSearchHits(dm, srv), [dm, srv]);
  const loading = dm.status === 'loading' || srv.status === 'loading';
  const busy = dm.more || srv.more;

  const loadMore = () => {
    if (!merged.more || busy || text.length < 2) return;
    const mine = seq.current;
    if (merged.more === 'dm' && dm.next) {
      const before = dm.next;
      setDm((s) => ({ ...s, more: true }));
      api
        .convSearchAll({ q: text, before, limit: MESSAGE_SEARCH_PAGE })
        .then((r) => seq.current === mine && setDm((s) => ({ status: 'done', hits: [...s.hits, ...r.hits], next: r.next, more: false })))
        .catch((e) => {
          if (seq.current === mine) setDm((s) => ({ ...s, more: false }));
          toastError(e, 'Не удалось загрузить ещё');
        });
    } else if (merged.more === 'servers' && srv.next) {
      const before = srv.next;
      setSrv((s) => ({ ...s, more: true }));
      api
        .searchServers({ q: text, before, limit: MESSAGE_SEARCH_PAGE })
        .then((r) => seq.current === mine && setSrv((s) => ({ status: 'done', hits: [...s.hits, ...r.hits], next: r.next, more: false })))
        .catch((e) => {
          if (seq.current === mine) setSrv((s) => ({ ...s, more: false }));
          toastError(e, 'Не удалось загрузить ещё');
        });
    }
  };

  if (text.length < 2) return null;
  const rows = merged.rows.filter((r) => r.from === 'servers' || byId.has(r.hit.conversationId));
  // Пусто и всё ответило — раздел молчит: над ним уже есть «бесед нет» / список бесед по имени.
  if (rows.length === 0 && !loading && dm.status !== 'idle' && !merged.more) {
    return dm.status === 'error' ? (
      <section className="dms-hits" aria-label="Сообщения" data-testid="all-search-hits">
        <div className="dm-empty dm-nores">Не удалось поискать по сообщениям</div>
      </section>
    ) : null;
  }
  return (
    <section className="dms-hits" aria-label="Сообщения" data-testid="all-search-hits">
      <div className="dms-head">
        <span>Сообщения</span>
      </div>
      {rows.map((r) => {
        if (r.from === 'servers') return <ServerHitRow key={`s${r.hit.id}`} h={r.hit} text={text} onOpen={onOpenServer} />;
        const d = byId.get(r.hit.conversationId);
        return d ? <DmHitRow key={`d${r.hit.id}`} h={r.hit} dm={d} text={text} kind={undefined} meId={meId} onOpen={onOpenDm} /> : null;
      })}
      {loading && rows.length === 0 && <div className="dm-empty dm-nores">Ищем…</div>}
      {merged.more && (
        <button type="button" className="dms-more link" disabled={busy} onClick={loadMore}>
          {busy ? 'Загрузка…' : 'Показать ещё'}
        </button>
      )}
    </section>
  );
}
