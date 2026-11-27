import type { ServerMemberInfo } from '@gusvoice/shared';
import { useEffect, useState } from 'react';
import { api, type ChannelAccessResult } from '../api';
import { Select } from './Select';
import './channel-access-check.css';

const actionLabels: Record<string, string> = {
  view: 'Видит канал',
  read: 'Может искать по истории',
  write: 'Может писать',
  join: 'Может войти',
  speak: 'Может говорить',
};
const permissionLabels: Record<string, string> = {
  VIEW_CHANNEL: 'Видимость канала',
  READ_HISTORY: 'Доступ к истории',
  SEND_MESSAGES: 'Отправка сообщений',
  CONNECT: 'Вход в голос',
  SPEAK: 'Микрофон',
};
const ruleLabels = {
  member: 'личное исключение',
  roles: 'правила ролей (разрешение важнее запрета внутри группы)',
  everyone: 'правило @everyone',
};

function reason(check: ChannelAccessResult[number]['checks'][number], roleNames: ReadonlyMap<string, string>) {
  switch (check.source) {
    case 'owner': return 'полный доступ владельца';
    case 'administrator': return 'право администратора';
    case 'membership': return 'членство закрыто';
    case 'roles': {
      if (!check.allowed) return 'ни одна роль не даёт это право';
      const names = check.roleIds?.map((id) => roleNames.get(id)).filter(Boolean);
      return names?.length ? `разрешено ролями · ${names.join(', ')}` : 'разрешено правами ролей';
    }
    case 'category':
    case 'channel':
      return `${check.source === 'category' ? 'Категория' : 'Канал'} · ${check.rule ? ruleLabels[check.rule] : ''}`;
  }
}

export function ChannelAccessCheck({ channelId, serverId, revision, roleNames }: {
  channelId: string;
  serverId: string;
  revision: number;
  roleNames: ReadonlyMap<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<ServerMemberInfo[] | null>(null);
  const [memberId, setMemberId] = useState('');
  const [memberError, setMemberError] = useState(false);
  const [memberRetry, setMemberRetry] = useState(0);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ revision: number; data?: ChannelAccessResult } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.listMembers(serverId).then(
      (list) => { if (!cancelled) setMembers(list); },
      () => { if (!cancelled) setMemberError(true); },
    );
    return () => { cancelled = true; };
  }, [open, serverId, memberRetry]);

  async function checkAccess() {
    if (!memberId || pending) return;
    setPending(true);
    setResult(null);
    try {
      setResult({ revision, data: await api.checkChannelAccess(channelId, memberId) });
    } catch {
      setResult({ revision });
    } finally {
      setPending(false);
    }
  }

  const visibleResult = result?.revision === revision ? result : null;
  return (
    <details className="channel-access-check" onToggle={(event) => { if (event.currentTarget.open) setOpen(true); }}>
      <summary>Проверить доступ</summary>
      <p className="muted">
        По сохранённым правам канала. Временные ограничения, например мьют, здесь не учитываются.
      </p>
      {memberError ? (
        <p role="alert">
          Не удалось загрузить участников.{' '}
          <button type="button" onClick={() => { setMemberError(false); setMemberRetry((n) => n + 1); }}>
            Повторить
          </button>
        </p>
      ) : members === null ? (
        open && <p role="status">Загружаем участников…</p>
      ) : (
        <div className="channel-access-controls">
          <Select value={memberId} disabled={pending} ariaLabel="Участник для проверки доступа"
            placeholder="Выберите участника" searchPlaceholder="Имя или @логин"
            options={members.map(({ user, nickname }) => ({
              value: user.id, label: `${nickname || user.displayName} (@${user.username})`,
            }))}
            onChange={(id) => {
              setMemberId(id);
              setResult(null);
            }} />
          <button type="button" disabled={!memberId || pending} onClick={() => void checkAccess()}>
            Проверить
          </button>
        </div>
      )}
      <div aria-live="polite" aria-atomic="true">
        {pending && <p>Проверяем права…</p>}
        {visibleResult && (visibleResult.data ? (
          <ul className="channel-access-results">
            {visibleResult.data.map((item) => {
              const decisive = item.checks.find((check) => !check.allowed) ?? item.checks.at(-1);
              return (
                <li key={item.action}>
                  <div>
                    <strong>{actionLabels[item.action]}</strong>
                    {decisive && <small>{permissionLabels[decisive.permission]} · {reason(decisive, roleNames)}</small>}
                  </div>
                  <span className={item.allowed ? 'allowed' : 'denied'}>{item.allowed ? 'Да' : 'Нет'}</span>
                </li>
              );
            })}
          </ul>
        ) : <p>Не удалось проверить доступ. Проверьте, что канал и участник ещё доступны, и повторите.</p>)}
      </div>
    </details>
  );
}
