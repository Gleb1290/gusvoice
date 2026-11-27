import { isAdmin, permsFromString, type Role, type ServerMemberInfo } from '@gusvoice/shared';
import { useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { confirmAction } from '../confirm';
import { useStore } from '../store';
import { Avatar } from './Avatar';
import './role-people.css';

type PeopleProps = {
  serverId: string;
  roles: Role[];
  members: ServerMemberInfo[];
  selfId: string;
  ownerId: string;
  canManageRoles: boolean;
  onChanged: () => Promise<void>;
};

type Change = { member: ServerMemberInfo; role: Role; add: boolean };
type Choice = { change: Change; label: ReactNode; selected: boolean; blocked?: string; detail?: string };

const nameOf = (member: ServerMemberInfo) => member.nickname || member.user.displayName || member.user.username;
const changeKey = ({ member, role }: Change) => JSON.stringify([member.user.id, role.id]);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function matches(member: ServerMemberInfo, query: string) {
  const needle = query.trim().replace(/^@/, '').toLocaleLowerCase();
  return [member.nickname, member.user.displayName, member.user.username]
    .some((value) => value?.toLocaleLowerCase().includes(needle));
}

function effectiveRoles(roles: Role[], ids: string[], guest: boolean) {
  const base = (guest ? roles.find((role) => role.isGuests) : undefined) ?? roles.find((role) => role.isEveryone);
  return roles.filter((role) => role.id === base?.id || ids.includes(role.id));
}

function highest(roles: Role[], bot: boolean) {
  if (!bot && roles.some((role) => isAdmin(permsFromString(role.permissions)))) return Infinity;
  return roles.reduce((position, role) => Math.max(position, role.position), 0);
}

function roleAccess(props: PeopleProps, actor?: ActorSnapshot) {
  const self = props.members.find((member) => member.user.id === props.selfId);
  const ids = actor?.roleIds ?? self?.roleIds ?? [];
  const actorBot = actor?.bot ?? !!self?.user.bot;
  const actorRoles = effectiveRoles(props.roles, ids, actor?.guest ?? !!self?.user.homeInstance);
  const top = !actorBot && (props.selfId === props.ownerId || actor?.admin)
    ? Infinity
    : actor || self ? highest(actorRoles, actorBot) : 0;
  return { ids, actorBot, top, manager: props.canManageRoles };
}

type ActorSnapshot = { roleIds: string[]; guest: boolean; bot: boolean; admin: boolean };

function blockedChange({ member, role, add }: Change, access: ReturnType<typeof roleAccess>) {
  if (role.isEveryone || role.isGuests) return 'Системная роль применяется автоматически';
  if (role.managedBotId) return 'Роль управляется сервером для бота';
  if (add && (access.actorBot || member.user.bot) && isAdmin(permsFromString(role.permissions))) {
    return 'Боту нельзя назначить роль администратора';
  }
  const delegated = role.membersCanAssign && access.ids.includes(role.id);
  if (add && delegated) return;
  if (!access.manager) return !add && delegated ? 'Снять роль может только модератор' : 'Нет права управлять ролями';
  if (role.position >= access.top) return 'Роль на вашем уровне или выше';
}

function MemberName({ member }: { member: ServerMemberInfo }) {
  return (
    <span className="role-people__person">
      <Avatar name={nameOf(member)} url={member.user.avatarUrl} size={28} />
      <span>
        <strong>{nameOf(member)}</strong>
        <small>@{member.user.username}{member.user.bot ? ' · Бот' : ''}{member.user.homeInstance ? ' · Гость' : ''}</small>
      </span>
    </span>
  );
}

function useRoleChanges({ serverId, members, onChanged }: PeopleProps) {
  const [saved, setSaved] = useState<{ source: ServerMemberInfo[]; values: Map<string, boolean> }>();
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [notice, setNotice] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const running = useRef(false);
  const snapshot = saved?.source === members ? saved.values : undefined;
  const hasRole = (member: ServerMemberInfo, role: Role) =>
    snapshot?.get(changeKey({ member, role, add: true })) ?? member.roleIds.includes(role.id);

  async function refresh() {
    try {
      await onChanged();
      setRefreshError('');
    } catch (error) {
      setRefreshError(`Не удалось обновить список. ${errorText(error)}`);
    }
  }

  async function apply(changes: Change[]) {
    if (running.current || changes.length === 0) return [];
    running.current = true;
    setBusy(true);
    setErrors(new Map());
    setNotice('');
    const failed = new Map<string, string>();
    const succeeded: string[] = [];
    const next = new Map(snapshot);
    try {
      for (const change of changes) {
        const { member, role, add } = change;
        const key = changeKey(change);
        try {
          if (add) await api.assignRole(serverId, member.user.id, role.id);
          else await api.unassignRole(serverId, member.user.id, role.id);
          next.set(key, add);
          succeeded.push(key);
        } catch (error) {
          failed.set(key, errorText(error));
        }
      }
      setErrors(failed);
      if (succeeded.length) setSaved({ source: members, values: next });
      setNotice(`Сохранено: ${succeeded.length}. Не удалось: ${failed.size}.`);
      await refresh();
      return succeeded;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function retryRefresh() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setNotice('');
    try {
      await refresh();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  function resetFeedback() {
    setErrors(new Map());
    setNotice('');
  }

  return { hasRole, busy, errors, notice, refreshError, apply, retryRefresh, resetFeedback };
}

function ChangeFeedback({ changes }: { changes: ReturnType<typeof useRoleChanges> }) {
  return (
    <>
      {changes.notice && <p className="role-people__notice" role="status">{changes.notice}</p>}
      {changes.refreshError && <p role="alert">{changes.refreshError}</p>}
      {changes.refreshError && (
        <button type="button" className="role-people__button" disabled={changes.busy} onClick={() => void changes.retryRefresh()}>
          Обновить список
        </button>
      )}
    </>
  );
}

function ChoiceRow({ choice, busy, error, onToggle }: {
  choice: Choice;
  busy: boolean;
  error?: string;
  onToggle: () => void;
}) {
  return (
    <label className="role-people__choice">
      <input type="checkbox" checked={choice.selected} disabled={busy || !!choice.blocked} onChange={onToggle} />
      <span className="role-people__choice-text">
        {choice.label}
        {choice.detail && <small>{choice.detail}</small>}
        {choice.blocked && <small>{choice.blocked}</small>}
        {error && <small className="role-people__error" role="alert">{error}</small>}
      </span>
    </label>
  );
}

export function RolePeopleEditor(props: PeopleProps & { role: Role }) {
  return <RoleComposition key={JSON.stringify([props.serverId, props.role.id, props.selfId])} {...props} />;
}

function useActor(props: PeopleProps): ActorSnapshot | undefined {
  const admin = useStore((s) => s.user?.id === props.selfId && s.user.superAdmin === true);
  const self = props.members.find((member) => member.user.id === props.selfId);
  if (!admin) return;
  return { admin, roleIds: self?.roleIds ?? [], guest: !!self?.user.homeInstance, bot: !!self?.user.bot };
}

function RoleComposition(props: PeopleProps & { role: Role }) {
  const { role, members } = props;
  const access = roleAccess(props, useActor(props));
  const changes = useRoleChanges(props);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const managed = role.isEveryone || role.isGuests || !!role.managedBotId;
  const inRole = (member: ServerMemberInfo) => role.isEveryone
    || (role.isGuests ? !!member.user.homeInstance
      : role.managedBotId ? role.managedBotId === member.user.id : changes.hasRole(member, role));
  const people = members.filter(inRole);
  const candidates = managed ? [] : members.filter((member) => !inRole(member)).map((member) => {
    const change = { member, role, add: true };
    return { change, label: <MemberName member={member} />, selected: draft.has(changeKey(change)), blocked: blockedChange(change, access) };
  });
  const pending = candidates.filter((choice) => choice.selected && !choice.blocked);
  const canAdd = candidates.some((choice) => !choice.blocked);
  const addBlock = !canAdd && candidates.length > 0 ? candidates[0].blocked : undefined;

  async function addSelected() {
    const succeeded = await changes.apply(pending.map((choice) => choice.change));
    setDraft((previous) => new Set([...previous].filter((key) => !succeeded.includes(key))));
  }

  return (
    <section className="role-people" aria-label="Состав роли">
      <div className="role-people__toolbar">
        <strong>{role.isEveryone ? 'Все участники' : `Участники · ${people.length}`}</strong>
        <input aria-label="Поиск участников" placeholder="Имя или @логин" value={query}
          onChange={(event) => setQuery(event.target.value)} />
      </div>
      {managed && <p className="muted">{role.managedBotId ? 'Роль закреплена за ботом.' : 'Роль применяется автоматически.'}</p>}
      <ul className="role-people__list">
        {people.filter((member) => matches(member, query)).map((member) => {
          const change = { member, role, add: false };
          const blocked = blockedChange(change, access);
          const error = changes.errors.get(changeKey(change));
          return (
            <li className="role-people__row" key={member.user.id}>
              <MemberName member={member} />
              {!managed && (blocked ? <small className="muted">{blocked}</small> : (
                <button type="button" className="role-people__button" disabled={changes.busy || adding}
                  aria-label={`Снять роль у ${nameOf(member)}`}
                  onClick={() => void changes.apply([change])}>{error ? 'Повторить снятие' : 'Снять роль'}</button>
              ))}
              {error && <small className="role-people__error" role="alert">{error}</small>}
            </li>
          );
        })}
      </ul>
      {people.length === 0 ? <p className="muted">В роли пока никого нет.</p>
        : !people.some((member) => matches(member, query)) && <p className="muted">В составе роли ничего не найдено.</p>}
      {!adding && canAdd && (
        <button type="button" className="role-people__button" disabled={changes.busy} onClick={() => setAdding(true)}>Добавить людей</button>
      )}
      {!adding && addBlock && <p className="muted">{addBlock}</p>}
      {adding && (
        <div className="role-people__picker" aria-label="Добавить людей">
          <strong>Добавить людей</strong>
          <div className="role-people__choices">
            {candidates.filter(({ change }) => matches(change.member, query)).map((choice) => {
              const key = changeKey(choice.change);
              return <ChoiceRow key={key} choice={choice} busy={changes.busy} error={changes.errors.get(key)}
                onToggle={() => setDraft((previous) => {
                  const next = new Set(previous);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })} />;
            })}
            {!candidates.some(({ change }) => matches(change.member, query)) && <p className="muted">Кандидатов не найдено.</p>}
          </div>
          <div className="role-people__actions">
            <button type="button" className="role-people__button role-people__button--primary" disabled={changes.busy || pending.length === 0}
              onClick={() => void addSelected()}>
              {changes.errors.size ? 'Повторить добавление' : 'Добавить участников'} · {pending.length}
            </button>
            <button type="button" className="role-people__button" disabled={changes.busy} onClick={() => {
              setAdding(false);
              setDraft(new Set());
              changes.resetFeedback();
            }}>{draft.size ? 'Отменить выбор' : 'Закрыть'}</button>
          </div>
        </div>
      )}
      <ChangeFeedback changes={changes} />
    </section>
  );
}

type MemberPickerProps = PeopleProps & { member: ServerMemberInfo; actor?: ActorSnapshot; onClose: () => void };

export function MemberRolePicker({ member, actor, onClose, ...props }: MemberPickerProps) {
  return <MemberRoleChoices {...props} member={member} actor={actor} onClose={onClose} changes={useRoleChanges(props)} />;
}

function MemberRoleChoices({ member, actor, onClose, changes, ...props }: MemberPickerProps & {
  changes: ReturnType<typeof useRoleChanges>;
}) {
  const [draft, setDraft] = useState<Map<string, boolean>>(new Map());
  const access = roleAccess(props, actor);
  const effective = effectiveRoles(props.roles, member.roleIds, !!member.user.homeInstance);
  const choices = props.roles.slice().sort((a, b) => b.position - a.position).flatMap((role): Choice[] => {
    const automatic = role.isEveryone || role.isGuests || !!role.managedBotId;
    const had = automatic ? effective.some((entry) => entry.id === role.id) || role.managedBotId === member.user.id
      : changes.hasRole(member, role);
    const change = { member, role, add: !had };
    const blocked = blockedChange(change, access);
    if (!had && automatic) return [];
    if (!had && !access.manager && !access.ids.includes(role.id)) return [];
    return [{ change, label: role.name, selected: draft.get(role.id) ?? had, blocked,
      detail: had ? 'Назначена' : '' }];
  });
  const pending = choices.filter(({ change, selected, blocked }) => !blocked && selected === change.add);
  const remainingFailures = pending.some(({ change }) => changes.errors.has(changeKey(change)));

  async function apply() {
    const succeeded = new Set(await changes.apply(pending.map(({ change }) => change)));
    setDraft((previous) => {
      const next = new Map(previous);
      for (const { change } of pending) if (succeeded.has(changeKey(change))) next.delete(change.role.id);
      return next;
    });
  }

  return (
    <section className="role-people role-people__picker" aria-label={`Роли · ${nameOf(member)}`}>
      <strong>Роли · {nameOf(member)}</strong>
      <div className="role-people__choices">
        {choices.length === 0 && <p className="muted">Нет доступных ролей.</p>}
        {choices.map((choice) => {
          const { role } = choice.change;
          return <ChoiceRow key={role.id} choice={choice} busy={changes.busy}
            error={changes.errors.get(changeKey(choice.change))}
            onToggle={() => setDraft((previous) => {
              const next = new Map(previous);
              const selected = !choice.selected;
              if (selected === choice.change.add) next.set(role.id, selected);
              else next.delete(role.id);
              return next;
            })} />;
        })}
      </div>
      <div className="role-people__actions">
        <button type="button" className="role-people__button role-people__button--primary" disabled={!pending.length || changes.busy} onClick={() => void apply()}>
          {remainingFailures ? 'Повторить сохранение' : 'Применить'}{pending.length > 0 && ` · ${pending.length}`}
        </button>
        <button type="button" className="role-people__button" disabled={changes.busy} onClick={onClose}>
          {pending.length ? 'Отменить выбор' : 'Закрыть'}
        </button>
      </div>
      <ChangeFeedback changes={changes} />
    </section>
  );
}

export function ServerPeopleDirectory(props: PeopleProps & { canKick: boolean }) {
  return <PeopleDirectory key={JSON.stringify([props.serverId, props.selfId])} {...props} />;
}

function PeopleDirectory(props: PeopleProps & { canKick: boolean }) {
  const { members, roles, selfId, ownerId, serverId, canKick, onChanged } = props;
  const actor = useActor(props);
  const access = roleAccess(props, actor);
  const changes = useRoleChanges(props);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string>();
  const [kicking, setKicking] = useState(false);
  const [removed, setRemoved] = useState<{ source: ServerMemberInfo[]; ids: Set<string> }>();
  const [notice, setNotice] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const removedIds = removed?.source === members ? removed.ids : undefined;
  const visible = members.filter((member) => !removedIds?.has(member.user.id));
  const current = visible.find((member) => member.user.id === editing);

  async function refresh() {
    try {
      await onChanged();
      setRefreshError('');
      setNotice('');
    } catch (error) {
      setRefreshError(`Участник исключён. Не удалось обновить список. ${errorText(error)}`);
    }
  }

  async function kick(member: ServerMemberInfo) {
    setKicking(true);
    setNotice('');
    try {
      const ok = await confirmAction({
        title: `Исключить ${nameOf(member)} с сервера?`,
        body: 'Сообщения останутся. Вернуться можно по новому приглашению.',
        tone: 'danger',
        confirmLabel: 'Исключить',
      });
      if (!ok) return;
      await api.kickMember(serverId, member.user.id);
      setRemoved({ source: members, ids: new Set([...(removedIds ?? []), member.user.id]) });
      await refresh();
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setKicking(false);
    }
  }

  if (current) {
    return <MemberRoleChoices key={current.user.id} {...props} actor={actor} member={current} changes={changes}
      onClose={() => { changes.resetFeedback(); setEditing(undefined); }} />;
  }

  const filtered = visible.filter((member) => matches(member, query));
  return (
    <section className="role-people" aria-label="Участники сервера">
      <div className="role-people__toolbar">
        <strong>Участники · {visible.length}</strong>
        <input aria-label="Поиск участников" placeholder="Имя или @логин" value={query}
          onChange={(event) => setQuery(event.target.value)} />
      </div>
      <ChangeFeedback changes={changes} />
      {notice && <p role="status">{notice}</p>}
      {refreshError && <p role="alert">{refreshError}</p>}
      {refreshError && <button type="button" className="role-people__button" disabled={kicking} onClick={async () => {
        setKicking(true);
        try { await refresh(); } finally { setKicking(false); }
      }}>Обновить список</button>}
      <ul className="role-people__list">
        {filtered.map((member) => {
          const memberRoles = effectiveRoles(roles, roles.filter((role) => changes.hasRole(member, role)).map((role) => role.id),
            !!member.user.homeInstance);
          const mayKick = canKick && member.user.id !== selfId && member.user.id !== ownerId;
          const lower = highest(memberRoles, !!member.user.bot) < access.top;
          return (
            <li className="role-people__row" key={member.user.id}>
              <MemberName member={member} />
              <span className="role-people__chips">
                {memberRoles.filter((role) => !role.isEveryone).sort((a, b) => b.position - a.position)
                  .map((role) => <span key={role.id}>{role.name}</span>)}
              </span>
              <div className="role-people__actions">
                <button type="button" className="role-people__button" disabled={kicking || changes.busy}
                  aria-label={`Роли участника ${nameOf(member)}`} onClick={() => setEditing(member.user.id)}>Роли</button>
                {mayKick && (lower ? <button type="button" className="role-people__button role-people__button--danger" disabled={kicking || changes.busy}
                  aria-label={`Исключить ${nameOf(member)}`} onClick={() => void kick(member)}>Исключить</button>
                  : <small className="muted">Нельзя исключить участника вашего уровня или выше</small>)}
              </div>
            </li>
          );
        })}
      </ul>
      {filtered.length === 0 && <p className="muted">Участники не найдены.</p>}
    </section>
  );
}
