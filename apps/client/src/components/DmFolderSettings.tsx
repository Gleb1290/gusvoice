import { useEffect, useMemo, useState } from 'react';
import {
  DM_FOLDER_CHATS_MAX,
  DM_FOLDER_EMOTICONS,
  DM_FOLDER_NO_MUTED,
  DM_FOLDER_NO_READ,
  DM_FOLDER_GROUPS,
  DM_FOLDER_PERSONAL,
  DM_FOLDER_TITLE_MAX,
  DM_FOLDERS_MAX,
  dmFolderContains,
  dmFolderDefaultIcon,
  dmFolderInputError,
  dmFolderInputErrorText,
  dmFolderTitle,
  dmFolderTitleLength,
  type DmChannel,
  type DmFolder,
  type DmFolderInput,
} from '@gusvoice/shared';
import { confirmAction } from '../confirm';
import { serverGroups } from '../convSyncRules';
import { dmMuteOf, muteActive } from '../dmListRules';
import { matchDmName } from '../dmRowRules';
import { useDmFolders } from '../dmFolders';
import { dmPeerLabel, usePeerName } from '../peerName';
import { useStore } from '../store';
import { toastError } from '../toast';
import { Avatar } from './Avatar';
import { takeFolderEditRequest } from './DmFolderBar';
import { Icon } from './Icon';

/**
 * Раздел настроек «Папки» (07.10, #211, G40, `folders1`) — по Telegram: список папок (`boxes/filters/edit_filter_box.cpp`,
 * `settings_folders.cpp`; Android `FiltersSetupActivity`): «Создать папку», рекомендуемые папки («Непрочитанные», «Со
 * звуком» — `lng_filters_name_unread` / `_unmuted`), порядок, удаление. Редактор (`FilterCreateActivity`): название
 * до 12 знаков, значок, «Включённые беседы» (тип «Личные» + беседы), «Исключённые беседы» (типы «Без звука»,
 * «Прочитанные» + беседы). Перестановка — стрелками (у Telegram — перетаскиванием).
 */

type Editing = { id: string | null; draft: DmFolderInput };

const EMPTY: DmFolderInput = { title: '', emoticon: null, flags: 0, include: [], exclude: [] };

const RECOMMENDED: { title: string; flags: number; about: string }[] = [
  { title: 'Непрочитанные', flags: DM_FOLDER_PERSONAL | DM_FOLDER_NO_READ, about: 'Беседы с новыми сообщениями' },
  { title: 'Со звуком', flags: DM_FOLDER_PERSONAL | DM_FOLDER_NO_MUTED, about: 'Беседы с включёнными уведомлениями' },
];

function useChatStates() {
  const dms = useStore((s) => s.dms);
  const mutedUsers = useStore((s) => s.pushMutedDmUsers);
  const muteUntil = useStore((s) => s.pushMuteUntil);
  return useMemo(() => {
    const now = Date.now();
    return dms.map((d) => ({
      dm: d,
      chat: {
        id: d.id,
        muted: muteActive(dmMuteOf(d, mutedUsers, muteUntil), now),
        unread: (d.unread ?? 0) > 0 || d.markedUnread === true,
      },
    }));
  }, [dms, mutedUsers, muteUntil]);
}

function chatsWord(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} беседа`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} беседы`;
  return `${n} бесед`;
}

