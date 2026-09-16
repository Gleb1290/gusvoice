import type { ServerMemberInfo } from '@gusvoice/shared';
import { useState } from 'react';
import { isMobile } from '../hotkeys';
import { customStatusVisible, effectiveDot } from '../status';
import { useStore } from '../store';
import { toastError } from '../toast';
import { Avatar } from './Avatar';
import { CrownMark, crownGlow, useCrownId } from './Crown';
import { useAnimatedAvatarsEnabled } from '../avatarAnimation';
import { Icon } from './Icon';
import { MemberProfileSheet } from './MemberProfileSheet';
import { StatusDot } from './StatusDot';
import { useUserMenu } from './UserContextMenu';

/** Right-hand server member list, grouped by online / offline (online = active gateway socket). */
export function ServerMembersPanel() {
  const bootstrap = useStore((s) => s.bootstrap);
  const onlineUsers = useStore((s) => s.onlineUsers);
  const userStatuses = useStore((s) => s.userStatuses);
  const userActivities = useStore((s) => s.userActivities);
  const me = useStore((s) => s.user);
  const openDmWith = useStore((s) => s.openDmWith);
  const setMobileMembersOpen = useStore((s) => s.setMobileMembersOpen);
  const { open: openMenu, menu } = useUserMenu();
  // The SHARED store roster (store.loadMembers fills it on server open/refresh) — NOT a private
  // fetch. That's what makes live `user.update` broadcasts (name/avatar edits) show up here:
  // store.applyUserProfile patches s.members, and this panel re-renders with it. The old local
  // useState+listMembers copy was the "right column only updates after a re-join" bug.
  const members = useStore((s) => s.members);
  // Mobile: tapping a member opens their profile bottom-sheet instead of jumping straight to a DM.
  const [sheetMember, setSheetMember] = useState<ServerMemberInfo | null>(null);
  const mobile = isMobile();
  const serverId = bootstrap?.server.id;
  // ⚠️ ДО раннего выхода ниже: хук нельзя звать после условного `return`. `useCrownId` сам терпит
  // `undefined`, поэтому порядок безопасен.
  const crownId = useCrownId(serverId);
  // Анимация — по настройке ЗРИТЕЛЯ: выключил, и ссылка сюда даже не доедет.
  const animatedOn = useAnimatedAvatarsEnabled();

  if (!serverId) return null;

  const onlineSet = new Set(onlineUsers);
  // Live status overlays the roster (broadcasts land in store.userStatuses); a chosen "invisible"
  // (or being offline) reads as offline for everyone but yourself.
  const statusOf = (m: ServerMemberInfo) => userStatuses[m.user.id]?.status ?? m.user.status ?? 'online';
  const customOf = (m: ServerMemberInfo) => userStatuses[m.user.id]?.customStatus ?? m.user.customStatus ?? null;
  const dotOf = (m: ServerMemberInfo) => effectiveDot(statusOf(m), onlineSet.has(m.user.id), m.user.id === me?.id);

  const sorted = [...members].sort((a, b) =>
    (a.nickname || a.user.displayName).localeCompare(b.nickname || b.user.displayName),
  );
  const online = sorted.filter((m) => dotOf(m) !== 'offline');
  const offline = sorted.filter((m) => dotOf(m) === 'offline');

  const row = (m: ServerMemberInfo) => {
    const name = m.nickname || m.user.displayName;
    const self = m.user.id === me?.id;
    const dot = dotOf(m);
    const custom = customOf(m);
    const showCustom = !!(custom && (custom.emoji || custom.text)) && customStatusVisible(statusOf(m), onlineSet.has(m.user.id), self);
    // Game activity (#40) takes the secondary line when present (like Discord); only for online rows.
    const game = dot !== 'offline' ? userActivities[m.user.id] : undefined;
    return (
      <li
        key={m.user.id}
        className={`mp-row ${dot === 'offline' ? 'mp-off' : ''} ${self && !mobile ? '' : 'mp-clickable'}`}
        title={mobile ? undefined : self ? undefined : `ЛКМ — написать, ПКМ — меню`}
        onClick={
          mobile
            ? () => setSheetMember(m)
            : self
              ? undefined
              : () => void openDmWith(m.user.id).catch((e: Error) => toastError(e))
        }
        onContextMenu={(e) => openMenu(e, { userId: m.user.id, name, avatarUrl: m.user.avatarUrl })}
      >
        <span className="mp-ava">
          <Avatar
            url={m.user.avatarUrl}
            animatedUrl={animatedOn ? m.user.animatedAvatarUrl : undefined}
            name={name}
            size={mobile ? 44 : 28}
            fallback="icon"
          />
          {crownId === m.user.id && <CrownMark size={mobile ? 16 : 12} />}
          <span className="mp-dot-wrap">
            <StatusDot status={dot} size={11} ringColor="var(--bg-2)" />
          </span>
        </span>
        <span className="mp-meta">
          <span className={`mp-name${crownGlow(crownId === m.user.id)}`}>{name}</span>
          {game ? (
            <span className="mp-game" title={`Играет в ${game.name}`}>
              <Icon name="gamepad" size={12} />
              <span className="mp-game-name">{game.name}</span>
            </span>
          ) : showCustom ? (
            <span className="mp-custom">
              {custom!.emoji && <span className="mp-custom-emoji">{custom!.emoji}</span>}
              {custom!.text}
            </span>
          ) : null}
        </span>
      </li>
    );
  };

  return (
    <div className="members-panel">
      {/* Mobile (design-step8 F1): own-screen header with a back affordance + total count. */}
      {mobile && (
        <div className="mp-mobile-head">
          <button type="button" className="mp-back" title="Назад" onClick={() => setMobileMembersOpen(false)}>
            <Icon name="chevron-left" size={22} />
          </button>
          <span className="mp-mobile-title">Участники</span>
          <span className="mp-mobile-count">{members.length}</span>
        </div>
      )}
      {online.length > 0 && (
        <>
          <div className="mp-head">В сети — {online.length}</div>
          <ul className="mp-list">{online.map((m) => row(m))}</ul>
        </>
      )}
      {offline.length > 0 && (
        <>
          <div className="mp-head">Не в сети — {offline.length}</div>
          <ul className="mp-list">{offline.map((m) => row(m))}</ul>
        </>
      )}
      {menu}
      {sheetMember && <MemberProfileSheet member={sheetMember} onClose={() => setSheetMember(null)} />}
    </div>
  );
}
