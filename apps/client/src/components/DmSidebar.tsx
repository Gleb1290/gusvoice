import { useEffect, useMemo, useState } from 'react';
import { isMobile } from '../hotkeys';
import { useStore } from '../store';
import { toastError } from '../toast';
import { Avatar } from './Avatar';
import { BottomSheet } from './BottomSheet';
import { Goose } from './Goose';
import { Icon } from './Icon';
import { SelfVoiceBar } from './SelfVoiceBar';
import { VoicePanel } from './VoicePanel';

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

/** Compact recency label for a DM row: time today, "вчера", weekday within a week, else DD.MM. */
function fmtDmTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((day(now) - day(d)) / 86_400_000);
  if (diffDays <= 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'вчера';
  if (diffDays < 7) return WEEKDAYS[d.getDay()];
  return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
}

/** Left column for the direct-messages view: the list of conversations. */
export function DmSidebar() {
  const dms = useStore((s) => s.dms);
  const currentDmId = useStore((s) => s.currentDmId);
  const unreadDms = useStore((s) => s.unreadDms);
  const onlineUsers = useStore((s) => s.onlineUsers);
  const loadDms = useStore((s) => s.loadDms);
  const selectDm = useStore((s) => s.selectDm);
  const voice = useStore((s) => s.voice);
  const members = useStore((s) => s.members);
  const meId = useStore((s) => s.user?.id);
  const openDmWith = useStore((s) => s.openDmWith);
  const [newDmOpen, setNewDmOpen] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    loadDms().catch(() => {});
  }, [loadDms]);

  const onlineSet = new Set(onlineUsers);
  const mobile = isMobile();

  // Candidates for the "new message" sheet: the server roster minus yourself, filtered live.
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return members
      .filter((m) => m.user.id !== meId)
      .filter((m) => !q || m.user.displayName.toLowerCase().includes(q) || m.user.username.toLowerCase().includes(q))
      .slice(0, 50);
  }, [members, meId, query]);

  return (
    <div className="channels">
      <div className="server-head">
        <strong>Личные сообщения</strong>
      </div>
      <div className="channel-list">
        {dms.length === 0 && (
          <div className="empty-goose">
            <Goose pose="look" size={104} />
            <div className="eg-title">Нет личных сообщений</div>
            <div className="eg-sub">Откройте участников сервера и нажмите на человека, чтобы написать ему.</div>
          </div>
        )}
        {dms.map((d) => {
          const online = onlineSet.has(d.otherUser.id);
          const unread = unreadDms.includes(d.id) && d.id !== currentDmId;
          // Число, как в списке каналов. Точка остаётся страховкой: флаг непрочитанного и счётчик
          // приходят из разных мест (сокет и загрузка списка), и рисовать пустую пилюлю на
          // рассинхроне хуже, чем показать прежнюю точку.
          const unreadN = unread ? (d.unread ?? 0) : 0;
          return (
            <div
              key={d.id}
              className={`dm-row ${d.id === currentDmId ? 'active' : ''} ${unread ? 'unread' : ''}`}
              onClick={() => void selectDm(d.id)}
            >
              {mobile ? (
                <>
                  <span className="dm-ava">
                    <Avatar url={d.otherUser.avatarUrl} name={d.otherUser.displayName} size={48} fallback="icon" />
                    <span className={`mp-dot ${online ? 'on' : 'off'}`} />
                  </span>
                  <span className="dm-main">
                    <span className="dm-name">{d.otherUser.displayName}</span>
                    <span className="dm-sub">@{d.otherUser.username}</span>
                  </span>
                  <span className="dm-meta">
                    <span className="dm-time">{fmtDmTime(d.lastMessageAt)}</span>
                    {unreadN > 0 ? (
                      <span className="dm-badge">{unreadN > 99 ? '99+' : unreadN}</span>
                    ) : unread ? (
                      <span className="dm-badge dot" />
                    ) : null}
                  </span>
                </>
              ) : (
                <>
                  <span className="dm-ava">
                    <Avatar url={d.otherUser.avatarUrl} name={d.otherUser.displayName} size={32} fallback="icon" />
                    <span className={`mp-dot ${online ? 'on' : 'off'}`} />
                  </span>
                  <span className="dm-name">{d.otherUser.displayName}</span>
                  {unreadN > 0 ? (
                    <span className="ch-unread">{unreadN > 99 ? '99+' : unreadN}</span>
                  ) : unread ? (
                    <span className="ch-unread-dot" />
                  ) : null}
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Mobile: floating compose button → pick someone from the roster to message (design-step8 D1). */}
      {mobile && (
        <button type="button" className="dm-fab" title="Написать" onClick={() => { setQuery(''); setNewDmOpen(true); }}>
          <Icon name="edit" size={24} />
        </button>
      )}
      {newDmOpen && (
        <BottomSheet title="Написать" onClose={() => setNewDmOpen(false)}>
          <input
            className="sheet-search"
            autoFocus
            value={query}
            placeholder="Кому написать?"
            onChange={(e) => setQuery(e.target.value)}
          />
          {candidates.length === 0 && (
            <div className="sheet-empty">Некому написать — откройте сервер с участниками.</div>
          )}
          {candidates.map((m) => (
            <button
              type="button"
              key={m.user.id}
              className="sheet-row"
              onClick={() => {
                setNewDmOpen(false);
                // Бэкенд откажет, если общего сервера уже нет (человек вышел, список устарел) — сказать об этом.
                openDmWith(m.user.id).catch((e: Error) => toastError(e));
              }}
            >
              <span className="dm-ava">
                <Avatar url={m.user.avatarUrl} name={m.user.displayName} size={38} fallback="icon" />
                <span className={`mp-dot ${onlineSet.has(m.user.id) ? 'on' : 'off'}`} />
              </span>
              <span className="sr-label">
                {m.user.displayName}
                <span className="dm-sub"> @{m.user.username}</span>
              </span>
            </button>
          ))}
        </BottomSheet>
      )}

      {voice && <VoicePanel />}
      <SelfVoiceBar />
    </div>
  );
}
