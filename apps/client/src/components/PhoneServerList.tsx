import { useState } from 'react';
import { activeInstanceId, instances } from '../config';
import { useStore } from '../store';
import { BottomSheet, SheetRow } from './BottomSheet';
import { Goose } from './Goose';
import { Icon } from './Icon';
import { RailGroups } from './RailGroups';
import { CreateServerModal, JoinServerModal } from './ServerActionModals';
import { GuestGroupMenu, selectServer, ServerMenu, type GuestGroupMenuState, type ServerMenuState } from './ServerMenu';

/**
 * Список серверов на телефоне (≤ 760 px, вкладка «Серверы», #218). Раньше сверху была лента квадратов 46×46 с одной буквой и
 * пустое «Выбери сервер» под ней: серверы не различить. Теперь — вертикальный список строк как список бесед: аватар 52,
 * название, вторая строка (счётчики непрочитанного — своих данных о сообщениях у сервера нет), справа число. Тап — каналы
 * сервера, «Назад» в их шапке — сюда же (`serverListOpen` в сторе). «Создать» / «Войти по приглашению» — плавающая кнопка
 * как «Написать» в списке бесед. Строки и меню (долгое нажатие) — общие с рейлом ПК: `RailGroups rows`, `ServerMenu`.
 */
export function PhoneServerList() {
  const servers = useStore((s) => s.servers);
  const user = useStore((s) => s.user);
  const switching = useStore((s) => s.switching);
  const loadServers = useStore((s) => s.loadServers);
  const [menu, setMenu] = useState<ServerMenuState | null>(null);
  const [groupMenu, setGroupMenu] = useState<GuestGroupMenuState | null>(null);
  const [sheet, setSheet] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  // Во время перехода между инстансами `user` ещё прежний — права берём из снимка активной записи (как в `ServerRail`).
  const canCreate = switching
    ? !!instances().find((i) => i.id === activeInstanceId())?.superAdmin
    : !!(user?.superAdmin || user?.canCreateServers);

  async function afterJoinOrCreate(serverId: string) {
    await loadServers();
    await selectServer(serverId);
  }

  const empty = servers.length === 0 && !switching;
  return (
    <div className="channels srv-list-screen">
      <div className="server-head dm-list-head">
        <strong>Серверы</strong>
      </div>
      <div className="channel-list dm-list dm-list-touch">
        {empty && (
          <div className="empty-goose srv-empty">
            <Goose pose="wave" size={120} />
            <div className="eg-title">Серверов пока нет</div>
            <div className="eg-sub">Нажмите «+», чтобы войти по приглашению{canCreate ? ' или создать свой сервер' : ''}.</div>
          </div>
        )}
        <RailGroups
          rows
          onOpenLive={(id) => void selectServer(id)}
          onMenu={(e, s) => setMenu({ pos: { x: e.clientX, y: e.clientY }, id: s.id, name: s.name, ownerId: s.ownerId })}
          onGroupMenu={(e, group) => setGroupMenu({ pos: { x: e.clientX, y: e.clientY }, group })}
        />
      </div>
      <button
        type="button"
        className="dm-fab"
        aria-label={canCreate ? 'Создать или присоединиться' : 'Войти по приглашению'}
        title={canCreate ? 'Создать или присоединиться' : 'Войти по приглашению'}
        onClick={() => (canCreate ? setSheet(true) : setShowJoin(true))}
      >
        <Icon name="plus" size={26} />
      </button>
      {sheet && (
        <BottomSheet title="Серверы" onClose={() => setSheet(false)}>
          <SheetRow
            icon="user-plus"
            label="Войти по приглашению"
            onClick={() => {
              setSheet(false);
              setShowJoin(true);
            }}
          />
          <SheetRow
            icon="plus"
            label="Создать сервер"
            onClick={() => {
              setSheet(false);
              setShowCreate(true);
            }}
          />
        </BottomSheet>
      )}
      {menu && <ServerMenu menu={menu} onClose={() => setMenu(null)} />}
      {groupMenu && <GuestGroupMenu menu={groupMenu} onClose={() => setGroupMenu(null)} />}
      {showCreate && <CreateServerModal onClose={() => setShowCreate(false)} onCreated={afterJoinOrCreate} />}
      {showJoin && <JoinServerModal onClose={() => setShowJoin(false)} onJoined={afterJoinOrCreate} />}
    </div>
  );
}
