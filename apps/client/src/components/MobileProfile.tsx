import type { PresenceStatus } from '@gusvoice/shared';
import { useState } from 'react';
import { api } from '../api';
import { activeInstanceId, instances } from '../config';
import { adminTarget } from '../configRules';
import { openOwnAdmin } from '../instanceSwitch';
import { STATUS_LABEL, STATUS_OPTIONS, STATUS_SUBTITLE } from '../status';
import { useStore } from '../store';
import { toastError } from '../toast';
import { Avatar } from './Avatar';
import { useAnimatedAvatarsEnabled } from '../avatarAnimation';
import { BottomSheet } from './BottomSheet';
import { Icon } from './Icon';
import { StatusDot } from './StatusDot';
import { UserContextMenu } from './UserContextMenu';

/**
 * Mobile-only Профиль tab (design-step8 D3; с 15.10 плоский вид как «Настройки» в Telegram Android, #218). A full-screen pane
 * above the bottom nav: шапка (аватар + имя + @handle), then flat 50 px rows — a quick presence-status row (→ status sheet),
 * Настройки (opens the settings modal), Админ-панель (super-admin only) and a red Выйти. Rendered by MainLayout when
 * `mobileProfileOpen`.
 * Нажатие на шапку — свой профиль на весь экран (приёмка 0.9.0), как у Telegram Android 12: свой профиль там — тот же
 * `ProfileActivity`, что у собеседника, с `my_profile` (`TA/ui/MainTabsActivity.java`, `POSITION_PROFILE` в фабрике вкладок).
 * Экран тот же, что у собеседника (`PhoneProfile` через `UserContextMenu` `initialView="profile"`), в варианте `isSelf`
 * (кнопка «Изменить» ведёт в настройки). `UserContextMenu` упоминается только при открытом профиле.
 */
export function MobileProfile() {
  const user = useStore((s) => s.user);
  const animatedOn = useAnimatedAvatarsEnabled();
  const setAuth = useStore((s) => s.setAuth);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const setMobileProfileOpen = useStore((s) => s.setMobileProfileOpen);
  const logout = useStore((s) => s.logout);
  const [statusSheet, setStatusSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selfProfile, setSelfProfile] = useState(false);

  if (!user) return null;

  // Та же развилка, что у кнопки в рейле (`adminTarget`, 23.09): стоя гостем у соседа, вход в админку
  // своего инстанса не пропадает, а ведёт домой.
  const admin = adminTarget(instances(), activeInstanceId(), !!user.superAdmin);
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
        {/* Шапка как у экрана «Настройки» Telegram Android: аватар, имя и строка под ним, без баннера и карточки. */}
        <div
          className="prof-head"
          role="button"
          tabIndex={0}
          aria-label="Мой профиль"
          onClick={() => setSelfProfile(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setSelfProfile(true);
            }
          }}
        >
          <span className="prof-card-ava">
            <Avatar
              url={user.avatarUrl}
              animatedUrl={animatedOn ? user.animatedAvatarUrl : undefined}
              name={user.displayName}
              size={64}
            />
          </span>
          <div className="prof-head-text">
            <div className="prof-name-row">
              <span className="prof-name">{user.displayName}</span>
            </div>
            <div className="prof-handle">@{user.username}</div>
          </div>
        </div>

        {/* Дальше — плоские группы строк по 50 px: значок слева, подпись 16, разделитель с отступом под текст
            (Telegram `TextCell`); группы разделяет полоса фона, как у `ShadowSectionCell`. */}
        <div className="prof-group">
          {/* Быстрый статус присутствия. */}
          <button type="button" className="prof-row" onClick={() => setStatusSheet(true)}>
            <StatusDot status={user.status} size={12} />
            <span className="prof-row-label">{statusLine}</span>
          </button>
        </div>

        <div className="prof-group">
          {/* Полные настройки — отдельными экранами (список разделов → раздел). */}
          <button type="button" className="prof-row" onClick={() => setSettingsOpen(true)}>
            <Icon name="settings" size={22} />
            <span className="prof-row-label">Настройки</span>
          </button>

          {/* Админ-панель — только супер-админу. Рейл-иконка админки на телефоне скрыта, так что это ЕДИНСТВЕННЫЙ вход:
              без него оператор с телефона не дойдёт до одобрения регистраций и настройки почты. */}
          {admin && (
            <button type="button" className="prof-row" onClick={() => void openOwnAdmin(admin.homeId).catch(toastError)}>
              <Icon name="lock" size={22} />
              <span className="prof-row-label">Админ-панель</span>
            </button>
          )}
        </div>

        <div className="prof-group">
          {/* Выход (то же, что действие «Сессия» в настройках). */}
          <button
            type="button"
            className="prof-row danger"
            onClick={async () => {
              setMobileProfileOpen(false);
              await logout();
              location.reload();
            }}
          >
            <Icon name="logout" size={22} />
            <span className="prof-row-label">Выйти</span>
          </button>
        </div>
      </div>

      {selfProfile && (
        <UserContextMenu
          target={{ userId: user.id, name: user.displayName, avatarUrl: user.avatarUrl, username: user.username }}
          pos={{ x: 0, y: 0 }}
          initialView="profile"
          onClose={() => setSelfProfile(false)}
        />
      )}

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
