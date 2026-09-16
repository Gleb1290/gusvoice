import { type Category, type Channel, has, Permission, permsFromString } from '@gusvoice/shared';
import { type ReactNode, useState } from 'react';
import { api } from '../api';
import {
  isCategoryCollapsed,
  notifyLevel,
  setNotifyLevel,
  toggleCategoryCollapse,
  useChannelPrefsVersion,
} from '../channelPrefs';
import { useStore } from '../store';
import { toast, toastError } from '../toast';
import { CategoryPermissionsEditor } from './CategoryPermissionsEditor';
import { ChannelSettingsModal } from './ChannelSettingsModal';
import { ContextMenu, MenuDivider, MenuItem, MenuSection, type MenuPos } from './ContextMenu';
import { CreateChannelModal } from './CreateChannelModal';
import { Icon } from './Icon';

type Target =
  | { kind: 'channel'; channel: Channel; pos: MenuPos }
  | { kind: 'category'; category: Category; pos: MenuPos };

function copyLink(url: string) {
  navigator.clipboard
    ?.writeText(url)
    .then(() => toast('success', 'Ссылка скопирована'))
    .catch(() => toast('error', 'Не удалось скопировать'));
}

/** Mark a set of channels read without opening them (clears the client-side unread flags). */
function markRead(ids: string[]) {
  useStore.setState((s) => {
    const unreadCounts = { ...s.unreadCounts };
    for (const id of ids) delete unreadCounts[id];
    return { unreadCounts };
  });
}

/**
 * Right-click menus for channel rows and category headers (round-7 P5). Returns openers to
 * spread onto onContextMenu plus a `menus` node to render once. Self-contained: it owns the
 * modals its actions spawn (channel settings, create-channel, rename/permissions of a category).
 */
