import type { PermissionName, PermissionOverwrite, ServerMemberInfo } from '@gusvoice/shared';
import { Permission } from '@gusvoice/shared';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';

// PRIORITY_SPEAKER and DEAFEN_MEMBERS are intentionally absent: neither does anything yet (see the
// note on PERMS in MembersRolesModal), so offering them per-channel only promises what we don't do.
export const PERM_LABELS: Partial<Record<PermissionName, string>> = {
  VIEW_CHANNEL: 'Видеть канал',
  READ_HISTORY: 'Читать историю',
  SEND_MESSAGES: 'Писать сообщения',
  MANAGE_MESSAGES: 'Модерация сообщений',
  CONNECT: 'Подключаться',
  SPEAK: 'Говорить',
  VIDEO: 'Камера',
  SHARE_SCREEN: 'Демонстрация экрана',
  MUTE_MEMBERS: 'Мьютить других',
  MOVE_MEMBERS: 'Перемещать других',
  MANAGE_SOUNDS: 'Звуки канала',
};

export const TEXT_PERMS: PermissionName[] = [
  'VIEW_CHANNEL',
  'READ_HISTORY',
  'SEND_MESSAGES',
  'MANAGE_MESSAGES',
  'MANAGE_SOUNDS',
];
export const VOICE_PERMS: PermissionName[] = [
  'VIEW_CHANNEL',
  'CONNECT',
  'SPEAK',
  'VIDEO',
  'SHARE_SCREEN',
  'MUTE_MEMBERS',
  'MOVE_MEMBERS',
  'MANAGE_SOUNDS',
];
// Categories can contain both text and voice channels, so they expose the full set.
export const CATEGORY_PERMS: PermissionName[] = [...new Set([...TEXT_PERMS, ...VOICE_PERMS])] as PermissionName[];

interface OW {
  targetType: 'role' | 'member';
  targetId: string;
  allow: bigint;
  deny: bigint;
}

/** Adapter to the backend for whichever resource (channel or category) hosts the overwrites. */
export interface OverwriteSource {
  serverId: string;
  list: () => Promise<PermissionOverwrite[]>;
  set: (o: PermissionOverwrite) => Promise<void>;
  remove: (targetType: string, targetId: string) => Promise<void>;
}

/**
 * Shared tri-state (allow/inherit/deny) overwrite editor — used for both channel and category
 * permissions. "Make private" toggles @everyone's VIEW_CHANNEL deny. `header` lets a host inject
 * extra controls (e.g. a channel's category-sync toggle).
 */
