import type { ContactRow } from '@gusvoice/shared';
import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from './api';
import { activeInstanceId } from './config';

/**
 * Контакты (08.10, #211, сервер `contacts1`, решение владельца 08.10 п.7). Список — с сервера; событие `contacts.update`
 * (`sockets.ts` → `apply`) держит все мои устройства в согласии. Каждая запись отвечает списком целиком — он и есть истина.
 * Правила (подпись, поиск, порядок) — `contactRules.ts`; окно «Новый контакт» / «Изменить контакт» — `ContactEditModal.tsx`
 * (хост `ContactEditHost` у `MainLayout`). В `store.ts` не импортируется (его тесты подменяют импорты поимённо).
 */
export type ContactPerson = Pick<ContactRow, 'id' | 'username' | 'displayName' | 'avatarUrl'>;

interface ContactsState {
  /** Мои контакты; `null` — ещё не загружали для этого инстанса. */
  list: ContactRow[] | null;
  /** Чьи это контакты — инстанс (десктоп и Android переключают инстансы). */
  owner: string | null;
  /** Открытое окно «Новый контакт» / «Изменить контакт». */
  editing: { person: ContactPerson; mode: 'add' | 'edit'; name: string | null } | null;
  load: () => Promise<void>;
  apply: (contacts: ContactRow[]) => void;
  add: (person: ContactPerson, name?: string | null) => Promise<void>;
  rename: (userId: string, name: string | null) => Promise<void>;
  remove: (userId: string) => Promise<void>;
  openEdit: (person: ContactPerson, mode: 'add' | 'edit') => void;
  closeEdit: () => void;
}

let loading: Promise<void> | null = null;

export const useContacts = create<ContactsState>((set, get) => ({
  list: null,
  owner: null,
  editing: null,
  load: async () => {
    const owner = activeInstanceId() ?? '';
    if (get().owner !== owner) set({ list: null, owner });
    if (loading) return loading;
    loading = api
      .contacts()
      .then((r) => {
        if ((activeInstanceId() ?? '') === owner) set({ list: r.contacts });
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  },
  apply: (contacts) => {
    if (get().owner === null) set({ owner: activeInstanceId() ?? '' });
    set({ list: contacts });
  },
  add: async (person, name) => {
    const was = get().list;
    // Сразу на месте (плашка незнакомца гаснет без ожидания), ответ сервера — истина; сбой — откат.
    if (was && !was.some((c) => c.id === person.id)) {
      set({ list: [...was, { ...person, name: name ?? null, addedAt: new Date().toISOString() }] });
    }
    try {
      set({ list: (await api.contactAdd(person.id, name)).contacts });
    } catch (e) {
      set({ list: was });
      throw e;
    }
  },
  rename: async (userId, name) => {
    set({ list: (await api.contactRename(userId, name)).contacts });
  },
  remove: async (userId) => {
    const was = get().list;
    if (was) set({ list: was.filter((c) => c.id !== userId) });
    try {
      set({ list: (await api.contactRemove(userId)).contacts });
    } catch (e) {
      set({ list: was });
      throw e;
    }
  },
  openEdit: (person, mode) => {
    const c = get().list?.find((x) => x.id === person.id);
    set({ editing: { person, mode, name: c?.name ?? null } });
  },
  closeEdit: () => set({ editing: null }),
}));

/** Мои контакты для компонента: при включённом признаке подгружает список один раз на инстанс (в эффекте, не в отрисовке). */
export function useContactList(enabled: boolean): ContactRow[] | null {
  const list = useContacts((s) => s.list);
  const owner = useContacts((s) => s.owner);
  const need = enabled && (list === null || owner !== (activeInstanceId() ?? ''));
  useEffect(() => {
    if (need) void useContacts.getState().load().catch(() => {});
  }, [need]);
  return enabled ? list : null;
}
