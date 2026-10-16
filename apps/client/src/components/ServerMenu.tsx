import { api } from '../api';
import { noticeFromRefusal } from '../accessClosed';
import { confirmAction } from '../confirm';
import { dismissGuestGroup } from '../guestJoin';
import type { RailGroupView } from '../railRules';
import { subscribeToServer } from '../sockets';
import { useStore } from '../store';
import { toastError } from '../toast';
import { ContextMenu, MenuItem, type MenuPos } from './ContextMenu';

/**
 * Действия над сервером из списка — общие для рейла ПК (`ServerRail`) и списка серверов телефона (`PhoneServerList`):
 * открыть, покинуть, меню по ПКМ / долгому нажатию. Раньше жили внутри `ServerRail`; вынесены, чтобы две раскладки не
 * расходились в правилах (закрытый сервер, отказ с причиной, владельцу «Покинуть» не предлагаем).
 */

/** Открыть сервер ЖИВОГО инстанса. Закрытый держателем не открываем вовсе — показываем окно (§5.3.1). */
export async function selectServer(id: string): Promise<void> {
  const closed = useStore.getState().closedServers[id];
  if (closed) {
    useStore.getState().noteAccessClosed(closed);
    return;
  }
  try {
    await useStore.getState().openServer(id);
    subscribeToServer(id);
  } catch (err) {
    // Закрыли, пока нас не было: узнаём об этом только сейчас, отказом с причиной и контактами.
    const notice = noticeFromRefusal(err, { id, name: useStore.getState().servers.find((x) => x.id === id)?.name ?? 'сервер' });
    if (notice) useStore.getState().noteAccessClosed(notice);
    else toastError(err);
  }
}

/** Покинуть сервер (#92). Владельцу пункт не показываем — сервер остался бы без хозяина. */
export async function leaveServerAsk(serverId: string, name: string): Promise<void> {
  const ok = await confirmAction({
    title: `Покинуть сервер «${name}»?`,
    body: 'Ваши сообщения останутся, но вернуться можно будет только по новому приглашению.',
    confirmLabel: 'Покинуть',
  });
  if (!ok) return;
  try {
    await api.leaveServer(serverId);
    await useStore.getState().loadServers();
    // Уходим со страницы сервера, только если открыт ИМЕННО он: иначе выход из фонового
    // сервера через ПКМ выкидывал бы из того, что человек сейчас читает.
    if (useStore.getState().currentServerId === serverId) {
      useStore.setState({ currentServerId: null, bootstrap: null, currentChannelId: null });
      useStore.getState().setView('dm');
    }
  } catch (err) {
    toastError(err);
  }
}

export interface ServerMenuState {
  pos: MenuPos;
  id: string;
  name: string;
  ownerId: string;
}

/** Меню сервера (#75). Настройки сервера отсюда НЕ предлагаем: права известны только для ОТКРЫТОГО сервера (bootstrap). */
export function ServerMenu({ menu, onClose }: { menu: ServerMenuState; onClose: () => void }) {
  const currentServerId = useStore((s) => s.currentServerId);
  const user = useStore((s) => s.user);
  const pushMutedServers = useStore((s) => s.pushMutedServers);
  const setPushMuted = useStore((s) => s.setPushMuted);
  return (
    <ContextMenu pos={menu.pos} onClose={onClose} width={232}>
      {menu.id !== currentServerId && (
        <MenuItem
          icon="chevron-down"
          label="Открыть"
          onClick={() => {
            onClose();
            void selectServer(menu.id);
          }}
        />
      )}
      <MenuItem
        icon={pushMutedServers.includes(menu.id) ? 'bell' : 'bell-off'}
        label={pushMutedServers.includes(menu.id) ? 'Включить пуши сервера' : 'Отключить пуши сервера'}
        onClick={() => {
          const muted = pushMutedServers.includes(menu.id);
          onClose();
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
            onClose();
            void leaveServerAsk(id, name);
          }}
        />
      )}
    </ContextMenu>
  );
}

/**
 * «Убрать из списка» у группы соседа (15.10) — правый клик / долгое нажатие по её заголовку в рейле или в списке серверов
 * телефона. Только на ЭТОМ устройстве и без ответа хоста: хост бывает мёртв навсегда, и выход, ждущий его ответа, — не
 * выход. Членства у соседа остаются; вернуться — по ссылке-приглашению. Подтверждение — `confirmAction` (не `window.confirm`).
 */
export async function dismissGuestGroupAsk(group: RailGroupView): Promise<void> {
  const ok = await confirmAction({
    title: `Убрать «${group.title}» из списка?`,
    body:
      'Серверы этого инстанса пропадут из списка на этом устройстве, его данные здесь сотрутся. Членства там останутся — ' +
      'вернуться можно по ссылке-приглашению.',
    tone: 'danger',
    confirmLabel: 'Убрать',
  });
  if (!ok) return;
  try {
    await dismissGuestGroup({ instanceId: group.instanceId, place: group.place });
  } catch (err) {
    toastError(err);
  }
}

export interface GuestGroupMenuState {
  pos: MenuPos;
  group: RailGroupView;
}

/** Меню заголовка группы соседа (15.10): один пункт — «Убрать из списка». */
export function GuestGroupMenu({ menu, onClose }: { menu: GuestGroupMenuState; onClose: () => void }) {
  return (
    <ContextMenu pos={menu.pos} onClose={onClose} width={232}>
      <MenuItem
        icon="close"
        label="Убрать из списка"
        danger
        onClick={() => {
          const { group } = menu;
          onClose();
          void dismissGuestGroupAsk(group);
        }}
      />
    </ContextMenu>
  );
}
