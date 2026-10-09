import type { ConvGroupMember, DmChannel, UserSearchHit } from '@gusvoice/shared';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { api } from '../api';
import { confirmAction } from '../confirm';
import { useDialogChrome } from '../dialogChrome';
import { dmComposeCandidates, dmSearchHits, serverSearchesUsers, USER_SEARCH_DELAY_MS, userSearchQuery } from '../dmRules';
import { GROUP_LIMIT_HINT, GROUP_MEMBER_LIMIT, groupMembersLabel, groupPickState } from '../groupChatRules';
import { usePhoneLayout } from '../phoneLayout';
import { contactMatches, serverContacts, sortContacts } from '../contactRules';
import { useContactList } from '../contacts';
import { usePeerName } from '../peerName';
import { useStore } from '../store';
import { toast, toastError } from '../toast';
import { Avatar } from './Avatar';
import { BottomSheet } from './BottomSheet';
import { Icon } from './Icon';
import { SharedMediaRows } from './SharedMedia';
import { CreateServerModal } from './ServerActionModals';

/**
 * Групповые ЛС (07.10, #211, С4, признак сервера `groups1`): «Новая группа» и «Информация о группе».
 *
 * Как Telegram: создание — два шага, «выбор людей» (поиск, отмеченные сверху, счётчик N/5) → «название и фото» → «Создать»
 * (tdesktop `AddParticipantsBoxController` + `GroupInfoBox`, Android `GroupCreateActivity` → `GroupCreateFinalActivity`).
 * Информация — участники (создатель с пометкой), «Добавить участника», «Удалить» у участника (только создателю),
 * переименование, смена фото, «Покинуть группу» (tdesktop `info/profile/`, Web A `right/management`).
 * Предел — Р-5: шестой не выбирается, вместо него подсказка «создайте сервер» с кнопкой.
 * Телефон — лист снизу (`BottomSheet`), ПК — окно по центру той же разметки, что «Написать» (`.modal.dm-compose`).
 */

type GroupDialog = { kind: 'new' } | { kind: 'info'; convId: string } | null;
let dialog: GroupDialog = null;
const subs = new Set<() => void>();
function setDialog(d: GroupDialog): void {
  dialog = d;
  for (const f of subs) f();
}
export function openNewGroup(): void {
  setDialog({ kind: 'new' });
}
export function openGroupInfo(convId: string): void {
  setDialog({ kind: 'info', convId });
}
function closeGroupDialog(): void {
  setDialog(null);
}
function useGroupDialog(): GroupDialog {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => dialog,
  );
}

/** «Покинуть группу» с подтверждением (меню шапки и окно «Информация о группе»). */
export async function leaveGroup(convId: string, title: string): Promise<void> {
  const ok = await confirmAction({
    title: `Покинуть «${title}»?`,
    body: 'Группа пропадёт из списка. Вернуть вас сможет только участник группы.',
    tone: 'danger',
    confirmLabel: 'Покинуть',
  });
  if (!ok) return;
  try {
    await api.convLeaveGroup(convId);
    closeGroupDialog();
  } catch (e) {
    toastError(e as Error);
  }
}

/** Хост окон групп — у корня ЛС (`DmSidebar`). */
export function GroupDialogHost() {
  const d = useGroupDialog();
  if (!d) return null;
  return d.kind === 'new' ? <NewGroupDialog /> : <GroupInfoDialog convId={d.convId} />;
}

