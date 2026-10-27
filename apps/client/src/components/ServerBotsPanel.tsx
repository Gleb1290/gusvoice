/**
 * Настройки сервера → Интеграции → Боты (#231, ТЗ этапа 3 §4.1). Раскладка — как у `ServerWebhooksPanel` рядом: строки
 * `.ban-row`, раскрытие строки — `.webhook-editor`. Строка бота: аватар, имя со значком «БОТ», `@ник`, ниже — что бот видит
 * (Telegram `edit_participants_box.cpp:2458-2466`: «has access to messages» / «has no access to messages», по-русски) и кто
 * добавил. Раскрытие: «Читать все сообщения», «Права бота» (ведут в «Роли» к управляемой роли бота), «Убрать с сервера».
 *
 * Окно «Добавить бота»: ник → карточка бота (`lookup` через 300 мс), права галочками из того же списка, что редактор роли
 * (`PERMS` из `ServerRolesPanel`), без `ADMINISTRATOR` (боту его нельзя никому — решение владельца 26.10) и не больше своих
 * (чужие права неактивны; сервер всё равно режет `botGrant`), «Читать все сообщения» — выключено.
 *
 * Право раздела — `MANAGE_SERVER` (блок показывает `ServerSettingsModal`); старый сервер маршрутов не знает (404) — блок
 * говорит, что сервер не поддерживает ботов на серверах.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  BOT_DEFAULT_PERMISSIONS,
  has,
  Permission,
  permsFromString,
  type ServerBotInfo,
  type ServerBotLookup,
} from '@gusvoice/shared';
import { pushBackHandler } from '../androidBack';
import { api } from '../api';
import { confirmAction } from '../confirm';
import { useDialogChrome } from '../dialogChrome';
import { useStore } from '../store';
import { toast, toastError } from '../toast';
import { Avatar } from './Avatar';
import { HelpDot } from './HelpDot';
import { Icon } from './Icon';
import { isProtectedPerm, PERMS } from './ServerRolesPanel';
import { Toggle } from './Toggle';

/** Что бот видит — строкой (Telegram, список участников группы). Тот же текст стоит у бота в списке участников сервера. */
export function botReadLine(readAll: boolean): string {
  return readAll ? 'Видит все сообщения' : 'Видит только обращения';
}
const READ_ALL_HINT =
  'Бот будет получать каждое сообщение в каналах, которые видит. Без галочки — только команды, упоминания и ответы на его сообщения.';
