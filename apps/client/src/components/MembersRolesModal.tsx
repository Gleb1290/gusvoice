import type { PermissionName, Role, ServerMemberInfo } from '@gusvoice/shared';
import { normalizeLegacyPerms, Permission, PROTECTED_PERMISSIONS } from '@gusvoice/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { tabListKeyDown, useDialogChrome } from '../dialogChrome';
import { useStore } from '../store';
import { Avatar } from './Avatar';
import { HelpDot } from './HelpDot';
import { Icon } from './Icon';
import { Toggle } from './Toggle';

const ROLE_COLORS = [0xf2b33d, 0x3fb97a, 0xe0574e, 0x3f7fb9, 0xc95e8c, 0x5e9c8c, 0x9c97a8, 0xb07ad8];

/**
 * Permissions offered in the UI, with a plain-language note for each — the labels alone don't say what
 * a right actually lets someone do, and a wrong guess here hands out server control by accident.
 *
 * Deliberately NOT listed (the bits stay defined in shared/permissions.ts — bit positions are stable
 * and old role masks still carry them):
 *  • DEAFEN_MEMBERS — no backend route exists, granting it did nothing.
 *  • PRIORITY_SPEAKER — only rides along in the LiveKit token metadata; nothing ducks anyone for it.
 *  • STREAM — the legacy camera+screen umbrella, superseded by VIDEO / SHARE_SCREEN. Roles that still
 *    carry it keep working (canPublishCamera/canPublishScreen honour it), and `normalizeLegacyPerms`
 *    (shared/permissions.ts) swaps it for the modern pair as soon as a role is opened, so it fades
 *    out instead of lingering.
 */
const PERMS: { key: PermissionName; label: string; hint: string }[] = [
  {
    key: 'ADMINISTRATOR',
    label: 'Администратор — все права',
    hint: 'Все права сразу, включая те, что появятся позже, и в обход запретов на отдельных каналах. Выдавай только тем, кому доверяешь сервер целиком.',
  },
  {
    key: 'MANAGE_SERVER',
    label: 'Управление сервером',
    hint: 'Менять имя и иконку сервера, его настройки.',
  },
  {
    key: 'MANAGE_ROLES',
    label: 'Управление ролями',
    hint: 'Создавать, менять, удалять роли и выдавать их участникам — но только роли НИЖЕ своей старшей, и нельзя выдать право, которого нет у самого.',
  },
  {
    key: 'MANAGE_CHANNELS',
    label: 'Управление каналами',
    hint: 'Создавать, переименовывать, двигать и удалять каналы и категории, настраивать вкладку «Доступ» у них.',
  },
  {
    key: 'MANAGE_SOUNDS',
    label: 'Управление звуками канала',
    hint: 'Заменять звуки уведомлений сервера и каналов (вход, выход, сообщение) на свои файлы.',
  },
  {
    key: 'MANAGE_SOUNDBOARD',
    label: 'Управление саундбордом',
    hint: 'Добавлять и удалять звуки саундборда сервера. Настройки сервера → Саундборд. Проигрывать их в канале может любой — за монеты.',
  },
  {
    key: 'MANAGE_EMOJIS',
    label: 'Управление эмодзи',
    hint: 'Загружать и удалять свои эмодзи сервера. Настройки сервера → Эмодзи.',
  },
  {
    key: 'MANAGE_STICKERS',
    label: 'Управление стикерами',
    hint: 'Импортировать наборы стикеров из Telegram и удалять их. Настройки сервера → Стикеры.',
  },
  {
    key: 'VIEW_AUDIT_LOG',
    label: 'Просмотр журнала аудита',
    hint: 'Открывать журнал действий: кто выдавал роли, кикал, менял каналы. Настройки сервера → Журнал.',
  },
  {
    key: 'KICK_MEMBERS',
    label: 'Кикать участников',
    hint: 'Удалять с сервера. Кикнутый может вернуться по новому приглашению. Владельца и тех, кто старше по ролям, кикнуть нельзя.',
  },
  {
    key: 'BAN_MEMBERS',
    label: 'Банить участников',
    hint: 'Блокировать участника — в отличие от кика, по приглашению он уже не вернётся.',
  },
  {
    key: 'CREATE_INVITE',
    label: 'Создавать приглашения',
    hint: 'Делать ссылки-приглашения на сервер.',
  },
  {
    key: 'VIEW_CHANNEL',
    label: 'Просматривать каналы',
    hint: 'Видеть каналы в списке. Без этого права канала для участника просто не существует.',
  },
  {
    key: 'READ_HISTORY',
    label: 'Читать историю сообщений',
    hint: 'Видеть сообщения, написанные до его прихода. Без права виден только новый поток.',
  },
  { key: 'SEND_MESSAGES', label: 'Писать сообщения', hint: 'Отправлять сообщения и вложения в текстовые каналы.' },
  {
    key: 'MANAGE_MESSAGES',
    label: 'Удалять чужие сообщения',
    hint: 'Удалять сообщения других участников (свои можно удалять всегда).',
  },
  {
    key: 'CONNECT',
    label: 'Подключаться к голосу',
    hint: 'Заходить в голосовые каналы. Само по себе даёт только слушать — говорить разрешает «Говорить».',
  },
  { key: 'SPEAK', label: 'Говорить', hint: 'Включать микрофон в голосовом канале. Без права — только слушать.' },
  { key: 'VIDEO', label: 'Камера', hint: 'Включать камеру в голосовом канале.' },
  {
    key: 'SHARE_SCREEN',
    label: 'Демонстрация экрана',
    hint: 'Показывать экран, окно или камеру как стрим.',
  },
  {
    key: 'MUTE_MEMBERS',
    label: 'Мьютить других в голосовом канале',
    hint: 'Выключать чужой микрофон на сервере. Нельзя применить к владельцу и к тем, кто старше по ролям.',
  },
  {
    key: 'MOVE_MEMBERS',
    label: 'Перемещать между голосовыми',
    hint: 'Переносить участников в другой голосовой канал и отключать их от голоса. В целевом канале участнику нужно право «Подключаться к голосу».',
  },
  {
    key: 'MOVE_ANYONE',
    label: 'Перемещать КОГО УГОДНО',
    hint: 'Снимает защиту по старшинству ролей — эта роль может перетаскивать между голосовыми даже владельца сервера. Мьютить и отключать от голоса старших по-прежнему нельзя. Выдать это право может ТОЛЬКО владелец сервера (или супер-админ) — даже администратор не может выдать его себе сам.',
  },
  {
    key: 'POKE_MEMBERS',
    label: 'Тыкать в голосовом канале',
    hint: 'Отправить человеку, сидящему в голосовом канале, короткое «ткнуть» — у него всплывёт окно со звуком. По умолчанию доступно всем; снимай у тех, кто этим злоупотребляет.',
  },
];

