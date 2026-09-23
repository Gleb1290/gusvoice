import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useAnimatedAvatarsEnabled } from '../avatarAnimation';
import { toastError } from '../toast';
import { noticeFromRefusal } from '../accessClosed';
import { takeInviteLink, usePendingInviteLink } from '../deepLinkInvite';
import { subscribeToServer } from '../sockets';
import { useStore } from '../store';
import { confirmAction } from '../confirm';
import { activeInstanceId, instances } from '../config';
import { adminTarget } from '../configRules';
import { openOwnAdmin } from '../instanceSwitch';
import { Avatar } from './Avatar';
import { Goose } from './Goose';
import { Icon } from './Icon';
import { ProfileModal } from './ProfileModal';
import { RailGroups } from './RailGroups';
import { railEdges, railScrollClass, RAIL_SCROLLBAR_LINGER_MS, type RailEdges } from '../railScroll';
import { hasUnseen } from '../settingsSeen';
import { SECTIONS } from '../settingsNav';
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
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  /**
   * Прокрутка списка серверов (19.09). Серверов бывает больше, чем влезает, и список давил на
   * нижние кнопки — настройки, админка, профиль уезжали за край. Теперь серверы живут в своей
   * полосе: колесо прокручивает её, содержимое у краёв тает (уплывает под кнопки), а полоска
   * прокрутки показывается только во время движения и сама гаснет.
   */
  const scrollRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<RailEdges>({ top: false, bottom: false });
  const [scrolling, setScrolling] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function onRailScroll(): void {
    const el = scrollRef.current;
    if (!el) return;
    setEdges(railEdges(el));
    setScrolling(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setScrolling(false), RAIL_SCROLLBAR_LINGER_MS);
  }

  /**
   * Пересчитать края, когда список поменялся (вступили в сервер, ушли, пришла группа соседа).
   * ⚠️ Таймером, а не `requestAnimationFrame`: в скрытой вкладке кадры не идут вовсе, и затухание
   * осталось бы в состоянии «как было при прошлом показе».
   */
  useEffect(() => {
    const t = setTimeout(() => {
      if (scrollRef.current) setEdges(railEdges(scrollRef.current));
    }, 0);
    return () => clearTimeout(t);
  }, [servers.length]);

  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);

  /**
   * Есть ли в настройках непросмотренное — пересчитываем при открытии и закрытии окна настроек:
   * именно там отметка и меняется, а на каждой отрисовке рейла читать хранилище незачем.
   */
  const settingsOpen = useStore((s) => s.settingsOpen);
  const [unseenSettings, setUnseenSettings] = useState(false);
  useEffect(() => {
    setUnseenSettings(hasUnseen(SECTIONS.flatMap((sec) => sec.groups.map((g) => g.id))));
  }, [settingsOpen]);

  const [showProfile, setShowProfile] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  /**
   * Пришли по ссылке снаружи (мессенджер → `gusvoice://` → мы). Окно открываем САМИ: человек уже
   * сделал жест «хочу сюда», и заставлять его искать кнопку «Войти по приглашению» после этого —
   * значит потерять его на полпути.
   */
  const pendingLink = usePendingInviteLink();
  const [linkToCheck, setLinkToCheck] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingLink) return;
    setLinkToCheck(takeInviteLink());
    setShowJoin(true);
  }, [pendingLink]);
  const pushMutedServers = useStore((s) => s.pushMutedServers);
  const setPushMuted = useStore((s) => s.setPushMuted);
  // Своё меню по ПКМ (#75). Настройки сервера отсюда НЕ предлагаем: права мы знаем только для
  // ОТКРЫТОГО сервера (они в bootstrap), а показать пункт, который у половины серверов приведёт
  // в отказ, хуже, чем не показать его вовсе.
  const [menu, setMenu] = useState<{ pos: MenuPos; id: string; name: string; ownerId: string } | null>(null);

  const canCreate = !!(user?.superAdmin || user?.canCreateServers);
  const admin = adminTarget(instances(), activeInstanceId(), !!user?.superAdmin);

  async function select(id: string) {
    /**
     * Закрытый держателем сервер не открываем ВООБЩЕ (§5.3.1): жать по нему человек будет — он
     * остался в рейле, потому что членство сохранено. Показываем то же окно, что и в момент
     * закрытия, вместо похода за отказом.
     */
    const closed = useStore.getState().closedServers[id];
    if (closed) {
      useStore.getState().noteAccessClosed(closed);
      return;
    }
    try {
      await openServer(id);
      subscribeToServer(id);
    } catch (err) {
      // Закрыли, пока нас не было: узнаём об этом только сейчас, отказом с причиной и контактами.
      const notice = noticeFromRefusal(err, { id, name: servers.find((x) => x.id === id)?.name ?? 'сервер' });
      if (notice) useStore.getState().noteAccessClosed(notice);
      else toastError(err);
    }
  }

  async function afterJoinOrCreate(serverId: string) {
    await loadServers();
    await select(serverId);
  }

  /** Покинуть сервер (#92). Владельцу пункт не показываем — сервер остался бы без хозяина. */
  async function leave(serverId: string, name: string) {
    const ok = await confirmAction({
      title: `Покинуть сервер «${name}»?`,
      body: 'Ваши сообщения останутся, но вернуться можно будет только по новому приглашению.',
      confirmLabel: 'Покинуть',
    });
    if (!ok) return;
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
      <div className={railScrollClass(edges, scrolling)} ref={scrollRef} onScroll={onRailScroll}>
      {/**
       * 🔴 Серверы ВСЕХ инстансов — одним списком (§5.7). Рисует их `RailGroups`, а не этот файл:
       * свои и чужие подчиняются одним правилам показа, и две реализации одной кнопки разошлись бы
       * на первом же значке. Здесь остаётся то, что относится к рейлу целиком: ЛС, кнопки внизу и
       * меню по ПКМ.
       */}
      <RailGroups
        onOpenLive={(id) => void select(id)}
        onMenu={(e, s) => setMenu({ pos: { x: e.clientX, y: e.clientY }, id: s.id, name: s.name, ownerId: s.ownerId })}
      />
      {canCreate && (
        <button className="rail-icon add" title="Создать сервер" onClick={() => setShowCreate(true)}>
          <Icon name="plus" size={22} />
        </button>
      )}
      <button className="rail-icon add" title="Войти по приглашению" onClick={() => setShowJoin(true)}>
        <Icon name="chevron-down" size={22} />
      </button>
      </div>
      <div className="rail-spacer" />
      {/* Переключателя инстансов здесь больше нет (23.09): переход — группами рейла, добавить/убрать —
          «Настройки › Федерация › Мои инстансы» (`InstancesPanel`). */}
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
      {/* 🔴 Кружок «загляни»: в настройках есть то, чего человек ещё не видел (новая настройка из
          обновления). Отметка про ПРОСМОТР, а не про значение, — поэтому отдельная от точки
          «изменено» внутри окна. Гаснет, когда человек до этих групп доберётся. */}
      <button className="rail-icon settings-btn" title="Настройки" onClick={() => setSettingsOpen(true)}>
        <Icon name="settings" size={20} />
        {unseenSettings && <span className="rail-new" role="img" aria-label="в настройках есть новое" />}
      </button>
      {/* 🔴 Решает не живой профиль, а `adminTarget` (23.09): стоя гостем у соседа, человек там без прав,
          но администрирует по-прежнему свой инстанс — и кнопка пропадать не должна. Тогда клик ведёт
          домой и открывает админку уже там. */}
      {admin && (
        <button
          className="rail-icon admin"
          title={admin.homeId ? 'Админ-панель вашего инстанса (перейдёт туда)' : 'Админ-панель'}
          onClick={() => void openOwnAdmin(admin.homeId).catch(toastError)}
        >
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
      {showJoin && (
        <JoinServerModal
          // Ключ по ссылке: пришла ВТОРАЯ ссылка, пока окно открыто, — окно пересоберётся с ней,
          // а не останется с первой (человек кликнул ещё раз, значит передумал).
          key={linkToCheck ?? 'manual'}
          initial={linkToCheck ?? undefined}
          onClose={() => {
            setShowJoin(false);
            setLinkToCheck(null);
          }}
          onJoined={afterJoinOrCreate}
        />
      )}
    </div>
  );
}
