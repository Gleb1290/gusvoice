import type { PermissionName, Role, ServerMemberInfo } from '@gusvoice/shared';
import { ALL_PERMISSIONS, isAdmin, normalizeLegacyPerms, Permission, permsFromString, PROTECTED_PERMISSIONS } from '@gusvoice/shared';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { api } from '../api';
import { confirmAction, confirmWithOption } from '../confirm';
import { usePhoneLayout } from '../phoneLayout';
import { useStore } from '../store';
import { RoleAppearancePicker } from './RoleAppearancePicker';
import { RolePeopleEditor, ServerPeopleDirectory } from './RolePeopleEditor';
import { Toggle } from './Toggle';
import './roles-editor.css';

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
export const PERMS: { key: PermissionName; label: string; hint: string }[] = [
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
    key: 'MANAGE_WEBHOOKS',
    label: 'Управление вебхуками',
    hint: 'Создавать и удалять вебхуки текстовых каналов — адреса, по которым внешние программы пишут в канал. Настройки канала → Вебхуки.',
  },
  {
    key: 'MANAGE_PREDICTIONS',
    label: 'Проводить ставки',
    hint: 'Заводить события для ставок ГусКоинами, закрывать приём и отменять чужие события с возвратом ставок. Итог события подводит только тот, кто его завёл. Ползунки экономики и выдачу монет право не даёт.',
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
    key: 'MENTION_EVERYONE',
    label: 'Упоминать @everyone, @here и все роли',
    hint: 'Участники с этим правом могут звать @everyone и @here (всех на канале) и любые роли, даже те, у которых выключено «Упоминаемая». Без права текст остаётся, но никого не уведомляет.',
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
export const isProtectedPerm = (key: PermissionName) => (Permission[key] & PROTECTED_PERMISSIONS) !== 0n;

type EditorTab = 'appearance' | 'permissions' | 'people';
type Draft = {
  name: string;
  color: number;
  perms: bigint;
  mentionable: boolean;
  membersCanAssign: boolean;
};
type LeaveGuard = (next: () => void) => void;

const EDITOR_TABS: { key: EditorTab; label: string }[] = [
  { key: 'appearance', label: 'Оформление' },
  { key: 'permissions', label: 'Права' },
  { key: 'people', label: 'Участники' },
];

const PERMISSION_GROUPS: { title: string; keys: PermissionName[] }[] = [
  { title: 'Общение', keys: ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES', 'MENTION_EVERYONE', 'CREATE_INVITE'] },
  { title: 'Голос и стрим', keys: ['CONNECT', 'SPEAK', 'VIDEO', 'SHARE_SCREEN', 'POKE_MEMBERS'] },
  { title: 'Модерация', keys: ['MANAGE_MESSAGES', 'KICK_MEMBERS', 'BAN_MEMBERS', 'MUTE_MEMBERS', 'MOVE_MEMBERS', 'MOVE_ANYONE', 'VIEW_AUDIT_LOG'] },
  { title: 'Управление сервером', keys: ['ADMINISTRATOR', 'MANAGE_SERVER', 'MANAGE_ROLES', 'MANAGE_CHANNELS', 'MANAGE_WEBHOOKS'] },
  { title: 'Игры и оформление', keys: ['MANAGE_PREDICTIONS', 'MANAGE_EMOJIS', 'MANAGE_STICKERS', 'MANAGE_SOUNDS', 'MANAGE_SOUNDBOARD'] },
];

const PERMISSION_ALIASES: Partial<Record<PermissionName, string>> = {
  SEND_MESSAGES: 'чат текст написать отправить',
  VIEW_CHANNEL: 'видимость доступ видеть',
  CONNECT: 'войти войс подключение',
  SPEAK: 'голос микрофон разговаривать',
  SHARE_SCREEN: 'стрим трансляция шеринг показ',
  VIDEO: 'видео вебка',
  MUTE_MEMBERS: 'мут заглушить',
  KICK_MEMBERS: 'кик исключить выгнать',
  BAN_MEMBERS: 'бан блокировка',
  MANAGE_SOUNDBOARD: 'звуковая панель набор звуков soundboard',
  MANAGE_PREDICTIONS: 'игры прогнозы предсказания',
};

const ADMIN_PERMISSIONS = Permission.ADMINISTRATOR | Permission.MANAGE_ROLES | Permission.MANAGE_SERVER;
const colorToHex = (n: number) => '#' + (n & 0xffffff).toString(16).padStart(6, '0');
const hasBit = (perms: bigint, bit: bigint) => (perms & bit) === bit;
const roleName = (role: Role) => role.isEveryone ? '@everyone' : role.name;
const searchWords = (query: string) => query.trim().toLowerCase().replaceAll('ё', 'е').split(/\s+/).filter(Boolean);
const matches = (words: string[], value: string) => {
  const normalized = value.toLowerCase().replaceAll('ё', 'е');
  return words.every((word) => normalized.includes(word));
};

function draftOf(role: Role): Draft {
  return {
    name: role.name,
    color: role.color,
    perms: normalizeLegacyPerms(BigInt(role.permissions)),
    mentionable: role.mentionable,
    membersCanAssign: role.membersCanAssign,
  };
}

export function ServerRolesPanel({
  serverId,
  ownerId,
  selfId,
  canManageRoles,
  canKick,
  view,
  initialRoleId,
  leaveGuard,
  catalogBack,
}: {
  serverId: string;
  ownerId: string;
  selfId: string;
  canManageRoles: boolean;
  canKick: boolean;
  view: 'roles' | 'members';
  /** «Права бота» открывают его роль сразу на вкладке прав. */
  initialRoleId?: string;
  leaveGuard?: MutableRefObject<LeaveGuard | null>;
  catalogBack?: MutableRefObject<(() => boolean) | null>;
}) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [members, setMembers] = useState<ServerMemberInfo[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [creation, setCreation] = useState<{ name: string; color: number } | null>(null);
  const [tab, setTab] = useState<EditorTab>('appearance');
  const [mobileDetail, setMobileDetail] = useState(!!initialRoleId);
  const [roleQuery, setRoleQuery] = useState('');
  const [permQuery, setPermQuery] = useState('');
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const leaving = useRef(false);
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const catalogHeading = useRef<HTMLLabelElement>(null);
  const catalogList = useRef<HTMLDivElement>(null);
  const catalogScroll = useRef(0);
  const focusTarget = useRef<'editor' | 'catalog' | null>(null);
  const phone = usePhoneLayout();
  const canGrantProtected = useStore((s) => !!s.user && (s.user.superAdmin || s.user.id === ownerId));
  const gamesShown = useStore((s) => s.user?.superAdmin === true);
  const actorPerms = permsFromString(useStore((s) => s.bootstrap?.permissions));
  const privileged = canGrantProtected || isAdmin(actorPerms);
  const actorRoleIds = members.find((member) => member.user.id === selfId)?.roleIds ?? [];
  const highest = privileged ? Infinity : Math.max(0, ...roles.filter((r) => actorRoleIds.includes(r.id)).map((r) => r.position));
  const selected = roles.find((r) => r.id === selId) ?? null;
  const systemRole = !!(selected?.isEveryone || selected?.isGuests);
  const botRole = !!selected?.managedBotId;
  const botHolder = botRole || !!selected && members.some((m) => m.user.bot && m.roleIds.includes(selected.id));
  const baseline = selected && draftOf(selected);
  const perms = draft?.perms ?? 0n;
  const roleHasAdminPerms = (perms & ADMIN_PERMISSIONS) !== 0n;
  const dirty = !!(creation ? creation.name || creation.color : draft && baseline && (
    draft.name !== baseline.name || draft.color !== baseline.color || draft.perms !== baseline.perms ||
    draft.mentionable !== baseline.mentionable || draft.membersCanAssign !== baseline.membersCanAssign
  ));
  const editBlock = !canManageRoles ? 'Нужно право «Управление ролями».'
    : selected && selected.position >= highest ? 'Эта роль выше вашей старшей роли или равна ей.'
    : null;
  // PATCH обрезает маску по правам автора. Не отправляем маску, если сервер при этом снимет чужое право.
  const preservedBits = canGrantProtected ? 0n : PROTECTED_PERMISSIONS;
  const grantableBits = (privileged ? ALL_PERMISSIONS : actorPerms) | preservedBits;
  const maskBlock = baseline && (baseline.perms & ~grantableBits) !== 0n
    ? 'У роли есть права, которые вы не можете выдавать. Изменение набора прав могло бы их снять.'
    : null;
  const systemNameWhy = systemRole ? 'Имя системной роли используется в правилах сервера.' : null;
  const assignmentWhy = systemRole ? 'Состав системной роли определяется сервером.'
    : botRole ? 'Управляемая роль назначается только её боту.' : null;
  const adminAssignWhy = roleHasAdminPerms ? 'Самовыдача недоступна роли с правами администратора, управления ролями или сервером.' : null;
  const sortableRoles = roles.filter((r) => !r.isEveryone).sort((a, b) => b.position - a.position);
  const displayRoles = [...sortableRoles, ...roles.filter((r) => r.isEveryone)];
  const roleWords = searchWords(roleQuery);
  const permWords = searchWords(permQuery);

  function refreshTree() {
    return useStore.getState().openServer(serverId);
  }

  async function refreshPeople() {
    setMembers(await api.listMembers(serverId));
    await refreshTree();
  }

  function selectRole(role: Role, nextTab: EditorTab = 'appearance') {
    setCreation(null);
    setSelId(role.id);
    setDraft(draftOf(role));
    setTab(nextTab);
    setPermQuery('');
    setError(null);
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([api.listRoles(serverId), api.listMembers(serverId)]).then(([roleList, people]) => {
      if (!active) return;
      setRoles(roleList);
      setMembers(people);
      const initial = roleList.find((r) => r.id === initialRoleId);
      const first = initial ?? [...roleList].sort((a, b) => b.position - a.position)[0];
      if (first) selectRole(first, initial ? 'permissions' : 'appearance');
      setMobileDetail(!!initial);
    }).catch((e: Error) => {
      if (active) setError(e.message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [serverId, initialRoleId]);

  useEffect(() => {
    if (focusTarget.current === 'editor') editorHeading.current?.focus();
    if (focusTarget.current === 'catalog') {
      if (catalogList.current) catalogList.current.scrollTop = catalogScroll.current;
      catalogHeading.current?.focus({ preventScroll: true });
    }
    focusTarget.current = null;
  }, [selId, mobileDetail, creation !== null]);

  function setPerms(update: (previous: bigint) => bigint) {
    setDraft((previous) => previous && { ...previous, perms: update(previous.perms) });
  }

  async function saveRole(): Promise<boolean> {
    if (!selected || !draft || !baseline || editBlock || busy || !draft.name.trim()) return false;
    const patch: Parameters<typeof api.updateRole>[1] = {};
    if (!systemRole && draft.name.trim() !== baseline.name) patch.name = draft.name.trim();
    if (draft.color !== baseline.color) patch.color = draft.color;
    if (draft.perms !== baseline.perms && !maskBlock) patch.permissions = draft.perms.toString();
    if (!assignmentWhy) {
      if (draft.mentionable !== baseline.mentionable) patch.mentionable = draft.mentionable;
      const membersCanAssign = draft.membersCanAssign && !roleHasAdminPerms;
      if (membersCanAssign !== baseline.membersCanAssign) patch.membersCanAssign = membersCanAssign;
    }
    setBusy(true);
    setError(null);
    try {
      if (Object.keys(patch).length) {
        const saved = await api.updateRole(selected.id, patch);
        setRoles((list) => list.map((r) => r.id === saved.id ? saved : r));
        setDraft(draftOf(saved));
        await refreshTree();
      } else {
        setDraft(baseline);
      }
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createRole(): Promise<boolean> {
    if (!creation?.name.trim() || !canManageRoles || busy) return false;
    setBusy(true);
    setError(null);
    try {
      const role = await api.createRole(serverId, { name: creation.name.trim(), color: creation.color });
      setRoles((list) => [...list, role]);
      setCreatedId(role.id);
      focusTarget.current = 'editor';
      selectRole(role);
      // При вставке под старшей ролью менеджера сервер может сдвинуть позиции соседей.
      setRoles(await api.listRoles(serverId));
      await refreshTree();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function resetDraft() {
    setError(null);
    setDraft(baseline);
    setCreation(null);
  }

  async function guardLeave(next: () => void) {
    if (busy || leaving.current) return;
    if (!dirty) {
      resetDraft();
      next();
      return;
    }
    const canSave = creation ? canManageRoles && !!creation.name.trim() : !editBlock && !!draft?.name.trim();
    leaving.current = true;
    try {
      const spec = { title: 'Есть несохранённые изменения', cancelLabel: 'Остаться' };
      const choice = canSave
        ? await confirmWithOption({
          ...spec,
          body: 'Снимите отметку, чтобы сбросить черновик.',
          confirmLabel: 'Продолжить',
          option: { label: creation ? 'Создать роль перед уходом' : 'Сохранить перед уходом', checked: true },
        })
        : await confirmAction({ ...spec, confirmLabel: 'Сбросить изменения' }).then((ok) => ok ? { option: false } : null);
      if (!choice) return;
      if (choice.option) {
        const saved = await (creation ? createRole() : saveRole());
        if (!saved) return;
      } else {
        resetDraft();
      }
      next();
    } finally {
      leaving.current = false;
    }
  }

  function closeDetail() {
    void guardLeave(() => {
      focusTarget.current = 'catalog';
      setMobileDetail(false);
    });
  }

  useEffect(() => {
    if (leaveGuard) leaveGuard.current = guardLeave;
    if (catalogBack) catalogBack.current = () => {
      if (!phone || !mobileDetail || view !== 'roles') return false;
      closeDetail();
      return true;
    };
    return () => {
      if (leaveGuard) leaveGuard.current = null;
      if (catalogBack) catalogBack.current = null;
    };
  });

  function showDetail() {
    if (!mobileDetail) catalogScroll.current = catalogList.current?.scrollTop ?? 0;
    focusTarget.current = 'editor';
    setMobileDetail(true);
  }

  function startCreation() {
    void guardLeave(() => {
      setCreation({ name: '', color: 0 });
      setCreatedId(null);
      showDetail();
    });
  }

  function reorderPlan(role: Role, offset: -1 | 1) {
    const index = sortableRoles.findIndex((entry) => entry.id === role.id);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= sortableRoles.length) return { reason: 'Край списка ролей.' } as const;
    const order = [...sortableRoles];
    [order[index], order[target]] = [order[target], order[index]];
    const changesHigherRole = order.some((entry, i) => {
      const position = order.length - i;
      return entry.position !== position && (entry.position >= highest || position >= highest);
    });
    if (changesHigherRole) return { reason: 'Нельзя менять порядок ролей на вашем уровне или выше.' } as const;
    return { ids: order.map((entry) => entry.id) } as const;
  }

  async function moveRole(ids: string[]) {
    setBusy(true);
    setError(null);
    try {
      await api.reorderRoles(serverId, ids);
      const reordered = await api.listRoles(serverId);
      const positions = new Map(reordered.map((role) => [role.id, role.position]));
      setRoles((current) => current.map((role) => ({ ...role, position: positions.get(role.id) ?? role.position })));
      await refreshTree();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function deleteRole(role: Role) {
    void guardLeave(async () => {
      const ok = await confirmAction({
        title: `Удалить роль «${role.name}»?`,
        body: 'Участники потеряют права, которые давала эта роль.',
        tone: 'danger',
        confirmLabel: 'Удалить роль',
      });
      if (!ok) return;
      setBusy(true);
      setError(null);
      try {
        await api.deleteRole(role.id);
        setRoles((list) => list.filter((entry) => entry.id !== role.id));
        setSelId(null);
        setDraft(null);
        focusTarget.current = 'catalog';
        setMobileDetail(false);
        await refreshTree();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    });
  }

  function permissionBlock(key: PermissionName) {
    if (editBlock) return editBlock;
    if (key === 'ADMINISTRATOR' && botHolder) return 'У бота не может быть права администратора.';
    if (isProtectedPerm(key) && !canGrantProtected) return 'Это право может менять только владелец сервера или супер-админ.';
    if (!privileged && !hasBit(actorPerms, Permission[key])) return 'У вас нет этого права для выдачи.';
    return maskBlock;
  }

  const permissionRows = PERMS.filter(({ key }) => gamesShown || key !== 'MANAGE_PREDICTIONS').map(({ key, label, hint }) => {
    const reason = permissionBlock(key);
    const id = `role-permission-${key}`;
    return {
      key,
      searchable: `${label} ${hint} ${PERMISSION_ALIASES[key] ?? ''}`,
      row: (
        <div className="role-editor-permission" key={key}>
          <div>
            <strong id={id}>{label}</strong>
            <p id={`${id}-help`}>{hint}{reason && <span className="role-editor-reason">{reason}</span>}</p>
          </div>
          <Toggle
            checked={hasBit(perms, Permission[key])}
            disabled={busy || !!reason}
            labelledBy={id}
            describedBy={`${id}-help`}
            onChange={(v) => setPerms((p) => v ? p | Permission[key] : p & ~Permission[key])}
          />
        </div>
      ),
    };
  });
  const visibleGroups = PERMISSION_GROUPS.map(({ title, keys }) => ({
    title,
    rows: permissionRows.filter(({ key, searchable }) => keys.includes(key) && matches(permWords, `${title} ${searchable}`)),
  })).filter(({ rows }) => rows.length > 0);

  const errorBox = error && <div className="error" role="alert">{error}</div>;
  if (view === 'members') {
    return (
      <div className="admin-scroll role-editor-directory" id="ss-panel-body" role="tabpanel" aria-labelledby="ss-tab-members">
        {errorBox}
        <ServerPeopleDirectory {...{ serverId, roles, members, selfId, ownerId, canManageRoles, canKick }} onChanged={refreshPeople} />
      </div>
    );
  }

  return (
    <div className="rail-fill role-editor" id="ss-panel-body" role="tabpanel" aria-labelledby="ss-tab-roles"
      data-detail={mobileDetail}>
      {errorBox}
      <div className="role-editor-layout">
        <section className="role-editor-catalog" aria-label="Каталог ролей">
          <div className="role-editor-catalog-header">
            <label className="field" ref={catalogHeading} tabIndex={-1}>
              Каталог ролей
              <input type="search" placeholder="Поиск по названию" value={roleQuery}
                onChange={(event) => setRoleQuery(event.target.value)} />
            </label>
            <small>Старшие роли вверху</small>
          </div>
          <div className="role-editor-list" ref={catalogList}>
            {displayRoles.filter((role) => matches(roleWords, roleName(role))).map((role) => {
              const count = role.managedBotId ? members.filter((m) => m.user.id === role.managedBotId).length : role.isGuests ? members.filter((m) => !!m.user.homeInstance).length
                : members.filter((m) => m.roleIds.includes(role.id)).length;
              const active = !creation && selected?.id === role.id;
              const details = [role.isGuests ? 'Системная роль' : role.managedBotId ? 'Роль бота' : '',
                role.isEveryone ? 'Все участники' : `Участники: ${count}`].filter(Boolean).join(' · ');
              return (
                <button key={role.id} type="button" className="role-editor-entry" aria-current={active ? 'true' : undefined}
                  onClick={() => {
                    if (active) {
                      showDetail();
                    } else {
                      void guardLeave(() => { selectRole(role); showDetail(); });
                    }
                  }}>
                  <span className="role-editor-dot" style={{ backgroundColor: role.color ? colorToHex(role.color) : undefined }} />
                  <span><strong>{roleName(role)}</strong><small>{details}</small></span>
                </button>
              );
            })}
            {!loading && !displayRoles.some((r) => matches(roleWords, roleName(r))) &&
              <p className="muted">{roleWords.length ? 'Роли не найдены.' : 'На сервере пока нет ролей.'}</p>}
          </div>
          {canManageRoles && <button type="button" className="btn primary" disabled={busy || loading} onClick={startCreation}>Создать роль</button>}
        </section>

        <section className="role-editor-editor" aria-label="Редактор роли">
          <header className="role-editor-header">
            <button type="button" className="btn role-editor-back" onClick={closeDetail}>‹ К ролям</button>
            <h3 tabIndex={-1} ref={editorHeading}>
              {creation ? 'Новая роль' : selected ? roleName(selected) : loading ? 'Загрузка ролей…' : 'Выберите роль'}
            </h3>
            {selected && !creation && (
              <nav className="role-editor-tabs" aria-label="Разделы редактора">
                {EDITOR_TABS.map(({ key, label }) => (
                  <button key={key} type="button" className="btn" aria-current={tab === key ? 'page' : undefined}
                    onClick={() => { setTab(key); setCreatedId(null); }}>{label}</button>
                ))}
              </nav>
            )}
          </header>

          <div className="role-editor-body" key={creation ? 'create' : `${selId}-${tab}`}>
            {creation ? (
              <>
                <label className="field">
                  Название роли
                  <input value={creation.name} maxLength={80} placeholder="Например, DJ" disabled={busy}
                    onChange={(e) => setCreation({ ...creation, name: e.target.value })} />
                </label>
                <RoleAppearancePicker color={creation.color} roleName={creation.name.trim() || 'Новая роль'}
                  disabled={busy} onChange={(color) => setCreation({ ...creation, color })} />
              </>
            ) : selected && draft && (
              <>
                {editBlock && tab !== 'people' && <p className="role-editor-notice">{editBlock}</p>}
                {createdId === selected.id && (
                  <div className="role-editor-notice role-editor-next">
                    <span>Роль создана</span>
                    <button type="button" className="btn" onClick={() => { setTab('permissions'); setCreatedId(null); }}>Настроить права</button>
                    <button type="button" className="btn" onClick={() => { setTab('people'); setCreatedId(null); }}>Добавить людей</button>
                  </div>
                )}
                {tab === 'appearance' && (
                  <>
                    <label className="field">
                      Название роли
                      <input value={draft.name} maxLength={80} disabled={busy || !!editBlock || systemRole}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                      {systemNameWhy && <small>{systemNameWhy}</small>}
                    </label>
                    <RoleAppearancePicker color={draft.color} roleName={draft.name} disabled={busy || !!editBlock}
                      onChange={(color) => setDraft({ ...draft, color })} />
                    <div className="role-editor-permission">
                      <div>
                        <strong id="role-mentionable">Упоминаемая роль</strong>
                        <p id="role-mentionable-help">{assignmentWhy || 'Упоминание @роли уведомляет её участников.'}</p>
                      </div>
                      <Toggle checked={draft.mentionable} disabled={busy || !!editBlock || !!assignmentWhy}
                        labelledBy="role-mentionable" describedBy="role-mentionable-help"
                        onChange={(mentionable) => setDraft({ ...draft, mentionable })} />
                    </div>
                    {canManageRoles && !selected.isEveryone && (
                      <div className="role-editor-order">
                        <span>Порядок роли</span>
                        {([-1, 1] as const).map((offset) => {
                          const plan = reorderPlan(selected, offset);
                          const label = offset === -1 ? 'Выше' : 'Ниже';
                          return <div key={offset}>
                            <button className="btn" type="button" disabled={busy || !plan.ids}
                              aria-describedby={plan.reason ? `role-order-${offset}` : undefined}
                              onClick={() => { if (plan.ids) void moveRole(plan.ids); }}>{label}</button>
                            {plan.reason && <small id={`role-order-${offset}`}>{plan.reason}</small>}
                          </div>;
                        })}
                      </div>
                    )}
                    {canManageRoles && (
                      <div className="role-editor-remove">
                        <button type="button" className="btn danger" onClick={() => deleteRole(selected)}
                          disabled={busy || !!editBlock || systemRole || botRole}>Удалить роль</button>
                        {(systemRole || botRole) && <small>{systemRole ? 'Системная роль нужна для правил сервера.' : 'Роль бота удаляется вместе с ботом.'}</small>}
                      </div>
                    )}
                  </>
                )}
                {tab === 'permissions' && (
                  <>
                    <div className="role-editor-permission">
                      <div>
                        <strong id="role-self-assign">Участники с этой ролью могут выдавать её другим</strong>
                        <p id="role-self-assign-help">{assignmentWhy || adminAssignWhy || 'Для выдачи достаточно иметь эту роль.'}</p>
                      </div>
                      <Toggle checked={draft.membersCanAssign && !roleHasAdminPerms}
                        disabled={busy || !!editBlock || !!assignmentWhy || !!adminAssignWhy}
                        labelledBy="role-self-assign" describedBy="role-self-assign-help"
                        onChange={(membersCanAssign) => setDraft({ ...draft, membersCanAssign })} />
                    </div>
                    <label className="field">
                      Поиск по правам
                      <input type="search" placeholder="Например, микрофон или стрим" value={permQuery}
                        onChange={(e) => setPermQuery(e.target.value)} />
                    </label>
                    {visibleGroups.length === 0 && <p className="muted">Права не найдены.</p>}
                    {visibleGroups.map(({ title, rows }) => (
                      <section className="role-editor-group" key={title}>
                        <h4>{title}</h4>
                        {rows.map(({ row }) => row)}
                      </section>
                    ))}
                  </>
                )}
                {tab === 'people' && (
                  <RolePeopleEditor {...{ serverId, role: selected, roles, members, selfId, ownerId, canManageRoles }} onChanged={refreshPeople} />
                )}
              </>
            )}
          </div>

          {(creation || dirty) && (
            <footer className="role-editor-actions">
              {!creation && <span role="status">Есть несохранённые изменения</span>}
              <button type="button" className="btn" disabled={busy} onClick={() => {
                if (creation && phone) {
                  focusTarget.current = 'catalog';
                  setMobileDetail(false);
                }
                resetDraft();
              }}>Отменить</button>
              <button type="button" className="btn primary" disabled={busy || (creation
                ? !creation.name.trim() || !canManageRoles
                : !!editBlock || !draft?.name.trim())}
                onClick={() => { void (creation ? createRole() : saveRole()); }}>
                {creation ? 'Создать роль' : 'Сохранить'}
              </button>
            </footer>
          )}
        </section>
      </div>
    </div>
  );
}
