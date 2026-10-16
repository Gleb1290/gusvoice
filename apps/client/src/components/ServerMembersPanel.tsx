import type { ServerMemberInfo } from '@gusvoice/shared';
import { isMobile } from '../hotkeys';
import { usePhoneUi } from '../phoneLayout';
import { customStatusVisible, effectiveDot } from '../status';
import { useStore } from '../store';
import { toast, toastError } from '../toast';
import { dmBlockText, serverFedDm } from '../dmRules';
import { Avatar } from './Avatar';
import { CrownMark, crownGlow, useCrownId } from './Crown';
import { useAnimatedAvatarsEnabled } from '../avatarAnimation';
import { GuestMark } from './GuestMark';
import { Icon } from './Icon';
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
  // Э1 (`fedm1`): гостю с другого инстанса — «Написать» через его дом.
  const fedDm = useStore((s) => serverFedDm(s.serverFeatures));
  const setMobileMembersOpen = useStore((s) => s.setMobileMembersOpen);
  const { open: openMenu, menu } = useUserMenu();
  // The SHARED store roster (store.loadMembers fills it on server open/refresh) — NOT a private
  // fetch. That's what makes live `user.update` broadcasts (name/avatar edits) show up here:
  // store.applyUserProfile patches s.members, and this panel re-renders with it. The old local
  // useState+listMembers copy was the "right column only updates after a re-join" bug.
  const members = useStore((s) => s.members);
  const mobile = isMobile();
  // Телефон: нажатие на участника открывает полноэкранный профиль (#218, `PhoneProfile.tsx`; бывший лист `MemberProfileSheet`
  // для телефона больше не открывается) вместо прямого перехода в ЛС. Громкость, роли, модерация — внутри экрана.
  const phoneUi = usePhoneUi();
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

  /**
   * ЛКМ по строке — «написать». Гостю (и гостя) писать нельзя, и отказ за этим ходил на сервер:
   * человек получал тостом код `federation.dm_unavailable`. Отвечаем сразу и словами (§5.8).
   */
  const openDm = (m: ServerMemberInfo) => {
    const blocked = dmBlockText(me?.homeInstance, m.user.homeInstance, fedDm);
    if (blocked) {
      toast('info', blocked);
      return;
    }
    void openDmWith(m.user.id).catch((e: Error) => toastError(e));
  };

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
        // Подсказку сверяем с тем же правилом: обещать «ЛКМ — написать» тому, кому написать нельзя,
        // значит звать человека нажать и получить отказ.
        title={
          mobile || self
            ? undefined
            : dmBlockText(me?.homeInstance, m.user.homeInstance, fedDm)
              ? 'ПКМ — меню'
              : 'ЛКМ — написать, ПКМ — меню'
        }
        onClick={
          mobile || phoneUi
            ? (e) => openMenu(e, { userId: m.user.id, name, avatarUrl: m.user.avatarUrl, username: m.user.username }, 'profile')
            : self
              ? undefined
              : () => openDm(m)
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
          <span className={`mp-name${crownGlow(crownId === m.user.id)}`}>
            {name}
            {/* Гость виден сразу: список участников — первое место, где на человека смотрят. */}
            <GuestMark home={m.user.homeInstance} size={11} />
          </span>
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
    </div>
  );
}