/** Права, которые видны всем, но переключаются только владельцем сервера (см. PROTECTED_PERMISSIONS). */
const isProtectedPerm = (key: PermissionName) => (Permission[key] & PROTECTED_PERMISSIONS) !== 0n;

const colorToHex = (n: number) => '#' + (n & 0xffffff).toString(16).padStart(6, '0');
const hasBit = (perms: bigint, bit: bigint) => (perms & bit) === bit;

export function MembersRolesModal({
  serverId,
  ownerId,
  selfId,
  canManageRoles,
  canKick,
  onClose,
}: {
  serverId: string;
  ownerId: string;
  selfId: string;
  canManageRoles: boolean;
  canKick: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'roles' | 'members'>('roles');
  const dialogRef = useDialogChrome<HTMLDivElement>(onClose);
  const onTabsKey = tabListKeyDown(['roles', 'members'] as const, tab, setTab, (k) => `mr-tab-${k}`);
  const [roles, setRoles] = useState<Role[]>([]);
  const [members, setMembers] = useState<ServerMemberInfo[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState(0);
  const [perms, setPerms] = useState(0n);
  const [mentionable, setMentionable] = useState(false);
  const [membersCanAssign, setMembersCanAssign] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Защищённые права (MOVE_ANYONE) выдаёт ТОЛЬКО владелец сервера или супер-админ — бэкенд их иначе
  // просто не примет (`clampGrant` оставит прежнее значение), поэтому и тумблер здесь заперт.
  const canGrantProtected = useStore((s) => !!s.user && (s.user.superAdmin || s.user.id === ownerId));

  const refreshTree = () => useStore.getState().openServer(serverId);

  async function load() {
    setError(null);
    try {
      const [r, m] = await Promise.all([api.listRoles(serverId), api.listMembers(serverId)]);
      setRoles(r);
      setMembers(m);
      if (!selId && r.length) selectRole(r[0]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectRole(r: Role) {
    setSelId(r.id);
    setName(r.name);
    setColor(r.color);
    setPerms(normalizeLegacyPerms(BigInt(r.permissions)));
    setMentionable(r.mentionable);
    setMembersCanAssign(r.membersCanAssign);
  }

  const selected = roles.find((r) => r.id === selId) ?? null;
  // A self-service role must not carry admin-level perms (the backend rejects it) — disable the toggle.
  const roleHasAdminPerms =
    hasBit(perms, Permission.ADMINISTRATOR) || hasBit(perms, Permission.MANAGE_ROLES) || hasBit(perms, Permission.MANAGE_SERVER);
  const roleMembers = selected && !selected.isEveryone ? members.filter((m) => m.roleIds.includes(selected.id)) : [];
  const roleNonMembers = selected && !selected.isEveryone ? members.filter((m) => !m.roleIds.includes(selected.id)) : [];

  // Display highest-first ("выше = больше прав"); @everyone always sits at the bottom.
  const sortableRoles = roles.filter((r) => !r.isEveryone).sort((a, b) => b.position - a.position);
  const displayRoles = [...sortableRoles, ...roles.filter((r) => r.isEveryone)];

  async function moveRole(roleId: string, dir: -1 | 1) {
    const order = sortableRoles.map((r) => r.id);
    const idx = order.indexOf(roleId);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= order.length) return;
    [order[idx], order[j]] = [order[j], order[idx]];
    setBusy(true);
    setError(null);
    try {
      await api.reorderRoles(serverId, order);
      setRoles(await api.listRoles(serverId));
      await refreshTree();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveRole() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateRole(selected.id, {
        name: name.trim(),
        color,
        permissions: perms.toString(),
        mentionable,
        membersCanAssign: membersCanAssign && !roleHasAdminPerms,
      });
      const r = await api.listRoles(serverId);
      setRoles(r);
      await refreshTree();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function createRole() {
    setBusy(true);
    setError(null);
    try {
      const role = await api.createRole(serverId, { name: 'новая роль' });
      const r = await api.listRoles(serverId);
      setRoles(r);
      selectRole(role);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteRole(r: Role) {
    if (!confirm(`Удалить роль «${r.name}»?`)) return;
    setBusy(true);
    try {
      await api.deleteRole(r.id);
      const list = await api.listRoles(serverId);
      setRoles(list);
      setSelId(list[0]?.id ?? null);
      if (list[0]) selectRole(list[0]);
      await refreshTree();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleMemberRole(userId: string, roleId: string, add: boolean) {
    setBusy(true);
    try {
      if (add) await api.assignRole(serverId, userId, roleId);
      else await api.unassignRole(serverId, userId, roleId);
      setMembers(await api.listMembers(serverId));
      await refreshTree();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function kick(userId: string, label: string) {
    if (!confirm(`Кикнуть ${label} с сервера?`)) return;
    setBusy(true);
    try {
      await api.kickMember(serverId, userId);
      setMembers(await api.listMembers(serverId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const assignableRoles = roles.filter((r) => !r.isEveryone);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal admin"
        onClick={(e) => e.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mr-title"
        tabIndex={-1}
      >
        <div className="admin-head">
          <h2 id="mr-title">Роли и участники</h2>
          <button type="button" className="icon-close" title="Закрыть" aria-label="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="admin-tabs" role="tablist" aria-label="Роли и участники" onKeyDown={onTabsKey}>
          <button
            type="button"
            role="tab"
            id="mr-tab-roles"
            aria-selected={tab === 'roles'}
            aria-controls="mr-panel"
            tabIndex={tab === 'roles' ? 0 : -1}
            className={tab === 'roles' ? 'active' : ''}
            onClick={() => setTab('roles')}
          >
            Роли ({roles.length})
          </button>
          <button
            type="button"
            role="tab"
            id="mr-tab-members"
            aria-selected={tab === 'members'}
            aria-controls="mr-panel"
            tabIndex={tab === 'members' ? 0 : -1}
            className={tab === 'members' ? 'active' : ''}
            onClick={() => setTab('members')}
          >
            Участники ({members.length})
          </button>
        </div>

        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}

        {tab === 'roles' ? (
          <>
          {/* Was a collapsed <details> — the explanation nobody opened. Same text, one hover away. */}
          <div className="settings-group-label">
            Роли сервера
            <HelpDot label="Как работают роли">
              <ul>
                <li>
                  У участника может быть несколько ролей — права <b>складываются</b>. <b>@everyone</b> — базовая
                  роль для всех.
                </li>
                <li>
                  Роли упорядочены по старшинству. Управлять (выдавать / редактировать / удалять) можно только
                  ролями <b>ниже своей</b> самой старшей, и нельзя выдать право, которого <b>нет у тебя</b>.
                </li>
                <li>
                  <b>Администратор</b> = все права. <b>Владелец</b> сервера может всё.
                </li>
                <li>
                  Доступ к конкретным каналам — отдельно, вкладка <b>«Доступ»</b> у канала/категории
                  (переопределяет права роли).
                </li>
              </ul>
            </HelpDot>
          </div>
          <div className="roles-editor" id="mr-panel" role="tabpanel" aria-labelledby="mr-tab-roles">
            <div className="roles-list">
              {displayRoles.map((r, i) => (
                <div key={r.id} className={`role-item-row ${r.id === selId ? 'active' : ''}`}>
                  <button type="button" className="role-item" onClick={() => selectRole(r)}>
                    <span className="role-dot" style={{ background: r.color ? colorToHex(r.color) : '#888' }} />
                    {r.isEveryone ? '@everyone' : r.name}
                  </button>
                  {canManageRoles && !r.isEveryone && (
                    <span className="role-reorder">
                      <button type="button" title="Выше" disabled={busy || i === 0} onClick={() => void moveRole(r.id, -1)}>
                        ↑
                      </button>
                      <button type="button" title="Ниже" disabled={busy || i === sortableRoles.length - 1} onClick={() => void moveRole(r.id, 1)}>
                        ↓
                      </button>
                    </span>
                  )}
                </div>
              ))}
              {canManageRoles && (
                <button type="button" className="role-item add" onClick={createRole} disabled={busy}>
                  + Создать роль
                </button>
              )}
            </div>

            <div className="role-detail">
              {!selected ? (
                <div className="muted">Выбери роль слева</div>
              ) : (
                <>
                  <label className="field">
                    Название
                    <input value={name} onChange={(e) => setName(e.target.value)} disabled={!canManageRoles || selected.isEveryone} />
                  </label>

                  <div className="field" style={{ gap: 8 }}>
                    Цвет
                    <div className="color-swatches">
                      {ROLE_COLORS.map((c) => (
                        <button
                          type="button"
                          key={c}
                          className={`swatch ${color === c ? 'sel' : ''}`}
                          style={{ background: colorToHex(c) }}
                          disabled={!canManageRoles}
                          onClick={() => setColor(c)}
                          aria-label={colorToHex(c)}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="perm-toggle-row">
                    <span>Упоминаемая — @роль уведомляет участников</span>
                    <Toggle
                      checked={mentionable}
                      disabled={!canManageRoles || selected.isEveryone}
                      onChange={setMentionable}
                    />
                  </div>

                  <div className="perm-toggle-row">
                    <span>
                      Самовыдача — участники с этой ролью могут выдавать её другим (без права модератора)
                      {roleHasAdminPerms && (
                        <em style={{ display: 'block', color: 'var(--muted)', fontStyle: 'normal', fontSize: 12 }}>
                          недоступно для ролей с админ-правами
                        </em>
                      )}
                    </span>
                    <Toggle
                      checked={membersCanAssign && !roleHasAdminPerms}
                      disabled={!canManageRoles || selected.isEveryone || roleHasAdminPerms}
                      onChange={setMembersCanAssign}
                    />
                  </div>

                  <div className="perm-grid2">
                    {PERMS.map(({ key, label, hint }) => (
                      <div key={key} className="perm-toggle-row">
                        <span>
                          {label}
                          <HelpDot label={`Что даёт право «${label}»`}>{hint}</HelpDot>
                        </span>
                        <Toggle
                          checked={hasBit(perms, Permission[key])}
                          disabled={!canManageRoles || (isProtectedPerm(key) && !canGrantProtected)}
                          label={label}
                          onChange={(v) => setPerms((p) => (v ? p | Permission[key] : p & ~Permission[key]))}
                        />
                      </div>
                    ))}
                  </div>

                  {!selected.isEveryone && (
                    <div className="role-members">
                      <div className="cat-name">Участники роли · {roleMembers.length}</div>
                      <div className="role-mchips">
                        {roleMembers.map((m) => (
                          <span
                            key={m.user.id}
                            className="role-mchip"
                            style={{ borderColor: selected.color ? colorToHex(selected.color) : '#888' }}
                          >
                            <Avatar url={m.user.avatarUrl} name={m.user.displayName} size={18} />
                            {m.user.displayName}
                            {canManageRoles && (
                              <button type="button" onClick={() => toggleMemberRole(m.user.id, selected.id, false)} disabled={busy}>
                                ×
                              </button>
                            )}
                          </span>
                        ))}
                        {roleMembers.length === 0 && <span className="muted">пока никого нет в этой роли</span>}
                      </div>
                      {canManageRoles && roleNonMembers.length > 0 && (
                        <select
                          value=""
                          disabled={busy}
                          onChange={(e) => e.target.value && toggleMemberRole(e.target.value, selected.id, true)}
                        >
                          <option value="">+ добавить участника в роль</option>
                          {roleNonMembers.map((m) => (
                            <option key={m.user.id} value={m.user.id}>
                              {m.user.displayName}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}

                  {canManageRoles && (
                    <div className="modal-actions">
                      {!selected.isEveryone && (
                        <button type="button" className="danger-text" onClick={() => deleteRole(selected)} disabled={busy}>
                          Удалить роль
                        </button>
                      )}
                      <div style={{ flex: 1 }} />
                      <button type="button" onClick={saveRole} disabled={busy}>
                        Сохранить
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
          </>
        ) : (
          <div className="admin-scroll" id="mr-panel" role="tabpanel" aria-labelledby="mr-tab-members">
            <div className="settings-group-label">
              Участники
              <HelpDot label="Как выдавать роли">
                <ul>
                  <li>
                    Роль выдаётся кнопкой <b>«+ роль»</b> в строке участника, снимается <b>×</b> на самой роли.
                  </li>
                  <li>
                    Права участника = сумма прав всех его ролей плюс <b>@everyone</b>. Запретить что-то одной
                    ролью, если другая это разрешает, нельзя — для этого есть вкладка <b>«Доступ»</b> у канала.
                  </li>
                  <li>
                    Выдавать можно только роли <b>ниже своей</b> самой старшей. <b>Владельца</b> сервера нельзя
                    кикнуть и его роли не редактируются.
                  </li>
                </ul>
              </HelpDot>
            </div>
            <ul className="member-list">
              {members.map((m) => {
                const isOwner = m.user.id === ownerId;
                const myRoles = m.roleIds.map((id) => roles.find((r) => r.id === id)).filter(Boolean) as Role[];
                const addable = assignableRoles.filter((r) => !m.roleIds.includes(r.id));
                return (
                  <li key={m.user.id} className="member-row">
                    <Avatar url={m.user.avatarUrl} name={m.user.displayName} size={36} />
                    <div className="member-main">
                      <div>
                        {m.user.displayName} <span className="muted">@{m.user.username}</span>
                        {isOwner && <span className="badge" style={{ marginLeft: 6 }}>owner</span>}
                      </div>
                      <div className="role-chips">
                        {myRoles.map((r) => (
                          <span key={r.id} className="role-chip" style={{ borderColor: r.color ? colorToHex(r.color) : '#888' }}>
                            {r.name}
                            {canManageRoles && (
                              <button type="button" onClick={() => toggleMemberRole(m.user.id, r.id, false)} disabled={busy}>
                                ×
                              </button>
                            )}
                          </span>
                        ))}
                        {canManageRoles && addable.length > 0 && (
                          <select
                            value=""
                            disabled={busy}
                            onChange={(e) => e.target.value && toggleMemberRole(m.user.id, e.target.value, true)}
                          >
                            <option value="">+ роль</option>
                            {addable.map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.name}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    </div>
                    {canKick && !isOwner && m.user.id !== selfId && (
                      <button type="button" className="danger-text" onClick={() => kick(m.user.id, m.user.displayName)} disabled={busy}>
                        кик
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