export function OverwriteEditor({
  source,
  perms,
  header,
}: {
  source: OverwriteSource;
  perms: PermissionName[];
  header?: ReactNode;
}) {
  const bootstrap = useStore((s) => s.bootstrap);
  const roles = bootstrap?.roles ?? [];
  const [members, setMembers] = useState<ServerMemberInfo[]>([]);
  const [ows, setOws] = useState<OW[]>([]);
  const [error, setError] = useState<string | null>(null);
  const everyone = roles.find((r) => r.isEveryone);

  async function reload() {
    try {
      const list = await source.list();
      setOws(
        list.map((o) => ({ targetType: o.targetType, targetId: o.targetId, allow: BigInt(o.allow), deny: BigInt(o.deny) })),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void reload();
    api.listMembers(source.serverId).then(setMembers).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.serverId]);

  const nameFor = (o: OW) => {
    if (o.targetType === 'role') {
      const r = roles.find((x) => x.id === o.targetId);
      return r?.isEveryone ? '@everyone' : r?.name ?? 'роль';
    }
    return members.find((m) => m.user.id === o.targetId)?.user.displayName ?? 'участник';
  };

  async function persist(next: OW) {
    setError(null);
    try {
      await source.set({
        targetType: next.targetType,
        targetId: next.targetId,
        allow: next.allow.toString(),
        deny: next.deny.toString(),
      });
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function setBit(o: OW, bit: bigint, state: 'allow' | 'deny' | 'inherit') {
    let allow = o.allow & ~bit;
    let deny = o.deny & ~bit;
    if (state === 'allow') allow |= bit;
    else if (state === 'deny') deny |= bit;
    void persist({ ...o, allow, deny });
  }

  function addTarget(targetType: 'role' | 'member', targetId: string) {
    if (!targetId || ows.some((o) => o.targetId === targetId)) return;
    setOws((p) => [...p, { targetType, targetId, allow: 0n, deny: 0n }]);
  }

  async function removeTarget(o: OW) {
    setError(null);
    try {
      await source.remove(o.targetType, o.targetId);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const everyoneOw = everyone ? ows.find((o) => o.targetId === everyone.id) : undefined;
  const isPrivate = !!everyoneOw && (everyoneOw.deny & Permission.VIEW_CHANNEL) === Permission.VIEW_CHANNEL;

  function setPrivate(makePrivate: boolean) {
    if (!everyone) return;
    const cur: OW = everyoneOw ?? { targetType: 'role', targetId: everyone.id, allow: 0n, deny: 0n };
    const allow = cur.allow & ~Permission.VIEW_CHANNEL;
    const deny = makePrivate ? cur.deny | Permission.VIEW_CHANNEL : cur.deny & ~Permission.VIEW_CHANNEL;
    void persist({ ...cur, allow, deny });
  }

  const usedIds = new Set(ows.map((o) => o.targetId));
  const addableRoles = roles.filter((r) => !usedIds.has(r.id));
  const addableMembers = members.filter((m) => !usedIds.has(m.user.id));

  return (
    <div className="ow-editor">
      {header}

      <div className="ow-private">
        <button type="button" onClick={() => setPrivate(!isPrivate)}>
          {isPrivate ? 'Сделать публичным' : 'Сделать приватным'}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          {isPrivate ? 'Виден только тем, кому явно разрешён' : 'Виден всем (@everyone)'}
        </span>
      </div>

      {error && <div className="error">{error}</div>}

      {ows.map((o) => (
        <div className="ow-card" key={o.targetId}>
          <div className="ow-card-head">
            <strong>{nameFor(o)}</strong>
            <button type="button" className="link" onClick={() => void removeTarget(o)}>
              убрать
            </button>
          </div>
          <div className="ow-perms">
            {perms.map((p) => {
              const bit = Permission[p];
              const st = (o.allow & bit) === bit ? 'allow' : (o.deny & bit) === bit ? 'deny' : 'inherit';
              return (
                <div className="ow-perm" key={p}>
                  <span className="ow-perm-label">{PERM_LABELS[p] ?? p}</span>
                  <div className="ow-tri">
                    <button
                      type="button"
                      className={st === 'deny' ? 'on deny' : ''}
                      title="Запретить"
                      onClick={() => setBit(o, bit, st === 'deny' ? 'inherit' : 'deny')}
                    >
                      ✕
                    </button>
                    <button
                      type="button"
                      className={st === 'inherit' ? 'on' : ''}
                      title="Наследовать"
                      onClick={() => setBit(o, bit, 'inherit')}
                    >
                      –
                    </button>
                    <button
                      type="button"
                      className={st === 'allow' ? 'on allow' : ''}
                      title="Разрешить"
                      onClick={() => setBit(o, bit, st === 'allow' ? 'inherit' : 'allow')}
                    >
                      ✓
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <select
        className="ow-add"
        value=""
        onChange={(e) => {
          const v = e.target.value;
          if (v.startsWith('r:')) addTarget('role', v.slice(2));
          else if (v.startsWith('m:')) addTarget('member', v.slice(2));
        }}
      >
        <option value="">+ добавить роль или участника…</option>
        {addableRoles.length > 0 && (
          <optgroup label="Роли">
            {addableRoles.map((r) => (
              <option key={r.id} value={`r:${r.id}`}>
                {r.isEveryone ? '@everyone' : r.name}
              </option>
            ))}
          </optgroup>
        )}
        {addableMembers.length > 0 && (
          <optgroup label="Участники">
            {addableMembers.map((m) => (
              <option key={m.user.id} value={`m:${m.user.id}`}>
                {m.user.displayName}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  );
}