export function DmFolderSettings() {
  const folders = useDmFolders((s) => s.folders);
  const chats = useChatStates();
  const [editing, setEditing] = useState<Editing | null>(null);

  useEffect(() => {
    useDmFolders.getState().load().catch(toastError);
  }, []);
  // Пришли из меню вкладки или беседы — сразу в редактор нужной папки.
  useEffect(() => {
    const r = takeFolderEditRequest();
    if (!r || r.id === null) return;
    if (r.id === 'new') setEditing({ id: null, draft: { ...EMPTY, include: r.include ? [r.include] : [] } });
    else {
      const f = useDmFolders.getState().folders?.find((x) => x.id === r.id);
      if (f) setEditing({ id: f.id, draft: { title: f.title, emoticon: f.emoticon, flags: f.flags, include: f.include, exclude: f.exclude } });
    }
  }, []);

  if (editing) return <FolderEditor editing={editing} onDone={() => setEditing(null)} />;

  const list = folders ?? [];
  const own = list.filter((f) => !f.system);
  const full = own.length >= DM_FOLDERS_MAX;
  const recommended = RECOMMENDED.filter((r) => !own.some((f) => f.flags === r.flags && f.include.length === 0 && f.exclude.length === 0));
  const move = (i: number, dir: -1 | 1) => {
    const ids = list.map((f) => f.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    useDmFolders.getState().reorder(ids).catch(toastError);
  };
  const remove = async (f: DmFolder) => {
    const ok = await confirmAction({
      title: `Удалить папку «${dmFolderTitle(f)}»?`,
      body: 'Папка исчезнет, а беседы из неё останутся в «Личных сообщениях».',
      confirmLabel: 'Удалить',
      tone: 'danger',
    });
    if (ok) await useDmFolders.getState().remove(f.id).catch(toastError);
  };

  return (
    <div className="settings-pane">
      <div className="settings-group-label" id="set-g-folders">
        Мои папки
      </div>
      <div className="muted dmf-about">
        Создавайте папки для разных бесед и быстро переключайтесь между ними. Одна беседа может быть в нескольких папках.
      </div>
      {folders === null && <div className="muted dmf-about">Загрузка…</div>}
      {list.map((f, i) => {
        const n = chats.filter((c) => dmFolderContains(f, c.chat)).length;
        return (
          <div key={f.id} className="dmf-row">
            <span className="dmf-ico">
              {f.emoticon ? <span aria-hidden="true">{f.emoticon}</span> : <Icon name={dmFolderDefaultIcon(f)} size={20} />}
            </span>
            <button
              type="button"
              className="dmf-main"
              disabled={!!f.system}
              onClick={() =>
                setEditing({ id: f.id, draft: { title: f.title, emoticon: f.emoticon, flags: f.flags, include: f.include, exclude: f.exclude } })
              }
            >
              <span className="dmf-title">{dmFolderTitle(f)}</span>
              <span className="dmf-sub">{f.system ? 'Все беседы один на один' : n ? chatsWord(n) : 'Нет бесед'}</span>
            </button>
            <button type="button" className="head-icon" title="Выше" aria-label="Выше" disabled={i === 0} onClick={() => move(i, -1)}>
              <Icon name="chevron-up" size={18} />
            </button>
            <button
              type="button"
              className="head-icon"
              title="Ниже"
              aria-label="Ниже"
              disabled={i === list.length - 1}
              onClick={() => move(i, 1)}
            >
              <Icon name="chevron-down" size={18} />
            </button>
            {!f.system && (
              <button type="button" className="head-icon" title="Удалить" aria-label="Удалить" onClick={() => void remove(f)}>
                <Icon name="trash" size={18} />
              </button>
            )}
          </div>
        );
      })}
      <div className="sec-actions">
        <button type="button" className="primary" disabled={full || folders === null} onClick={() => setEditing({ id: null, draft: EMPTY })}>
          <Icon name="plus" size={16} /> Создать папку
        </button>
      </div>
      {full && <div className="muted dmf-about">Папок уже {DM_FOLDERS_MAX} — больше не поместится. Удалите ненужную.</div>}
      {!full && folders !== null && recommended.length > 0 && (
        <>
          <div className="settings-group-label dmf-gap">Рекомендуемые папки</div>
          {recommended.map((r) => (
            <div key={r.title} className="dmf-row">
              <span className="dmf-ico">
                <Icon name={dmFolderDefaultIcon({ flags: r.flags, include: [], exclude: [] })} size={20} />
              </span>
              <span className="dmf-main">
                <span className="dmf-title">{r.title}</span>
                <span className="dmf-sub">{r.about}</span>
              </span>
              <button
                type="button"
                className="settings-action"
                onClick={() =>
                  void useDmFolders
                    .getState()
                    .create({ title: r.title, emoticon: null, flags: r.flags, include: [], exclude: [] })
                    .catch(toastError)
                }
              >
                Добавить
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function FolderEditor({ editing, onDone }: { editing: Editing; onDone: () => void }) {
  const [d, setD] = useState<DmFolderInput>(editing.draft);
  const [picking, setPicking] = useState<'include' | 'exclude' | null>(null);
  const nameOf = usePeerName(); // подпись контакта вместо имени (`peerName.ts`)
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const dms = useStore((s) => s.dms);
  const groupsOn = useStore((s) => serverGroups(s.serverFeatures));
  const err = dmFolderInputError(d);
  const flag = (bit: number, on: boolean) => setD({ ...d, flags: on ? d.flags | bit : d.flags & ~bit });
  const byId = (id: string) => dms.find((x) => x.id === id);

  const save = async () => {
    setTried(true);
    if (err) return;
    setBusy(true);
    try {
      const st = useDmFolders.getState();
      if (editing.id) await st.update(editing.id, d);
      else {
        const id = await st.create(d);
        st.select(id);
      }
      onDone();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  if (picking) {
    return (
      <ChatPicker
        title={picking === 'include' ? 'Добавить беседы' : 'Исключить беседы'}
        picked={picking === 'include' ? d.include : d.exclude}
        onDone={(ids) => {
          if (picking === 'include') setD({ ...d, include: ids, exclude: d.exclude.filter((x) => !ids.includes(x)) });
          else setD({ ...d, exclude: ids, include: d.include.filter((x) => !ids.includes(x)) });
          setPicking(null);
        }}
      />
    );
  }

  const chatList = (ids: string[], key: 'include' | 'exclude') =>
    ids.map((id) => {
      const dm = byId(id);
      if (!dm) return null;
      return (
        <div key={id} className="dmf-row">
          <span className="blocked-user">
            <Avatar url={dm.otherUser.avatarUrl} name={dmPeerLabel(dm, nameOf)} size={24} fallback="icon" />
            {dmPeerLabel(dm, nameOf)}
          </span>
          <button
            type="button"
            className="head-icon"
            title="Убрать"
            aria-label="Убрать"
            onClick={() => setD({ ...d, [key]: d[key].filter((x) => x !== id) })}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      );
    });

  return (
    <div className="settings-pane">
      <div className="dmf-head">
        <button type="button" className="head-icon" title="Назад" aria-label="Назад" onClick={onDone}>
          <Icon name="chevron-left" size={20} />
        </button>
        <strong>{editing.id ? 'Изменить папку' : 'Новая папка'}</strong>
      </div>
      <label className="settings-row col" id="set-g-folders">
        <span>Название папки</span>
        <input
          value={d.title}
          maxLength={DM_FOLDER_TITLE_MAX * 2}
          placeholder="Название папки"
          onChange={(e) => setD({ ...d, title: e.target.value })}
        />
        <span className={dmFolderTitleLength(d.title.trim()) > DM_FOLDER_TITLE_MAX ? 'dmf-count over' : 'dmf-count'}>
          {dmFolderTitleLength(d.title.trim())} / {DM_FOLDER_TITLE_MAX}
        </span>
      </label>
      <div className="settings-row col">
        <span>Значок</span>
        <div className="dmf-emos" role="radiogroup" aria-label="Значок">
          <button type="button" role="radio" aria-checked={!d.emoticon} className={!d.emoticon ? 'dmf-emo on' : 'dmf-emo'} onClick={() => setD({ ...d, emoticon: null })} title="По умолчанию">
            <Icon name={dmFolderDefaultIcon({ flags: d.flags, include: d.include, exclude: d.exclude })} size={18} />
          </button>
          {DM_FOLDER_EMOTICONS.map((e) => (
            <button key={e} type="button" role="radio" aria-checked={d.emoticon === e} className={d.emoticon === e ? 'dmf-emo on' : 'dmf-emo'} onClick={() => setD({ ...d, emoticon: e })}>
              {e}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-group-label dmf-gap">Включённые беседы</div>
      <div className="muted dmf-about">Беседы и типы бесед, которые попадут в эту папку.</div>
      <TypeRow label="Личные" sub="Все беседы один на один, и новые тоже" on={!!(d.flags & DM_FOLDER_PERSONAL)} set={(v) => flag(DM_FOLDER_PERSONAL, v)} />
      {/* Тип «Группы» (`groups2`, как Telegram «Типы чатов → Группы», `lng_filters_type_groups`): при сервере с группами. */}
      {groupsOn && (
        <TypeRow label="Группы" sub="Все групповые беседы, и новые тоже" on={!!(d.flags & DM_FOLDER_GROUPS)} set={(v) => flag(DM_FOLDER_GROUPS, v)} />
      )}
      {chatList(d.include, 'include')}
      <button type="button" className="settings-action dmf-add" disabled={d.include.length >= DM_FOLDER_CHATS_MAX} onClick={() => setPicking('include')}>
        <Icon name="plus" size={16} /> Добавить беседы
      </button>

      <div className="settings-group-label dmf-gap">Исключённые беседы</div>
      <div className="muted dmf-about">Беседы и типы бесед, которых в этой папке не будет.</div>
      <TypeRow label="Без звука" sub="Беседы с выключенными уведомлениями" on={!!(d.flags & DM_FOLDER_NO_MUTED)} set={(v) => flag(DM_FOLDER_NO_MUTED, v)} />
      <TypeRow label="Прочитанные" sub="Беседы без новых сообщений" on={!!(d.flags & DM_FOLDER_NO_READ)} set={(v) => flag(DM_FOLDER_NO_READ, v)} />
      {chatList(d.exclude, 'exclude')}
      <button type="button" className="settings-action dmf-add" disabled={d.exclude.length >= DM_FOLDER_CHATS_MAX} onClick={() => setPicking('exclude')}>
        <Icon name="plus" size={16} /> Исключить беседы
      </button>

      {tried && err && <div className="error dmf-err">{dmFolderInputErrorText(err)}</div>}
      <div className="sec-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
          {busy ? '…' : editing.id ? 'Сохранить' : 'Создать'}
        </button>
        <button type="button" className="settings-action" onClick={onDone}>
          Отмена
        </button>
      </div>
    </div>
  );
}

function TypeRow({ label, sub, on, set }: { label: string; sub: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} className="dmf-row dmf-check" onClick={() => set(!on)}>
      <span className={on ? 'sel-check on' : 'sel-check'}>
        <Icon name="check" size={14} stroke={3} />
      </span>
      <span className="dmf-main">
        <span className="dmf-title">{label}</span>
        <span className="dmf-sub">{sub}</span>
      </span>
    </button>
  );
}

/** Выбор бесед для папки (`EditFilterChatsListController`): поиск по имени, галочки, «Готово»; не больше 100. */
function ChatPicker({ title, picked, onDone }: { title: string; picked: string[]; onDone: (ids: string[]) => void }) {
  const dms = useStore((s) => s.dms);
  const [sel, setSel] = useState<string[]>(picked);
  const [q, setQ] = useState('');
  const nameOf = usePeerName();
  // Подпись контакта и имя — оба (`peerName.ts`).
  const shown = q.trim()
    ? dms.filter((d: DmChannel) => matchDmName(dmPeerLabel(d, nameOf), q.trim()) || matchDmName(d.otherUser.displayName, q.trim()))
    : dms;
  return (
    <div className="settings-pane">
      <div className="dmf-head">
        <button type="button" className="head-icon" title="Назад" aria-label="Назад" onClick={() => onDone(picked)}>
          <Icon name="chevron-left" size={20} />
        </button>
        <strong>{title}</strong>
        <span className="muted dmf-sel">
          {sel.length} / {DM_FOLDER_CHATS_MAX}
        </span>
      </div>
      <input className="sheet-search" placeholder="Найти беседу" aria-label="Найти беседу" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="dmf-pick" id="set-g-folders">
        {shown.map((d) => {
          const on = sel.includes(d.id);
          return (
            <button
              key={d.id}
              type="button"
              role="checkbox"
              aria-checked={on}
              className="dmf-row dmf-check"
              disabled={!on && sel.length >= DM_FOLDER_CHATS_MAX}
              onClick={() => setSel(on ? sel.filter((x) => x !== d.id) : [...sel, d.id])}
            >
              <span className={on ? 'sel-check on' : 'sel-check'}>
                <Icon name="check" size={14} stroke={3} />
              </span>
              <Avatar url={d.otherUser.avatarUrl} name={dmPeerLabel(d, nameOf)} size={32} fallback="icon" />
              <span className="dmf-title">{dmPeerLabel(d, nameOf)}</span>
            </button>
          );
        })}
        {shown.length === 0 && <div className="muted dmf-about">Бесед не найдено</div>}
      </div>
      <div className="sec-actions">
        <button type="button" className="primary" onClick={() => onDone(sel)}>
          Готово
        </button>
      </div>
    </div>
  );
}
