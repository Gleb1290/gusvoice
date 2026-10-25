import { type Category, has, Permission, permsFromString, type Server } from '@gusvoice/shared';
import { useEffect, useRef, useState } from 'react';
import { pushBackHandler } from '../androidBack';
import { api } from '../api';
import { config } from '../config';
import { tabListKeyDown, useDialogChrome } from '../dialogChrome';
import { useStore } from '../store';
import { toast, toastError } from '../toast';
import { AvatarCropModal } from './AvatarCropModal';
import { AuditLogView } from './AuditLogView';
import { BansPanel } from './BansPanel';
import { CategoryPermissionsEditor } from './CategoryPermissionsEditor';
import { Icon } from './Icon';
import { serverSettingsTabs, type ServerSettingsTab } from '../serverSettingsTabs';
import { ServerRolesPanel } from './ServerRolesPanel';
import { ServerEmojiPanel } from './ServerEmojiPanel';
import { ServerStickerPanel } from './ServerStickerPanel';
import { EconomyPanel } from './EconomyPanel';
import { ServerSoundboardPanel } from './ServerSoundboardPanel';
import { ServerSoundsPanel } from './ServerSoundsPanel';
import { ServerWebhooksPanel } from './ChannelWebhooksPanel';
import { economyVisible } from '../economyVisible';
import { confirmAction } from '../confirm';
import { Select } from './Select';
import { RailItem, SettingsHead, SettingsRail, SettingsWindow } from './SettingsShell';


export function ServerSettingsModal({
  server,
  categories,
  canDelete,
  onClose,
  initialTab,
}: {
  server: Server;
  categories: Category[];
  canDelete: boolean;
  onClose: () => void;
  /** С какого раздела открыть (кнопка 👥 открывает «Роли»). Недоступный раздел молча не берём. */
  initialTab?: ServerSettingsTab;
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
  const canManageRoles = has(serverPerms, Permission.MANAGE_ROLES);
  const canKick = has(serverPerms, Permission.KICK_MEMBERS);
  const selfId = useStore((s) => s.user?.id ?? '');
  const startTab = initialTab && tabs.some((t) => t.key === initialTab) ? initialTab : undefined;
  const [tab, setTab] = useState<ServerSettingsTab>(startTab ?? tabs[0]?.key ?? 'general');
  // Телефон: сперва список разделов, тап — экран раздела (как в настройках и админке). Открыли сразу
  // на разделе (кнопка 👥) — список пропускаем: человек уже сказал, куда шёл.
  const [picked, setPicked] = useState(!!startTab);
  const current = tabs.find((t) => t.key === tab);
  const [permCat, setPermCat] = useState<Category | null>(null);
  const [name, setName] = useState(server.name);
  const [newCat, setNewCat] = useState('');
  const [catNames, setCatNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // Иконка сервера (#74): выбранный файл ждёт кропа; GIF идёт мимо, чтобы не потерять анимацию.
  const [cropFile, setCropFile] = useState<File | null>(null);
  const iconRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Esc закрывает сначала вложенное окно, а не все настройки разом: «Доступ» категории своего
  // обработчика не имеет, и без этой развилки Esc в нём уносил бы и настройки сервера.
  const dialogRef = useDialogChrome<HTMLDivElement>(() => {
    if (permCat) setPermCat(null);
    else if (cropFile) setCropFile(null);
    else onClose();
  });
  const onTabsKey = tabListKeyDown(
    tabs.map((t) => t.key),
    tab,
    setTab,
    (k) => `ss-tab-${k}`,
  );

  /** Системная «назад» на телефоне: из раздела — к списку разделов, и только потом закрытие окна. */
  useEffect(() => {
    if (!picked) return;
    return pushBackHandler(() => {
      setPicked(false);
      return true;
    });
  }, [picked]);

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
    const ok = await confirmAction({
      title: `Удалить сервер «${server.name}»?`,
      body: 'Вместе с ним исчезнут все каналы, сообщения и роли — у всех участников. Отменить это нельзя.',
      tone: 'danger',
      confirmLabel: 'Удалить сервер',
      // Самое тяжёлое действие в приложении: просим набрать имя сервера.
      requireText: server.name,
    });
    if (!ok) return;
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
    <SettingsWindow
      variant="server"
      picked={picked}
      onClose={onClose}
      titleId="ss-title"
      dialogRef={dialogRef}
      // Рельс разделов — как в настройках пользователя и в админке (23.09): десять слов в строку вкладок уже не
      // помещались, и ни одно не говорило, что внутри.
      rail={
        <SettingsRail
          // Имя сервера, а не «Настройки сервера»: у человека их несколько, и строка выделенного раздела не говорит,
          // ЧЕЙ это раздел.
          title={server.name}
          named
          label="Разделы настроек сервера"
          onClose={onClose}
          onListKeyDown={onTabsKey}
        >
          {tabs.map((t) => (
            <RailItem
              key={t.key}
              id={`ss-tab-${t.key}`}
              aria-controls="ss-panel-body"
              tabIndex={tab === t.key ? 0 : -1}
              icon={t.icon}
              label={t.label}
              active={tab === t.key}
              onClick={() => {
                setTab(t.key);
                setPicked(true);
              }}
            />
          ))}
        </SettingsRail>
      }
      outside={
        <>
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
        </>
      }
    >
        <SettingsHead
          title={current?.label ?? 'Настройки сервера'}
          titleId="ss-title"
          sub={current?.sub}
          onBack={() => setPicked(false)}
          onClose={onClose}
        />

        {/*
          🔴 Прокрутка вкладок. Без неё модалка с `max-height: 85vh` просто ОБРЕЗАЛА содержимое:
          прокручиваемого предка не было ни одного, а документ не спасает — оверлей `fixed`, и
          переполнение фиксированного элемента прокрутку страницы не создаёт. Замерено на стенде:
          `scrollableAncestors: []`, `scrollHeight` больше `clientHeight` уже на восьми звуках.

          ⚠️ Обёрнута ВСЯ область вкладок, а не саундборд, с которого пришла жалоба (08.09): дыра
          одна на все семь вкладок, и первой до неё доросла та, где список растёт руками владельца.
          ⚠️ `min-height: 0` внутри `.admin-scroll` обязателен и уже там есть: во флекс-колонке
          элемент не сжимается ниже своего содержимого, и `overflow: auto` без него не сработал бы.
          ⚠️ «Роли» и «Участники» — вне этой прокрутки: редактор ролей держит свои (см. ServerRolesPanel).
          Один элемент на оба раздела в ОДНОМ месте дерева — переход между ними не перезагружает списки.
        */}
        {tab === 'roles' || tab === 'members' ? (
          <ServerRolesPanel
            serverId={server.id}
            ownerId={server.ownerId}
            selfId={selfId}
            canManageRoles={canManageRoles}
            canKick={canKick}
            view={tab}
          />
        ) : (
        <div className="admin-scroll" id="ss-panel-body" role="tabpanel" aria-labelledby={`ss-tab-${tab}`}>
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
        ) : tab === 'integrations' ? (
          <ServerWebhooksPanel serverId={server.id} />
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
        )}
    </SettingsWindow>
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
      <Select
        value={newOwnerId}
        onChange={setNewOwnerId}
        placeholder="Выберите нового владельца…"
        ariaLabel="Новый владелец"
        title="Новый владелец"
        searchPlaceholder="Поиск участника"
        options={candidates.map((m) => ({
          value: m.user.id,
          label: m.nickname || m.user.displayName,
          hint: `@${m.user.username}`,
        }))}
      />
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
