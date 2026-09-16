import { type Category, has, Permission, permsFromString, type Server } from '@gusvoice/shared';
import { useRef, useState } from 'react';
import { api } from '../api';
import { config } from '../config';
import { useStore } from '../store';
import { toast, toastError } from '../toast';
import { AvatarCropModal } from './AvatarCropModal';
import { AuditLogView } from './AuditLogView';
import { BansPanel } from './BansPanel';
import { CategoryPermissionsEditor } from './CategoryPermissionsEditor';
import { Icon } from './Icon';
import { serverSettingsTabs, type ServerSettingsTab } from '../serverSettingsTabs';
import { ServerEmojiPanel } from './ServerEmojiPanel';
import { ServerStickerPanel } from './ServerStickerPanel';
import { EconomyPanel } from './EconomyPanel';
import { ServerSoundboardPanel } from './ServerSoundboardPanel';
import { ServerSoundsPanel } from './ServerSoundsPanel';
import { economyVisible } from '../economyVisible';


export function ServerSettingsModal({
  server,
  categories,
  canDelete,
  onClose,
}: {
  server: Server;
  categories: Category[];
  canDelete: boolean;
  onClose: () => void;
}) {
  const serverPerms = permsFromString(useStore((s) => s.bootstrap?.permissions));
  // Список вкладок и условие показа пункта меню считает ОДИН модуль (`serverSettingsTabs.ts`).
  // Раньше они жили порознь и разъезжались: вкладка появлялась, а войти в настройки было нельзя.
  // Вкладка «Монеты» — по флагу ЧЕЛОВЕКА (`economyPreview`), а не инстанса: владельцу любого
  // сервера выдаются все права разом, и на голом флаге инстанса вкладку увидел бы владелец чужого
  // сервера (#117, закрытая обкатка).
  const economyShown = economyVisible(useStore((s) => s.user?.economyPreview), config.economyEnabled === true);
  const tabs = serverSettingsTabs(serverPerms, { economy: economyShown });
  const canGeneral = tabs.some((t) => t.key === 'general');
  // Внутри «Основного» два РАЗНЫХ права: имя сервера — MANAGE_SERVER, категории — MANAGE_CHANNELS
  // (именно его требуют роуты категорий). Показывать блок, на который придёт 403, нельзя: молчаливый
  // отказ читается как «приложение сломалось», а не «мне не положено».
  const canRenameServer = has(serverPerms, Permission.MANAGE_SERVER);
  const canManageCategories = has(serverPerms, Permission.MANAGE_CHANNELS);
  // Оверрайды категории требуют MANAGE_ROLES — кнопка «доступ» не должна вести в 403.
  const canEditOverwrites = has(serverPerms, Permission.MANAGE_ROLES);
  const [tab, setTab] = useState<ServerSettingsTab>(tabs[0]?.key ?? 'general');
  const [permCat, setPermCat] = useState<Category | null>(null);
  const [name, setName] = useState(server.name);
  const [newCat, setNewCat] = useState('');
  const [catNames, setCatNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // Иконка сервера (#74): выбранный файл ждёт кропа; GIF идёт мимо, чтобы не потерять анимацию.
  const [cropFile, setCropFile] = useState<File | null>(null);
  const iconRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => useStore.getState().openServer(server.id);
  const reloadList = () => useStore.getState().loadServers();

  async function saveName() {
    if (!name.trim() || name.trim() === server.name) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateServer(server.id, { name: name.trim() });
      await reloadList();
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function uploadIcon(f: File | Blob) {
    setBusy(true);
    setError(null);
    try {
      const file = f instanceof File ? f : new File([f], 'icon.png', { type: 'image/png' });
      await api.uploadServerIcon(server.id, file);
      setCropFile(null);
      // Рейл читает список серверов, а не bootstrap — обновляем оба.
      await reloadList();
      await refresh();
      toast('success', 'Иконка обновлена');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function clearIcon() {
    setBusy(true);
    setError(null);
    try {
      await api.updateServer(server.id, { iconUrl: null });
      await reloadList();
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addCategory() {
    const n = newCat.trim();
    if (!n) return;
    setBusy(true);
    setError(null);
    try {
      await api.createCategory(server.id, n);
      setNewCat('');
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function renameCategory(c: Category) {
    const next = (catNames[c.id] ?? c.name).trim();
    const clear = () =>
      setCatNames((m) => {
        const n = { ...m };
        delete n[c.id];
        return n;
      });
    if (!next || next === c.name) {
      clear();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.updateCategory(c.id, next);
      clear();
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function moveCategory(index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= categories.length) return;
    const arr = [...categories];
    [arr[index], arr[j]] = [arr[j], arr[index]];
    setBusy(true);
    setError(null);
    try {
      await api.reorderCategories(
        server.id,
        arr.map((c, i) => ({ categoryId: c.id, position: i })),
      );
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function delCategory(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.deleteCategory(id);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function delServer() {
    if (!confirm(`Удалить сервер «${server.name}» со всеми каналами и сообщениями? Необратимо.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteServer(server.id);
      await reloadList();
      useStore.setState({ currentServerId: null, bootstrap: null, currentChannelId: null });
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal admin" onClick={(e) => e.stopPropagation()}>
        <div className="admin-head">
          <h2>Настройки сервера</h2>
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>

        {tabs.length > 1 && (
          <div className="admin-tabs">
            {tabs.map((t) => (
              <button key={t.key} type="button" className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
        )}

        {/*
          🔴 Прокрутка вкладок. Без неё модалка с `max-height: 85vh` просто ОБРЕЗАЛА содержимое:
          прокручиваемого предка не было ни одного, а документ не спасает — оверлей `fixed`, и
          переполнение фиксированного элемента прокрутку страницы не создаёт. Замерено на стенде:
          `scrollableAncestors: []`, `scrollHeight` больше `clientHeight` уже на восьми звуках.

          ⚠️ Обёрнута ВСЯ область вкладок, а не саундборд, с которого пришла жалоба (08.09): дыра
          одна на все семь вкладок, и первой до неё доросла та, где список растёт руками владельца.
          Экономика с её двумя десятками ползунков — следующая на очереди.
          ⚠️ `min-height: 0` внутри `.admin-scroll` обязателен и уже там есть: во флекс-колонке
          элемент не сжимается ниже своего содержимого, и `overflow: auto` без него не сработал бы.
        */}
        <div className="admin-scroll">
        {tab === 'audit' ? (
          <AuditLogView serverId={server.id} />
        ) : tab === 'bans' ? (
          <BansPanel serverId={server.id} />
        ) : tab === 'emoji' ? (
          <ServerEmojiPanel serverId={server.id} />
        ) : tab === 'stickers' ? (
          <ServerStickerPanel serverId={server.id} />
        ) : tab === 'sounds' ? (
          <ServerSoundsPanel serverId={server.id} />
        ) : tab === 'soundboard' ? (
          <ServerSoundboardPanel serverId={server.id} />
        ) : tab === 'economy' ? (
          <EconomyPanel serverId={server.id} />
        ) : !canGeneral ? (
          // Сюда штатно не попасть: пункт меню показывается той же функцией, что считает вкладки.
          // Страховка на случай, если модалку однажды откроют из нового места, забыв про права —
          // молча показать чужому «Опасную зону» с удалением сервера было бы дорогой ошибкой.
          <div className="muted">Нет доступных настроек.</div>
        ) : (
          <>
        {canRenameServer && (
        <div className="srv-icon-row">
          <button
            type="button"
            className="srv-icon-drop"
            title="Загрузить иконку"
            disabled={busy}
            onClick={() => iconRef.current?.click()}
          >
            {server.iconUrl ? <img src={server.iconUrl} alt="" /> : <span>{server.name[0]?.toUpperCase()}</span>}
          </button>
          <div className="srv-icon-text">
            <div className="cat-name">Иконка сервера</div>
            <div className="muted" style={{ fontSize: 12 }}>
              PNG, JPEG, WebP или GIF до 5 МБ. Анимация GIF сохраняется. Пусто — первая буква названия.
            </div>
            <div className="settings-row" style={{ gap: 8, marginTop: 6 }}>
              <button type="button" className="seg-mini" disabled={busy} onClick={() => iconRef.current?.click()}>
                {busy ? '…' : 'Загрузить'}
              </button>
              {server.iconUrl && (
                <button type="button" className="danger-text" disabled={busy} onClick={() => void clearIcon()}>
                  убрать
                </button>
              )}
            </div>
          </div>
          <input
            ref={iconRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              // GIF мимо кропа — canvas сплющил бы анимацию в один кадр.
              if (f.type === 'image/gif') void uploadIcon(f);
              else setCropFile(f);
            }}
          />
        </div>
        )}

        {canRenameServer && (
        <div className="row-field">
          <label className="field">
            Название сервера
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button type="button" onClick={saveName} disabled={busy || !name.trim() || name.trim() === server.name}>
            Сохранить
          </button>
        </div>
        )}

        {canManageCategories && (
        <div>
          <div className="cat-name">Категории</div>
          <ul className="cat-manage">
            {categories.map((c, i) => (
              <li key={c.id}>
                <input
                  className="cat-rename"
                  value={catNames[c.id] ?? c.name}
                  onChange={(e) => setCatNames((m) => ({ ...m, [c.id]: e.target.value }))}
                  onBlur={() => renameCategory(c)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                  }}
                  disabled={busy}
                />
                <button
                  type="button"
                  className="cat-move"
                  title="Выше"
                  onClick={() => moveCategory(i, -1)}
                  disabled={busy || i === 0}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="cat-move"
                  title="Ниже"
                  onClick={() => moveCategory(i, 1)}
                  disabled={busy || i === categories.length - 1}
                >
                  ↓
                </button>
                {canEditOverwrites && (
                  <button type="button" className="link" onClick={() => setPermCat(c)}>
                    доступ
                  </button>
                )}
                <button type="button" className="danger-text" onClick={() => delCategory(c.id)} disabled={busy}>
                  удалить
                </button>
              </li>
            ))}
            {categories.length === 0 && <li className="muted">пока нет категорий</li>}
          </ul>
          <div className="row-field">
            <input placeholder="новая категория" value={newCat} onChange={(e) => setNewCat(e.target.value)} />
            <button type="button" onClick={addCategory} disabled={busy || !newCat.trim()}>
              Добавить
            </button>
          </div>
        </div>
        )}

        {error && <div className="error">{error}</div>}

        {canDelete && (
          <div className="danger-zone">
            <strong>Опасная зона</strong>
            <TransferOwnershipBox server={server} onDone={() => { refresh(); onClose(); }} />
            <button type="button" className="leave" onClick={delServer} disabled={busy}>
              Удалить сервер
            </button>
          </div>
        )}
          </>
        )}
        </div>
      </div>

      {cropFile && (
        <AvatarCropModal
          file={cropFile}
          busy={busy}
          onCancel={() => setCropFile(null)}
          onCrop={(b) => void uploadIcon(b)}
        />
      )}

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
              Эти права наследуют все каналы категории как базу. Права отдельного канала (вкладка «Доступ» у
              канала) переопределяют их — приватность канала важнее доступа категории.
            </div>
            <CategoryPermissionsEditor category={permCat} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Owner-only: hand the server to another member, confirmed by re-typing the server name. */
function TransferOwnershipBox({ server, onDone }: { server: Server; onDone: () => void }) {
  const members = useStore((s) => s.members);
  const me = useStore((s) => s.user);
  const [open, setOpen] = useState(false);
  const [newOwnerId, setNewOwnerId] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);
  const candidates = members.filter((m) => m.user.id !== me?.id);

  async function transfer() {
    if (!newOwnerId || confirmName.trim() !== server.name) return;
    setBusy(true);
    try {
      await api.transferOwnership(server.id, newOwnerId);
      toast('success', 'Владение передано');
      onDone();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="acc-ghost" onClick={() => { setNewOwnerId(''); setConfirmName(''); setOpen(true); }}>
        Передать владение
      </button>
    );
  }
  return (
    <div className="transfer-box">
      <select className="settings-select" value={newOwnerId} onChange={(e) => setNewOwnerId(e.target.value)}>
        <option value="">Выберите нового владельца…</option>
        {candidates.map((m) => (
          <option key={m.user.id} value={m.user.id}>
            {m.nickname || m.user.displayName} (@{m.user.username})
          </option>
        ))}
      </select>
      <input
        className="settings-select"
        value={confirmName}
        onChange={(e) => setConfirmName(e.target.value)}
        placeholder={`Введите «${server.name}» для подтверждения`}
      />
      <div className="settings-row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" className="acc-ghost" onClick={() => setOpen(false)}>
          Отмена
        </button>
        <button type="button" className="leave" onClick={() => void transfer()} disabled={busy || !newOwnerId || confirmName.trim() !== server.name}>
          Передать
        </button>
      </div>
    </div>
  );
}
