import type { ServerMemberInfo } from '@gusvoice/shared';
import { MAX_VOLUME, useUserAudio } from '../localUserAudio';
import { customStatusVisible, effectiveDot } from '../status';
import { useStore } from '../store';
import { toastError } from '../toast';
import { Avatar } from './Avatar';
import { AvatarZoom } from './AvatarZoom';
import { BottomSheet } from './BottomSheet';
import { Icon } from './Icon';
import { ProfileEconomy } from './ProfileEconomy';
import { useAnimatedAvatarsEnabled } from '../avatarAnimation';
import { StatusDot } from './StatusDot';
import { topRoles } from '../memberRoles';
import { bannerStyle, hexRgba, roleHex } from './UserContextMenu';

/**
 * Mobile member profile bottom-sheet (design-step8 F2): tap a member on the members screen →
 * banner + avatar + name + @handle + role chips + a personal (client-only) volume slider + a DM
 * action. Reuses the desktop context menu's colour helpers and the shared per-user audio store.
 */
export function MemberProfileSheet({ member, onClose }: { member: ServerMemberInfo; onClose: () => void }) {
  const me = useStore((s) => s.user);
  const bootstrap = useStore((s) => s.bootstrap);
  const onlineUsers = useStore((s) => s.onlineUsers);
  const userStatuses = useStore((s) => s.userStatuses);
  const openDmWith = useStore((s) => s.openDmWith);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const audio = useUserAudio(member.user.id);
  const animatedOn = useAnimatedAvatarsEnabled();

  const isSelf = me?.id === member.user.id;
  const online = onlineUsers.includes(member.user.id);
  const st = userStatuses[member.user.id];
  const rawStatus = (isSelf ? me?.status : st?.status) ?? member.user.status ?? 'online';
  const dot = effectiveDot(rawStatus, online, isSelf);
  const liveCustom = (isSelf ? me?.customStatus : st?.customStatus) ?? member.user.customStatus ?? null;
  const custom =
    liveCustom && (liveCustom.emoji || liveCustom.text) && customStatusVisible(rawStatus, online, isSelf)
      ? liveCustom
      : null;

  const name = member.nickname || member.user.displayName;
  const fullAvatarUrl = (animatedOn ? member.user.animatedAvatarUrl : null) ?? member.user.avatarUrl ?? null;
  // Правило отбора общее с карточкой наведения в голосовом сайдбаре (`memberRoles.ts`): две копии
  // показали бы одному человеку разный набор ролей в двух местах одного экрана.
  const roles = topRoles(bootstrap?.roles ?? [], member.roleIds);

  const volPct = Math.round(audio.volume * 100);
  const volFill = audio.muted ? 0 : (audio.volume / MAX_VOLUME) * 100;
  const volTrack = `linear-gradient(90deg, var(--accent) ${volFill}%, var(--bg-3) ${volFill}%)`;

  const dm = () => {
    onClose();
    openDmWith(member.user.id).catch((e: Error) => toastError(e));
  };

  return (
    <BottomSheet onClose={onClose}>
      <div className="mps-banner" style={{ background: bannerStyle(member.user.id, !!isSelf) }} />
      <div className="mps-body">
        <span className="mps-ava">
          {/* Тот же жест, что и в карточке на десктопе: кружок обрезает картинку, тап открывает её
              целиком. Показываем ровно то, что видно здесь — анимацию только если она включена. */}
          <AvatarZoom url={fullAvatarUrl} name={name}>
            <Avatar
              url={member.user.avatarUrl}
              animatedUrl={animatedOn ? member.user.animatedAvatarUrl : undefined}
              name={name}
              size={72}
              fallback="icon"
            />
          </AvatarZoom>
          <span className="mps-dot">
            <StatusDot status={dot} size={16} ringColor="var(--bg-2)" />
          </span>
        </span>
        <div className="mps-name-row">
          <span className="mps-name">{name}</span>
          {isSelf && <span className="mps-badge">это вы</span>}
        </div>
        <div className="mps-handle">@{member.user.username}</div>
        {custom && (
          <div className="mps-custom">
            {custom.emoji && <span className="mps-custom-emoji">{custom.emoji}</span>}
            {custom.text}
          </div>
        )}

        {roles.length > 0 && (
          <div className="mps-roles">
            {roles.map((r) => {
              const hex = r.color ? roleHex(r.color) : null;
              return (
                <span
                  key={r.id}
                  className="mps-role"
                  style={hex ? { background: hexRgba(hex, 0.16), color: hex } : undefined}
                >
                  <span className="mps-role-dot" style={hex ? { background: hex } : undefined} />
                  {r.name}
                </span>
              );
            })}
          </div>
        )}

        {/* Экономика — только у ЧУЖОГО профиля: свой баланс висит чипом в шапке, а «типнуть себе»
            сервер и не пропустит. Шторка закрывается после удачного жеста — на мобиле она занимает
            весь низ экрана, и оставлять её открытой поверх канала незачем. */}
        {!isSelf && <ProfileEconomy userId={member.user.id} name={name} onDone={onClose} />}

        {/* Personal, client-only volume (persists across sessions, applies in voice). */}
        {!isSelf && (
          <div className="mps-vol">
            <div className="mps-vol-head">
              <button
                type="button"
                className={`mps-vol-spk ${audio.muted ? 'on' : ''}`}
                title={audio.muted ? 'Включить звук' : 'Заглушить для себя'}
                onClick={() => audio.toggleMuted()}
              >
                <Icon name={audio.muted ? 'volume-off' : 'volume'} size={18} />
              </button>
              <span className="mps-vol-label">ГРОМКОСТЬ</span>
              <button type="button" className={`mps-vol-pct ${audio.muted ? 'muted' : volPct > 100 ? 'boost' : ''}`} onClick={() => audio.reset()}>
                {audio.muted ? 'выкл' : `${volPct}%`}
              </button>
            </div>
            <input
              className="mps-vol-range"
              type="range"
              min={0}
              max={MAX_VOLUME}
              step={0.05}
              value={audio.muted ? 0 : audio.volume}
              onChange={(e) => {
                if (audio.muted) audio.setMuted(false);
                audio.setVolume(parseFloat(e.target.value));
              }}
              title="Громкость (только для вас)"
              style={{ background: volTrack }}
            />
          </div>
        )}

        <div className="mps-actions">
          {isSelf ? (
            <button
              type="button"
              className="mps-cta"
              onClick={() => {
                onClose();
                setSettingsOpen(true);
              }}
            >
              <Icon name="edit" size={18} /> Изменить профиль
            </button>
          ) : (
            <button type="button" className="mps-cta" onClick={dm}>
              <Icon name="mail" size={18} /> Написать в ЛС
            </button>
          )}
        </div>
      </div>
    </BottomSheet>
  );
}