const NOT_WORKING = 'Сейчас не работает';
const LOOKUP_DELAY_MS = 300;

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function ServerBotsPanel({
  serverId,
  ownerId,
  onOpenRole,
}: {
  serverId: string;
  ownerId: string;
  /** Открыть «Роли» на этой роли; нет — у человека нет `MANAGE_ROLES`, ссылки «Права бота» нет. */
  onOpenRole?: (roleId: string) => void;
}) {
  const [bots, setBots] = useState<ServerBotInfo[] | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .serverBots(serverId)
      .then((list) => setBots(Array.isArray(list) ? list : []))
      .catch((e: unknown) => {
        setBots([]);
        if ((e as { status?: number }).status === 404) setUnsupported(true);
        else toastError(e);
      });

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  const setReadAll = (b: ServerBotInfo, readAll: boolean) =>
    run(async () => {
      await api.updateServerBot(serverId, b.id, { readAll });
      setBots((bs) => (bs ?? []).map((x) => (x.id === b.id ? { ...x, readAll } : x)));
    });

  const remove = async (b: ServerBotInfo) => {
    const ok = await confirmAction({
      title: `Убрать бота «${b.displayName || b.username}» с сервера?`,
      body: 'Бот перестанет видеть каналы сервера, его роль удалится. Сообщения, которые он уже написал, останутся.',
      tone: 'danger',
      confirmLabel: 'Убрать',
    });
    if (!ok) return;
    await run(async () => {
      await api.removeServerBot(serverId, b.id);
      setBots((bs) => (bs ?? []).filter((x) => x.id !== b.id));
      setOpenId(null);
    });
  };

  return (
    <div className="settings-pane webhooks-panel server-bots-panel">
      <div className="settings-group-label">
        Боты
        <HelpDot label="Как работают боты на сервере">
          <ul>
            <li>Бот — программа: отвечает на команды, пишет в каналы, ставит кнопки под своими сообщениями.</li>
            <li>
              Добавить можно бота, доступного всем, или своего. У бота своя роль: права в ней — не больше ваших, права
              администратора боту не выдаются.
            </li>
            <li>Без «Читать все сообщения» бот видит только команды, упоминания и ответы на свои сообщения.</li>
          </ul>
        </HelpDot>
      </div>
      {unsupported ? (
        <div className="muted" style={{ padding: 12 }}>
          Этот сервер не поддерживает ботов на серверах — нужно обновить GusVoice.
        </div>
      ) : (
        <>
          <div className="modal-actions webhook-create" style={{ justifyContent: 'flex-start' }}>
            <button type="button" onClick={() => setAdding(true)}>
              <Icon name="plus" size={16} /> Добавить бота
            </button>
          </div>
          {bots === null ? (
            <div className="muted" style={{ padding: 12 }}>
              Загрузка…
            </div>
          ) : bots.length === 0 ? (
            <div className="muted" style={{ padding: 12 }}>
              Ботов на сервере пока нет.
            </div>
          ) : (
            <ul className="bans-list webhook-list">
              {bots.map((b) => {
                const name = b.displayName || b.username;
                return (
                  <li key={b.id} className="webhook-item">
                    <button
                      type="button"
                      className="ban-row webhook-row"
                      aria-expanded={openId === b.id}
                      onClick={() => setOpenId((o) => (o === b.id ? null : b.id))}
                    >
                      <Avatar url={b.avatarUrl} name={name} size={32} />
                      <span className="ban-meta">
                        <span className="ban-name">
                          {name}{' '}
                          <span className="bot-tag" title="Это бот: им управляет программа его владельца">
                            БОТ
                          </span>{' '}
                          <span className="muted">@{b.username}</span>
                        </span>
                        <span className="ban-sub">
                          {b.working ? botReadLine(b.readAll) : <span className="bot-state off">{NOT_WORKING}</span>}
                          {' · '}
                          {b.addedBy ? `добавил ${b.addedBy.displayName}` : 'добавлен'} {fmtDate(b.addedAt)}
                        </span>
                      </span>
                    </button>
                    {openId === b.id && (
                      <div className="webhook-editor">
                        <div className="bot-toggle-row">
                          <span className="dmf-main">
                            <span className="dmf-title" id={`sb-read-${b.id}`}>
                              Читать все сообщения
                            </span>
                            <span className="dmf-sub">{READ_ALL_HINT}</span>
                          </span>
                          <Toggle
                            checked={b.readAll}
                            disabled={busy}
                            labelledBy={`sb-read-${b.id}`}
                            onChange={(v) => void setReadAll(b, v)}
                          />
                        </div>
                        <div className="modal-actions">
                          <button type="button" className="danger-text" disabled={busy} onClick={() => void remove(b)}>
                            Убрать с сервера
                          </button>
                          <div style={{ flex: 1 }} />
                          {onOpenRole && b.roleId && (
                            <button type="button" className="link" onClick={() => onOpenRole(b.roleId!)}>
                              Права бота
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {adding && (
        <AddBotDialog
          serverId={serverId}
          ownerId={ownerId}
          onClose={() => setAdding(false)}
          onAdded={(id) => {
            setAdding(false);
            setOpenId(id);
            void load();
          }}
        />
      )}
    </div>
  );
}

type Lookup = { kind: 'idle' } | { kind: 'loading' } | { kind: 'none' } | { kind: 'error'; text: string } | { kind: 'found'; bot: ServerBotLookup };

function AddBotDialog({
  serverId,
  ownerId,
  onClose,
  onAdded,
}: {
  serverId: string;
  ownerId: string;
  onClose: () => void;
  onAdded: (botId: string) => void;
}) {
  const ref = useDialogChrome(onClose);
  const myPerms = permsFromString(useStore((s) => s.bootstrap?.permissions));
  const canGrantProtected = useStore((s) => !!s.user && (s.user.superAdmin || s.user.id === ownerId));
  /** Право можно отметить: оно есть у самого человека; защищённое — только владельцу; `ADMINISTRATOR` в списке нет вовсе. */
  const canGive = (bit: bigint, key: (typeof PERMS)[number]['key']) =>
    has(myPerms, bit) && (!isProtectedPerm(key) || canGrantProtected);
  const [nick, setNick] = useState('');
  const [lookup, setLookup] = useState<Lookup>({ kind: 'idle' });
  const [perms, setPerms] = useState(() =>
    PERMS.reduce((acc, p) => (canGive(Permission[p.key], p.key) ? acc : acc & ~Permission[p.key]), BigInt(BOT_DEFAULT_PERMISSIONS)),
  );
  const [readAll, setReadAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      pushBackHandler(() => {
        onClose();
        return true;
      }),
    [],
  );

  useEffect(() => {
    const q = nick.trim().replace(/^@/, '');
    if (!q) {
      setLookup({ kind: 'idle' });
      return;
    }
    setLookup({ kind: 'loading' });
    let cancelled = false;
    const t = window.setTimeout(() => {
      api.serverBotLookup(serverId, q).then(
        (bot) => !cancelled && setLookup({ kind: 'found', bot }),
        (e: unknown) => {
          if (cancelled) return;
          if ((e as { status?: number }).status === 404) setLookup({ kind: 'none' });
          else setLookup({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
        },
      );
    }, LOOKUP_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [nick, serverId]);

  const found = lookup.kind === 'found' ? lookup.bot : null;
  const add = async () => {
    if (!found?.canAdd) return;
    setBusy(true);
    setError(null);
    try {
      await api.addServerBot(serverId, { botId: found.id, permissions: (perms & ~Permission.ADMINISTRATOR).toString(), readAll });
      toast('success', 'Бот добавлен на сервер');
      onAdded(found.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // В `body`, а не внутри окна настроек: там подложка ложилась бы только на правую часть окна (как окно токена бота).
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={ref}
        className="modal create-channel add-bot-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-bot-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        // Esc закрывает только это окно: `preventDefault` — знак окну настроек под ним не закрываться (`useDialogChrome`).
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          onClose();
        }}
      >
        <div className="admin-head">
          <h2 id="add-bot-title">Добавить бота</h2>
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <label className="field">
          Ник бота
          <input
            value={nick}
            autoFocus
            spellCheck={false}
            autoCapitalize="none"
            placeholder="например, weatherbot"
            onChange={(e) => setNick(e.target.value)}
          />
        </label>
        {lookup.kind === 'loading' ? (
          <div className="muted bot-hint">Ищем…</div>
        ) : lookup.kind === 'none' ? (
          <div className="muted bot-hint">Бот не найден</div>
        ) : lookup.kind === 'error' ? (
          <div className="error">{lookup.text}</div>
        ) : found ? (
          <div className="webhook-ava add-bot-card">
            <Avatar url={found.avatarUrl} name={found.displayName || found.username} size={48} />
            <div className="bot-ava-side">
              <span className="dmf-title">
                {found.displayName || found.username}{' '}
                <span className="bot-tag" title="Это бот: им управляет программа его владельца">
                  БОТ
                </span>
              </span>
              <span className="dmf-sub">@{found.username}</span>
              {found.description && <span className="muted bot-hint add-bot-desc">{found.description}</span>}
              {!found.canAdd && <span className="bot-state off">{found.reason || 'Этого бота добавить нельзя'}</span>}
            </div>
          </div>
        ) : null}

        <div className="settings-group-label dmf-gap">Права бота</div>
        <div className="muted bot-hint">
          Бот получит свою роль с этими правами. Права, которых нет у вас, выдать нельзя; права администратора боту не
          выдаются.
        </div>
        <div className="perm-grid2 add-bot-perms">
          {PERMS.filter((p) => p.key !== 'ADMINISTRATOR').map(({ key, label, hint }) => (
            <div key={key} className="perm-toggle-row">
              <span>
                {label}
                <HelpDot label={`Что даёт право «${label}»`}>{hint}</HelpDot>
              </span>
              <Toggle
                checked={(perms & Permission[key]) === Permission[key]}
                disabled={busy || !canGive(Permission[key], key)}
                label={label}
                onChange={(v) => setPerms((p) => (v ? p | Permission[key] : p & ~Permission[key]))}
              />
            </div>
          ))}
        </div>

        <div className="bot-toggle-row">
          <span className="dmf-main">
            <span className="dmf-title" id="add-bot-read">
              Читать все сообщения
            </span>
            <span className="dmf-sub">{READ_ALL_HINT}</span>
          </span>
          <Toggle checked={readAll} disabled={busy} labelledBy="add-bot-read" onChange={setReadAll} />
        </div>

        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="link" onClick={onClose}>
            Отмена
          </button>
          <button type="button" disabled={busy || !found?.canAdd} onClick={() => void add()}>
            {busy ? '…' : 'Добавить'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
