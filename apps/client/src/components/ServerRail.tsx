import { useState } from 'react';
import { api } from '../api';
import { useAnimatedAvatarsEnabled } from '../avatarAnimation';
import { toastError } from '../toast';
import { multiInstanceEnabled } from '../config';
import { subscribeToServer } from '../sockets';
import { useStore } from '../store';
import { Avatar } from './Avatar';
import { Goose } from './Goose';
import { Icon } from './Icon';
import { InstanceSwitcher } from './InstanceSwitcher';
import { ProfileModal } from './ProfileModal';
import { CreateServerModal, JoinServerModal } from './ServerActionModals';
import { ContextMenu, MenuItem, type MenuPos } from './ContextMenu';

export function ServerRail() {
  const servers = useStore((s) => s.servers);
  const currentServerId = useStore((s) => s.currentServerId);
  const openServer = useStore((s) => s.openServer);
  const loadServers = useStore((s) => s.loadServers);
  const user = useStore((s) => s.user);
  const animatedOn = useAnimatedAvatarsEnabled();
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const unreadDms = useStore((s) => s.unreadDms);
  const unreadServers = useStore((s) => s.unreadServers);
  const mentionServers = useStore((s) => s.mentionServers);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const setAdminOpen = useStore((s) => s.setAdminOpen);
  const [showProfile, setShowProfile] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const pushMutedServers = useStore((s) => s.pushMutedServers);
  const setPushMuted = useStore((s) => s.setPushMuted);
  // Своё меню по ПКМ (#75). Настройки сервера отсюда НЕ предлагаем: права мы знаем только для
  // ОТКРЫТОГО сервера (они в bootstrap), а показать пункт, который у половины серверов приведёт
  // в отказ, хуже, чем не показать его вовсе.
  const [menu, setMenu] = useState<{ pos: MenuPos; id: string; name: string; ownerId: string } | null>(null);

  const canCreate = !!(user?.superAdmin || user?.canCreateServers);

  async function select(id: string) {
    await openServer(id);
    subscribeToServer(id);
  }

  async function afterJoinOrCreate(serverId: string) {
    await loadServers();
    await select(serverId);
  }

  /** Покинуть сервер (#92). Владельцу пункт не показываем — сервер остался бы без хозяина. */
  async function leave(serverId: string, name: string) {
    if (!confirm(`Покинуть сервер «${name}»? Вернуться можно будет только по приглашению.`)) return;
    try {
      await api.leaveServer(serverId);
      await loadServers();
      // Уходим со страницы сервера, только если открыт ИМЕННО он: иначе выход из фонового
      // сервера через ПКМ выкидывал бы из того, что человек сейчас читает.
      if (useStore.getState().currentServerId === serverId) {
        useStore.setState({ currentServerId: null, bootstrap: null, currentChannelId: null });
        setView('dm');
      }
    } catch (err) {
      toastError(err);
    }
  }

  return (
    <div className="rail">
      <button
        className={`rail-icon home ${view === 'dm' ? 'active' : ''}`}
        title="Личные сообщения"
        onClick={() => setView('dm')}
      >
        <Goose pose="head" size={30} />
        {unreadDms.length > 0 && <span className="rail-badge">{unreadDms.length}</span>}
      </button>
      <div className="rail-sep" />
      {servers.map((s) => (
        <button
          key={s.id}
          className={`rail-icon ${view === 'server' && s.id === currentServerId ? 'active' : ''}`}
          title={s.name}
          onClick={() => select(s.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ pos: { x: e.clientX, y: e.clientY }, id: s.id, name: s.name, ownerId: s.ownerId });
          }}
        >
          {/* Иконка сервера (#74); буква — запасной вариант, пока её не загрузили. */}
          {s.iconUrl ? (
            <img className="rail-img" src={s.iconUrl} alt="" loading="lazy" />
          ) : (
            s.name[0]?.toUpperCase()
          )}
          {/* Непрочитанное на сервере, который сейчас НЕ открыт: иначе про него неоткуда узнать,
              не переключившись туда наугад. Упоминания — тем же ярким значком, что и у ЛС. */}
          {(mentionServers[s.id] ?? 0) > 0 ? (
            <span className="rail-badge">{(mentionServers[s.id] ?? 0) > 99 ? '99+' : mentionServers[s.id]}</span>
          ) : (unreadServers[s.id] ?? 0) > 0 ? (
            <span className="rail-badge muted">{(unreadServers[s.id] ?? 0) > 99 ? '99+' : unreadServers[s.id]}</span>
          ) : null}
        </button>
      ))}
      {canCreate && (
        <button className="rail-icon add" title="Создать сервер" onClick={() => setShowCreate(true)}>
          <Icon name="plus" size={22} />
        </button>
      )}
      <button className="rail-icon add" title="Войти по приглашению" onClick={() => setShowJoin(true)}>
        <Icon name="chevron-down" size={22} />
      </button>
      <div className="rail-spacer" />
      {/* Multi-instance switcher (#7) — native (desktop + mobile): switch between saved GusVoice backends. */}
      {multiInstanceEnabled() && <InstanceSwitcher />}
      {menu && (
        <ContextMenu pos={menu.pos} onClose={() => setMenu(null)} width={232}>
          {menu.id !== currentServerId && (
            <MenuItem
              icon="chevron-down"
              label="Открыть"
              onClick={() => {
                setMenu(null);
                void select(menu.id);
              }}
            />
          )}
          <MenuItem
            icon={pushMutedServers.includes(menu.id) ? 'bell' : 'bell-off'}
            label={pushMutedServers.includes(menu.id) ? 'Включить пуши сервера' : 'Отключить пуши сервера'}
            onClick={() => {
              const muted = pushMutedServers.includes(menu.id);
              setMenu(null);
              setPushMuted('server', menu.id, !muted).catch(toastError);
            }}
          />
          {menu.ownerId !== user?.id && (
            <MenuItem
              icon="close"
              label="Покинуть сервер"
              danger
              onClick={() => {
                const { id, name } = menu;
                setMenu(null);
                void leave(id, name);
              }}
            />
          )}
        </ContextMenu>
      )}
      <button className="rail-icon settings-btn" title="Настройки" onClick={() => setSettingsOpen(true)}>
        <Icon name="settings" size={20} />
      </button>
      {user?.superAdmin && (
        <button className="rail-icon admin" title="Админ-панель" onClick={() => setAdminOpen(true)}>
          <Icon name="lock" size={20} />
        </button>
      )}
      <button className="rail-icon profile" title={`${user?.displayName} · профиль`} onClick={() => setShowProfile(true)}>
        {/* 🔴 Своя анимация показывается и ЗДЕСЬ (фикс 05.09): это кнопка «мой профиль», и человек,
            купивший движущийся аватар, смотрит на неё чаще, чем на любую другую свою аватарку.
            Без `animatedUrl` тут оставалась прежняя картинка — а у купившего анимацию обычный и
            анимированный аватар это РАЗНЫЕ файлы. Не путать с «Загрузить аватар» в настройках: там
            статичный намеренно, потому что кнопка правит именно его. */}
        <Avatar
          url={user?.avatarUrl}
          animatedUrl={animatedOn ? user?.animatedAvatarUrl : undefined}
          name={user?.displayName ?? '?'}
          size={48}
        />
      </button>

      {showProfile && <ProfileModal onClose={() => setShowProfile(false)} />}
      {showCreate && <CreateServerModal onClose={() => setShowCreate(false)} onCreated={afterJoinOrCreate} />}
      {showJoin && <JoinServerModal onClose={() => setShowJoin(false)} onJoined={afterJoinOrCreate} />}
    </div>
  );
}