function Shell({ title, children }: { title: string; children: ReactNode }) {
  const phone = usePhoneLayout();
  const ref = useDialogChrome<HTMLDivElement>(closeGroupDialog);
  if (phone)
    return (
      <BottomSheet title={title} onClose={closeGroupDialog}>
        {children}
      </BottomSheet>
    );
  return (
    <div className="modal-overlay" onClick={closeGroupDialog}>
      <div
        className="modal dm-compose group-dialog"
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

type Person = Pick<UserSearchHit, 'id' | 'username' | 'displayName' | 'avatarUrl'>;

/** Подсказка предела (Р-5) с кнопкой «Создать сервер» — у кого есть право создавать серверы. */
function LimitHint() {
  const user = useStore((s) => s.user);
  const [create, setCreate] = useState(false);
  const canCreate = !!(user?.superAdmin || user?.canCreateServers);
  return (
    <div className="group-limit" role="status">
      <span>{GROUP_LIMIT_HINT}</span>
      {canCreate && (
        <button type="button" className="link" onClick={() => setCreate(true)}>
          Создать сервер
        </button>
      )}
      {create && (
        <CreateServerModal
          onClose={() => setCreate(false)}
          onCreated={(id) => {
            closeGroupDialog();
            const s = useStore.getState();
            void s.loadServers().then(() => s.openServer(id));
          }}
        />
      )}
    </div>
  );
}

/**
 * Выбор людей: поиск по своим (ростер открытого сервера, собеседники) и, если сервер умеет, по @имени среди людей
 * инстанса. `taken` — уже в группе (не предлагаются, считаются в предел).
 */
export function PeoplePicker({
  taken,
  picked,
  setPicked,
  heading = 'Участники',
  maxPick,
}: {
  taken: readonly string[];
  picked: Person[];
  setPicked: (p: Person[]) => void;
  /** Заголовок над чипами (исключения «Времени захода» — «Люди»). */
  heading?: string;
  /** Свой потолок выбора вместо предела группы (исключения «Времени захода»: счётчик N/M, подсказки «создайте сервер» нет). */
  maxPick?: number;
}) {
  const members = useStore((s) => s.members);
  const dms = useStore((s) => s.dms);
  const me = useStore((s) => s.user);
  const searchOn = useStore((s) => serverSearchesUsers(s.serverFeatures)) && !me?.homeInstance;
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<UserSearchHit[]>([]);
  const [overflow, setOverflow] = useState(false);
  const round = useRef(0);
  // Подпись контакта вместо имени (решение владельца 08.10 п.27, `peerName.ts`): в строках, чипах и поиске.
  const nameOf = usePeerName();
  const candidates = useMemo(
    () => dmComposeCandidates({ members, dms, meId: me?.id, query, nameOf }).filter((u) => !u.homeInstance),
    [members, dms, me?.id, query, nameOf],
  );
  const searchQuery = searchOn ? userSearchQuery(query) : null;
  useEffect(() => {
    if (!searchQuery) {
      round.current += 1;
      setHits([]);
      return;
    }
    const mine = ++round.current;
    const t = window.setTimeout(() => {
      api
        .searchUsers(searchQuery)
        .then((r) => round.current === mine && setHits(r.users))
        .catch(() => round.current === mine && setHits([]));
    }, USER_SEARCH_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [searchQuery]);
  const found = useMemo(() => dmSearchHits({ hits, candidates, meId: me?.id, query: searchQuery }), [hits, candidates, me?.id, searchQuery]);
  const state =
    maxPick === undefined
      ? groupPickState(picked.length, taken.length)
      : { total: picked.length, full: picked.length >= maxPick, label: `${picked.length}/${maxPick}` };
  const pickedIds = new Set(picked.map((p) => p.id));
  const toggle = (u: Person) => {
    if (pickedIds.has(u.id)) {
      setOverflow(false);
      setPicked(picked.filter((p) => p.id !== u.id));
      return;
    }
    if (state.full) {
      setOverflow(true);
      // Отклик на «шестого»: у группы — подсказка под полем (`LimitHint`, как окно-предупреждение Telegram `SoftUserLimitAlert`) и
      // притушенные строки; у списка со своим потолком (`maxPick`, исключения «Времени захода») подсказки нет — там тост (C5).
      if (maxPick !== undefined) toast('info', `Можно выбрать не больше ${maxPick}`);
      return;
    }
    setPicked([...picked, { id: u.id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl }]);
  };
  // Контакты (`contacts1`): блок «Контакты» сверху, как в «Написать» (C5); остальные — под «Остальные».
  const contactsOn = useStore((s) => serverContacts(s.serverFeatures)) && !me?.homeInstance;
  const contacts = useContactList(contactsOn);
  const contactRows = useMemo(
    () => sortContacts((contacts ?? []).filter((c) => !taken.includes(c.id) && contactMatches(c, query)), new Set<string>()),
    [contacts, taken, query],
  );
  const contactIds = new Set(contactRows.map((c) => c.id));
  const rows = [...candidates, ...found].filter((u) => !taken.includes(u.id) && !contactIds.has(u.id));
  const renderRow = (u: Person & { displayName: string }) => {
    const on = pickedIds.has(u.id);
    return (
      <button
        type="button"
        key={u.id}
        className={`sheet-row group-pick${on ? ' on' : ''}${state.full && !on ? ' limited' : ''}`}
        aria-pressed={on}
        onClick={() => toggle(u)}
      >
        <span className="dm-ava">
          <Avatar url={u.avatarUrl} name={nameOf(u.id, u.displayName)} size={38} fallback="icon" />
        </span>
        <span className="sr-label">
          {nameOf(u.id, u.displayName)}
          <span className="dm-sub"> @{u.username}</span>
        </span>
        <span className="group-check" aria-hidden="true">
          {on && <Icon name="check" size={14} />}
        </span>
      </button>
    );
  };
  return (
    <>
      <div className="group-pick-head">
        <span className="muted">{heading}</span>
        <span className={`group-count${state.full ? ' full' : ''}`} aria-label={`Выбрано ${state.total} из ${maxPick ?? GROUP_MEMBER_LIMIT}`}>
          {state.label}
        </span>
      </div>
      {picked.length > 0 && (
        <div className="group-chips">
          {picked.map((p) => (
            <button type="button" key={p.id} className="group-chip" title="Убрать" onClick={() => toggle(p)}>
              <Avatar url={p.avatarUrl} name={nameOf(p.id, p.displayName)} size={22} />
              <span>{nameOf(p.id, p.displayName)}</span>
              <Icon name="close" size={12} />
            </button>
          ))}
        </div>
      )}
      <input className="sheet-search" autoFocus value={query} placeholder="Кого добавить?" onChange={(e) => setQuery(e.target.value)} />
      {overflow && maxPick === undefined && <LimitHint />}
      <div className="dm-compose-list">
        {rows.length === 0 && contactRows.length === 0 && (
          <div className="sheet-empty">{searchOn ? 'Введите @имя, чтобы найти человека' : 'Никого не нашлось'}</div>
        )}
        {contactRows.length > 0 && <div className="mp-head">Контакты</div>}
        {contactRows.map(renderRow)}
        {contactRows.length > 0 && rows.length > 0 && <div className="mp-head">Остальные</div>}
        {rows.map(renderRow)}
      </div>
    </>
  );
}

/** Фото группы: круг с камерой, нажатие — выбор картинки. */
function PhotoPick({ url, name, onFile }: { url: string | null; name: string; onFile: (f: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <button type="button" className="group-photo" title="Фото группы" onClick={() => input.current?.click()}>
      {url ? <Avatar url={url} name={name || 'Группа'} size={64} /> : <Icon name="photo" size={26} />}
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
    </button>
  );
}

function NewGroupDialog() {
  const [step, setStep] = useState<'people' | 'name'>('people');
  const [picked, setPicked] = useState<Person[]>([]);
  const [title, setTitle] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const me = useStore((s) => s.user);
  const photoUrl = useMemo(() => (photo ? URL.createObjectURL(photo) : null), [photo]);
  useEffect(() => () => void (photoUrl && URL.revokeObjectURL(photoUrl)), [photoUrl]);

  const create = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      let summary = await api.convCreateGroup({ title: title.trim(), userIds: picked.map((p) => p.id) });
      if (photo) summary = await api.convGroupPhoto(summary.id, photo).catch((e: Error) => (toastError(e), summary));
      const s = useStore.getState();
      s.convAdopt(summary);
      closeGroupDialog();
      await s.selectDm(summary.id);
    } catch (e) {
      toastError(e as Error);
      setBusy(false);
    }
  };

  return (
    <Shell title="Новая группа">
      {step === 'people' ? (
        <>
          <PeoplePicker taken={me ? [me.id] : []} picked={picked} setPicked={setPicked} />
          <div className="modal-actions">
            <button type="button" className="link" onClick={closeGroupDialog}>
              Отмена
            </button>
            <button type="button" disabled={picked.length === 0} onClick={() => setStep('name')}>
              Далее
            </button>
          </div>
        </>
      ) : (
        <form
          className="group-name-step"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div className="group-name-row">
            <PhotoPick url={photoUrl} name={title} onFile={setPhoto} />
            <input className="sheet-search" autoFocus value={title} maxLength={128} placeholder="Название группы" onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="muted group-name-sub">{groupMembersLabel(picked.length + 1)}</div>
          <div className="modal-actions">
            <button type="button" className="link" onClick={() => setStep('people')}>
              Назад
            </button>
            <button type="submit" disabled={busy || !title.trim()}>
              {busy ? '…' : 'Создать'}
            </button>
          </div>
        </form>
      )}
    </Shell>
  );
}

function GroupInfoDialog({ convId }: { convId: string }) {
  const dm = useStore((s) => s.dms.find((d) => d.id === convId)) as DmChannel | undefined;
  const me = useStore((s) => s.user);
  const nameOf = usePeerName(); // подпись контакта у участников (`peerName.ts`)
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<Person[]>([]);
  const [title, setTitle] = useState(dm?.group?.title ?? '');
  const [busy, setBusy] = useState(false);
  const group = dm?.group;
  const former = useStore((s) => !!s.conv.summaries[convId]?.former);
  useEffect(() => {
    if (!group) closeGroupDialog();
  }, [group]);
  if (!group || !dm) return null;
  const owner = group.ownerId === me?.id;
  const run = async (f: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await f();
    } catch (e) {
      toastError(e as Error);
    } finally {
      setBusy(false);
    }
  };
  const remove = (m: ConvGroupMember) =>
    void (async () => {
      const ok = await confirmAction({
        title: `Удалить ${nameOf(m.id, m.displayName)} из группы?`,
        body: 'Участник больше не увидит новых сообщений группы.',
        tone: 'danger',
        confirmLabel: 'Удалить',
      });
      if (ok) await run(() => api.convRemoveMember(convId, m.id));
    })();
  const leave = () => void leaveGroup(convId, group.title);

  if (adding)
    return (
      <Shell title="Добавить участников">
        <PeoplePicker taken={group.members.map((m) => m.id)} picked={picked} setPicked={setPicked} />
        <div className="modal-actions">
          <button type="button" className="link" onClick={() => setAdding(false)}>
            Назад
          </button>
          <button
            type="button"
            disabled={busy || picked.length === 0}
            onClick={() =>
              void run(async () => {
                await api.convAddMembers(
                  convId,
                  picked.map((p) => p.id),
                );
                setPicked([]);
                setAdding(false);
              })
            }
          >
            Добавить
          </button>
        </div>
      </Shell>
    );

  return (
    <Shell title="Информация о группе">
      <form
        className="group-name-row"
        onSubmit={(e) => {
          e.preventDefault();
          const t = title.trim();
          if (t && t !== group.title) void run(() => api.convRenameGroup(convId, t));
        }}
      >
        <PhotoPick url={group.avatarUrl} name={group.title} onFile={(f) => void run(() => api.convGroupPhoto(convId, f))} />
        <input className="sheet-search" value={title} maxLength={128} aria-label="Название группы" onChange={(e) => setTitle(e.target.value)} />
        {title.trim() && title.trim() !== group.title && (
          <button type="submit" disabled={busy}>
            Сохранить
          </button>
        )}
      </form>
      <SharedMediaRows convId={convId} former={!!former} onOpen={closeGroupDialog} />
      <div className="group-pick-head">
        <span className="muted">{groupMembersLabel(group.members.length)}</span>
        <span className="group-count">
          {group.members.length}/{group.limit}
        </span>
      </div>
      <div className="dm-compose-list">
        <button type="button" className="sheet-row group-add" onClick={() => setAdding(true)} disabled={group.members.length >= group.limit}>
          <span className="dm-ava group-add-ico">
            <Icon name="user-plus" size={20} />
          </span>
          <span className="sr-label">Добавить участника</span>
        </button>
        {group.members.length >= group.limit && <LimitHint />}
        {group.members.map((m) => (
          <div key={m.id} className="sheet-row group-member">
            <span className="dm-ava">
              <Avatar url={m.avatarUrl} name={nameOf(m.id, m.displayName)} size={38} />
            </span>
            <span className="sr-label">
              {nameOf(m.id, m.displayName)}
              <span className="dm-sub"> @{m.username}</span>
            </span>
            {m.role === 'owner' ? (
              <span className="group-role muted">создатель</span>
            ) : owner && m.id !== me?.id ? (
              <button type="button" className="link danger" disabled={busy} onClick={() => remove(m)}>
                Удалить
              </button>
            ) : null}
          </div>
        ))}
        <button type="button" className="sheet-row group-leave danger" onClick={leave} disabled={busy}>
          <span className="dm-ava group-add-ico">
            <Icon name="logout" size={20} />
          </span>
          <span className="sr-label">Покинуть группу</span>
        </button>
      </div>
    </Shell>
  );
}
