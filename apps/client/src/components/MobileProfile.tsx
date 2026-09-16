import type { PresenceStatus } from '@gusvoice/shared';
import { useState } from 'react';
import { api } from '../api';
import { STATUS_LABEL, STATUS_OPTIONS, STATUS_SUBTITLE } from '../status';
import { useStore } from '../store';
import { toastError } from '../toast';
import { Avatar } from './Avatar';
import { useAnimatedAvatarsEnabled } from '../avatarAnimation';
import { BottomSheet } from './BottomSheet';
import { Icon } from './Icon';
import { StatusDot } from './StatusDot';

/**
 * Mobile-only Профиль tab (design-step8 D3). A full-screen pane above the bottom nav: profile card
 * (banner + avatar + name + @handle), a quick presence-status row (→ status sheet), a Настройки entry
 * that opens the settings modal, and a red Выйти. Rendered by MainLayout when `mobileProfileOpen`.
 */
export function MobileProfile() {
  const user = useStore((s) => s.user);
  const animatedOn = useAnimatedAvatarsEnabled();
  const setAuth = useStore((s) => s.setAuth);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const setAdminOpen = useStore((s) => s.setAdminOpen);
  const setMobileProfileOpen = useStore((s) => s.setMobileProfileOpen);
  const logout = useStore((s) => s.logout);
  const [statusSheet, setStatusSheet] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!user) return null;

  const custom = user.customStatus;
  const statusLine = custom?.text
    ? `${custom.emoji ? `${custom.emoji} ` : ''}${custom.text}`
    : STATUS_LABEL[user.status];

  async function pickStatus(status: PresenceStatus) {
    setStatusSheet(false);
    if (user!.status === status || busy) return;
    setBusy(true);
    try {
      setAuth(await api.setStatus({ status }));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mobile-profile">
      <div className="prof-scroll">
        {/* Profile card: honey banner + overlapping avatar + name/handle. */}
        <div className="prof-card">
          <div className="prof-banner" />
          <div className="prof-card-body">
            <span className="prof-card-ava">
              <Avatar
                url={user.avatarUrl}
                animatedUrl={animatedOn ? user.animatedAvatarUrl : undefined}
                name={user.displayName}
                size={72}
              />
            </span>
            <div className="prof-name-row">
              <span className="prof-name">{user.displayName}</span>
              <StatusDot status={user.status} size={11} />
            </div>
            <div className="prof-handle">@{user.username}</div>
          </div>
        </div>

        {/* Quick presence status. */}
        <button type="button" className="prof-row" onClick={() => setStatusSheet(true)}>
          <StatusDot status={user.status} size={12} />
          <span className="prof-row-label">{statusLine}</span>
          <Icon name="chevron-right" size={18} />
        </button>

        {/* Open the full settings modal. */}
        <button type="button" className="prof-row" onClick={() => setSettingsOpen(true)}>
          <Icon name="settings" size={20} />
          <span className="prof-row-label">Настройки</span>
          <Icon name="chevron-right" size={18} />
        </button>

        {/* Admin panel — super-admin only. The desktop rail's admin icon is hidden on mobile, so this is
            the ONLY way a phone operator reaches user-approval / SMTP setup (e.g. verify a registration
            manually when the instance has no e-mail configured). */}
        {user.superAdmin && (
          <button type="button" className="prof-row" onClick={() => setAdminOpen(true)}>
            <Icon name="lock" size={20} />
            <span className="prof-row-label">Админ-панель</span>
            <Icon name="chevron-right" size={18} />
          </button>
        )}

        {/* Sign out (mirrors the settings-modal session action). */}
        <button
          type="button"
          className="prof-row danger"
          onClick={() => {
            setMobileProfileOpen(false);
            logout();
            location.reload();
          }}
        >
          <Icon name="logout" size={20} />
          <span className="prof-row-label">Выйти</span>
        </button>
      </div>

      {statusSheet && (
        <BottomSheet title="Статус" onClose={() => setStatusSheet(false)}>
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className={`sheet-row${s === user.status ? ' on' : ''}`}
              onClick={() => void pickStatus(s)}
            >
              <StatusDot status={s} size={13} />
              <span className="sr-label">
                {STATUS_LABEL[s]}
                {STATUS_SUBTITLE[s] ? <span className="sr-sub"> · {STATUS_SUBTITLE[s]}</span> : null}
              </span>
              {s === user.status ? <Icon name="check" size={16} /> : null}
            </button>
          ))}
          <button
            type="button"
            className="sheet-row"
            onClick={() => {
              setStatusSheet(false);
              setSettingsOpen(true);
            }}
          >
            <Icon name="reaction" size={20} />
            <span className="sr-label">Свой статус…</span>
          </button>
        </BottomSheet>
      )}
    </div>
  );
}
