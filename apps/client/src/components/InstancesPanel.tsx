import { useState } from 'react';
import {
  activeInstanceId,
  type Instance,
  instances as readInstances,
  removeInstance,
  renameInstance,
  serverHost,
} from '../config';
import { adoptActiveInstance, switchInstance } from '../instanceSwitch';
import { confirmAction } from '../confirm';
import { useStore } from '../store';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { AddInstanceModal } from './AddInstanceModal';

/**
 * «Мои инстансы» в настройках (раздел «Федерация») — бывший переключатель внизу рейла (#7).
 *
 * 🔴 Переехал сюда 23.09 по решению держателя: переход между инстансами давно делает сам рейл — серверы ВСЕХ записей
 * стоят в нём группами (§5.7, `railRules.ts`), и значок внизу рейла стал вторым способом сделать то же
 * самое, только непонятным. Здесь осталось то, чего рейл не умеет: добавить аккаунт на другом
 * инстансе, переименовать, убрать — и «Перейти» для записи, у которой ещё нет ни одного сервера
 * (пустую группу рейл не рисует, и другой дороги к ней нет).
 *
 * ⚠️ Гостевые записи (вход к соседу через свой аккаунт) здесь не показываются: их заводит и гасит сам
 * клиент, а выйти от соседа — в «Где я гость» ниже. Убрать домашнюю запись — убрать и её гостевые
 * (`removeInstance` сам просит хосты завершить их сессии, F-23).
 */
export function InstancesPanel({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<Instance[]>(() => readInstances());
  const [activeId, setActiveId] = useState<string | null>(() => activeInstanceId());
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');

  const own = list.filter((i) => !i.guestOf);
  // Стоим гостем — «активна» для человека его домашняя запись: из неё он и пришёл.
  const active = list.find((i) => i.id === activeId);
  const currentHome = active?.guestOf ?? active?.id ?? null;

  function refresh() {
    setList(readInstances());
    setActiveId(activeInstanceId());
  }

  function commitRename(id: string) {
    renameInstance(id, renameVal);
    setRenaming(null);
    refresh();
  }

  async function goTo(id: string) {
    // Переход меняет всё вокруг — окно настроек прежнего инстанса держать открытым незачем.
    onClose();
    await switchInstance(id);
  }

  async function remove(inst: Instance) {
    const guests = list.filter((i) => i.guestOf === inst.id).length;
    const ok = await confirmAction({
      title: `Убрать «${inst.name}» из приложения?`,
      body:
        'Аккаунт на том инстансе останется — вы просто выйдете из него на этом устройстве. Вернуть можно в любой момент ' +
        'кнопкой «Добавить инстанс».' +
        (guests > 0 ? ' Гостевые входы через этот аккаунт тоже закроются.' : ''),
      confirmLabel: 'Убрать',
    });
    if (!ok) return;
    const wasActive = inst.id === currentHome;
    // Голос на убираемой записи (или её гостевой) заканчиваем: он переживает переходы (01.10), но не потерю записи —
    // «выйти на этом устройстве» не должно оставлять микрофон в комнате того инстанса.
    const v = useStore.getState().voice;
    if (v?.instanceId && readInstances().some((i) => i.id === v.instanceId && (i.id === inst.id || i.guestOf === inst.id)))
      useStore.getState().leaveVoice();
    removeInstance(inst.id);
    refresh();
    // Убрали ту запись, в которой стояли: активной стала соседняя — принимаем её, иначе приложение
    // осталось бы с токеном и адресом удалённого инстанса до ближайшей перезагрузки.
    if (wasActive) {
      onClose();
      void adoptActiveInstance();
    }
  }

  return (
    <div className="settings-pane">
      <div className="settings-group-label" id="set-g-instances">
        Мои инстансы
      </div>
      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        Инстанс — отдельный сервер GusVoice со своими аккаунтами: свой у вас, свой может быть у друзей. Если у вас есть
        аккаунт на другом инстансе, добавьте его сюда — его серверы встанут в левую колонку отдельной группой, и
        переходить между инстансами можно прямо оттуда, как между серверами. Здесь — добавить, переименовать или убрать.
      </div>

      <ul className="inst-list inst-list-settings">
        {own.map((inst) => {
          const here = inst.id === currentHome;
          return (
            <li key={inst.id} className={`inst-row ${here ? 'active' : ''}`}>
              {renaming === inst.id ? (
                <input
                  className="inst-rename"
                  value={renameVal}
                  autoFocus
                  aria-label="Новое название инстанса"
                  onChange={(e) => setRenameVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(inst.id);
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  onBlur={() => commitRename(inst.id)}
                />
              ) : (
                <div className="inst-row-main static">
                  <span className="inst-row-icon">
                    {inst.avatarUrl ? (
                      <Avatar url={inst.avatarUrl} name={inst.name} size={28} />
                    ) : (
                      <span className="inst-initial sm">{(inst.name || '?')[0]?.toUpperCase()}</span>
                    )}
                  </span>
                  <span className="inst-row-meta">
                    <span className="inst-row-name">{inst.name}</span>
                    <span className="inst-row-host">
                      {serverHost(inst.apiUrl)}
                      {inst.displayName ? ` · вы ${inst.displayName}` : ''}
                      {inst.token ? '' : ' · не выполнен вход'}
                    </span>
                  </span>
                  {here && <span className="inst-row-here">вы здесь</span>}
                </div>
              )}

              {renaming !== inst.id && (
                <span className="inst-row-actions">
                  {!here && (
                    <button type="button" title="Перейти в этот инстанс" onClick={() => void goTo(inst.id)}>
                      <Icon name="chevron-right" size={15} />
                    </button>
                  )}
                  <button
                    type="button"
                    title="Переименовать"
                    onClick={() => {
                      setRenaming(inst.id);
                      setRenameVal(inst.name);
                    }}
                  >
                    <Icon name="edit" size={15} />
                  </button>
                  <button
                    type="button"
                    title={here ? 'Нельзя убрать инстанс, в котором вы сейчас' : 'Убрать из приложения'}
                    disabled={here}
                    onClick={() => void remove(inst)}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <button type="button" className="inst-add" onClick={() => setAdding(true)}>
        <Icon name="plus" size={16} />
        Добавить инстанс
      </button>

      {adding && (
        <AddInstanceModal
          onClose={() => {
            setAdding(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}
