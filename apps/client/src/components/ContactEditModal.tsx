import { CONTACT_NAME_MAX } from '@gusvoice/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { confirmAction } from '../confirm';
import { useContacts, type ContactPerson } from '../contacts';
import { toast, toastError } from '../toast';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

/**
 * Окно «Новый контакт» / «Изменить контакт» (08.10, #211, `contacts1`; Telegram Desktop `EditContactBox`: заголовок
 * `lng_enter_contact_data` / `lng_edit_contact_title`, фото и имя человека сверху, поле имени, «Готово»). Имя у нас одно (нет
 * деления на имя и фамилию), пустое — его собственное. После добавления — тост `lng_new_contact_add_done` «X теперь в ваших
 * контактах». Хост — `ContactEditHost` у `MainLayout`: окно переживает закрытие меню, из которого его открыли.
 */
function ContactEditModal({ person, mode, initial }: { person: ContactPerson; mode: 'add' | 'edit'; initial: string | null }) {
  const close = useContacts((s) => s.closeEdit);
  const [name, setName] = useState(initial ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, busy]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const clean = name.trim() || null;
    try {
      if (mode === 'add') {
        await useContacts.getState().add(person, clean);
        toast('success', `${clean ?? person.displayName} теперь в ваших контактах`);
      } else {
        await useContacts.getState().rename(person.id, clean);
      }
      close();
    } catch (err) {
      toastError(err);
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={() => !busy && close()}>
      <form
        className="modal create-channel contact-edit"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void submit(e)}
        role="dialog"
        aria-modal="true"
        aria-labelledby="contact-edit-title"
      >
        <div className="admin-head">
          <h2 id="contact-edit-title">{mode === 'add' ? 'Новый контакт' : 'Изменить контакт'}</h2>
          <button type="button" className="icon-close" title="Закрыть" disabled={busy} onClick={close}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="contact-edit-who">
          <Avatar url={person.avatarUrl} name={person.displayName} size={48} />
          <span className="sr-label">
            {person.displayName}
            <span className="dm-sub"> @{person.username}</span>
          </span>
        </div>
        <label className="field">
          Имя
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={person.displayName}
            maxLength={CONTACT_NAME_MAX}
            autoFocus
          />
        </label>
        <div className="reg-policy-note">Имя увидите только вы. Пустое — останется имя из профиля.</div>
        <div className="modal-actions">
          <button type="button" className="link" onClick={close} disabled={busy}>
            Отмена
          </button>
          <button type="submit" disabled={busy}>
            {busy ? '…' : mode === 'add' ? 'Добавить' : 'Готово'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Хост окна контакта (у `MainLayout`, рядом с `ChatSwitchHost`). */
export function ContactEditHost() {
  const editing = useContacts((s) => s.editing);
  if (!editing) return null;
  return <ContactEditModal key={`${editing.person.id}:${editing.mode}`} person={editing.person} mode={editing.mode} initial={editing.name} />;
}

/**
 * «Удалить контакт» (Telegram `lng_info_delete_contact`, окно `lng_sure_delete_contact`): после подтверждения; переписка и
 * блокировка не трогаются. Сбой — тост.
 */
export async function removeContactAsk(person: Pick<ContactPerson, 'id' | 'displayName'>, label?: string): Promise<void> {
  const who = label ?? person.displayName;
  const ok = await confirmAction({
    title: 'Удалить контакт?',
    body: `Удалить ${who} из списка контактов? Переписка останется.`,
    tone: 'danger',
    confirmLabel: 'Удалить',
  });
  if (!ok) return;
  await useContacts.getState().remove(person.id).catch(toastError);
}