export function useChannelContextMenu(): {
  openChannelMenu: (e: React.MouseEvent, channel: Channel) => void;
  openCategoryMenu: (e: React.MouseEvent, category: Category) => void;
  menus: ReactNode;
} {
  const [target, setTarget] = useState<Target | null>(null);
  const [editChannel, setEditChannel] = useState<{ channel: Channel; tab: 'main' | 'access' } | null>(null);
  const [createInCat, setCreateInCat] = useState<string | null>(null);
  const [renameCat, setRenameCat] = useState<Category | null>(null);
  const [permCat, setPermCat] = useState<Category | null>(null);

  const bootstrap = useStore((s) => s.bootstrap);
  const openChannel = useStore((s) => s.openChannel);
  const joinVoice = useStore((s) => s.joinVoice);
  const voice = useStore((s) => s.voice);
  useChannelPrefsVersion(); // re-render on mute/collapse toggles so labels/icons update live

  const userId = useStore((s) => s.user?.id);
  const perms = permsFromString(bootstrap?.permissions);
  const canManage = has(perms, Permission.MANAGE_CHANNELS);
  const canManageSounds = has(perms, Permission.MANAGE_SOUNDS);
  // MANAGE_SERVER тоже открывает вкладку «Генерал» внутри настроек канала — значит и вход сюда.
  const canManageServer = has(perms, Permission.MANAGE_SERVER);
  const close = () => setTarget(null);

  function openChannelMenu(e: React.MouseEvent, channel: Channel) {
    e.preventDefault();
    e.stopPropagation();
    setTarget({ kind: 'channel', channel, pos: { x: e.clientX, y: e.clientY } });
  }
  function openCategoryMenu(e: React.MouseEvent, category: Category) {
    e.preventDefault();
    e.stopPropagation();
    setTarget({ kind: 'category', category, pos: { x: e.clientX, y: e.clientY } });
  }

  function enter(c: Channel) {
    if (c.type !== 'voice' || voice?.channelId === c.id) {
      void openChannel(c.id);
      return;
    }
    joinVoice(c.id)
      .then(() => openChannel(c.id))
      .catch((err) => toastError(err));
  }

  async function delChannel(c: Channel) {
    if (!confirm(`Удалить канал «${c.name}»? Это необратимо.`)) return;
    try {
      await api.deleteChannel(c.id);
      await useStore.getState().openServer(c.serverId);
    } catch (err) {
      toastError(err);
    }
  }

  async function delCategory(cat: Category) {
    if (!confirm(`Удалить категорию «${cat.name}»? Каналы внутри останутся без категории.`)) return;
    try {
      await api.deleteCategory(cat.id);
      await useStore.getState().openServer(cat.serverId);
    } catch (err) {
      toastError(err);
    }
  }

  const linkBase = typeof location !== 'undefined' ? location.origin : '';

  // Capture the narrowed target into a local const so the discriminated-union narrowing flows
  // into the onClick closures below (it would not flow through `target?.kind === ...` alone).
  const c = target?.kind === 'channel' ? target.channel : null;
  const cat = target?.kind === 'category' ? target.category : null;

  const channelMenu = c && target?.kind === 'channel' && (
    <ContextMenu pos={target.pos} onClose={close} width={232}>
      <MenuItem
        icon="chevron-right"
        label={c.type === 'voice' ? 'Войти в канал' : 'Открыть'}
        onClick={() => {
          enter(c);
          close();
        }}
      />
      {c.type === 'text' && (
        <MenuItem
          icon="check"
          label="Пометить прочитанным"
          onClick={() => {
            markRead([c.id]);
            close();
          }}
        />
      )}
      <MenuDivider />
      <MenuSection>Уведомления</MenuSection>
      {(
        [
          ['all', 'bell', 'Все сообщения'],
          ['mentions', 'at', 'Только упоминания'],
          ['none', 'bell-off', 'Выключить'],
        ] as const
      ).map(([lvl, icon, label]) => (
        <MenuItem
          key={lvl}
          icon={icon}
          label={label}
          active={notifyLevel(c.id) === lvl}
          onClick={() => {
            setNotifyLevel(c.id, lvl);
            close();
          }}
        />
      ))}
      <MenuDivider />
      <MenuItem
        icon="link"
        label="Копировать ссылку"
        onClick={() => {
          copyLink(`${linkBase}/channels/${c.serverId}/${c.id}`);
          close();
        }}
      />
      {canManage && (
        <>
          <MenuDivider />
          <MenuItem
            icon="settings"
            label="Изменить канал"
            onClick={() => {
              setEditChannel({ channel: c, tab: 'main' });
              close();
            }}
          />
          <MenuItem
            icon="shield"
            label="Права доступа"
            onClick={() => {
              setEditChannel({ channel: c, tab: 'access' });
              close();
            }}
          />
          <MenuDivider />
          <MenuItem
            icon="trash"
            label="Удалить канал"
            danger
            onClick={() => {
              close();
              void delChannel(c);
            }}
          />
        </>
      )}
      {/* Channel general (or a MANAGE_SOUNDS holder) without MANAGE_CHANNELS: a way into their channel
          sounds, since they don't get the "Изменить канал" entry above. The modal lands them on its
          "Генерал" tab. */}
      {!canManage && c.type === 'voice' && (canManageServer || canManageSounds || c.generalUserId === userId) && (
        <>
          <MenuDivider />
          <MenuItem
            icon="settings"
            label={canManageServer ? 'Настройки канала' : 'Звуки канала'}
            onClick={() => {
              setEditChannel({ channel: c, tab: 'main' });
              close();
            }}
          />
        </>
      )}
    </ContextMenu>
  );

  const categoryMenu = cat && target?.kind === 'category' && (
    <ContextMenu pos={target.pos} onClose={close} width={232}>
      <MenuItem
        icon={isCategoryCollapsed(cat.id) ? 'chevron-right' : 'chevron-down'}
        label={isCategoryCollapsed(cat.id) ? 'Развернуть категорию' : 'Свернуть категорию'}
        onClick={() => {
          toggleCategoryCollapse(cat.id);
          close();
        }}
      />
      <MenuItem
        icon="check"
        label="Пометить прочитанным"
        onClick={() => {
          const ids = (bootstrap?.channels ?? []).filter((ch) => ch.categoryId === cat.id).map((ch) => ch.id);
          markRead(ids);
          close();
        }}
      />
      {canManage && (
        <>
          <MenuDivider />
          <MenuItem
            icon="plus"
            label="Создать канал"
            onClick={() => {
              setCreateInCat(cat.id);
              close();
            }}
          />
          <MenuItem
            icon="settings"
            label="Изменить категорию"
            onClick={() => {
              setRenameCat(cat);
              close();
            }}
          />
          <MenuItem
            icon="shield"
            label="Права доступа"
            onClick={() => {
              setPermCat(cat);
              close();
            }}
          />
          <MenuDivider />
          <MenuItem
            icon="trash"
            label="Удалить категорию"
            danger
            onClick={() => {
              close();
              void delCategory(cat);
            }}
          />
        </>
      )}
    </ContextMenu>
  );

  const menus = (
    <>
      {channelMenu}
      {categoryMenu}
      {editChannel && bootstrap && (
        <ChannelSettingsModal
          channel={editChannel.channel}
          categories={bootstrap.categories}
          initialTab={editChannel.tab}
          onClose={() => setEditChannel(null)}
        />
      )}
      {createInCat !== null && bootstrap && (
        <CreateChannelModal
          serverId={bootstrap.server.id}
          categories={bootstrap.categories}
          defaultCategoryId={createInCat}
          onClose={() => setCreateInCat(null)}
        />
      )}
      {renameCat && <CategoryRenameModal category={renameCat} onClose={() => setRenameCat(null)} />}
      {permCat && (
        <div className="modal-overlay" onClick={() => setPermCat(null)}>
          <div className="modal channel-settings" onClick={(e) => e.stopPropagation()}>
            <div className="admin-head">
              <h2>Доступ · {permCat.name}</h2>
              <button type="button" className="icon-close" title="Закрыть" onClick={() => setPermCat(null)}>
                <Icon name="close" size={18} />
              </button>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              Эти права наследуют все каналы категории как базу. Права отдельного канала переопределяют их —
              приватность канала важнее доступа категории.
            </div>
            <CategoryPermissionsEditor category={permCat} />
          </div>
        </div>
      )}
    </>
  );

  return { openChannelMenu, openCategoryMenu, menus };
}

function CategoryRenameModal({ category, onClose }: { category: Category; onClose: () => void }) {
  const [name, setName] = useState(category.name);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n || n === category.name) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      await api.updateCategory(category.id, n);
      await useStore.getState().openServer(category.serverId);
      onClose();
    } catch (err) {
      toastError(err);
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal create-channel" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="admin-head">
          <h2>Переименовать категорию</h2>
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <label className="field">
          Название
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <div className="modal-actions">
          <button type="button" className="link" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" disabled={busy || !name.trim()}>
            {busy ? '…' : 'Сохранить'}
          </button>
        </div>
      </form>
    </div>
  );
}
