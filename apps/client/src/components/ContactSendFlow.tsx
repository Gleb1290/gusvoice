import type { ConvMediaInput } from '@gusvoice/shared';
import { useEffect, useState } from 'react';
import { useDialogChrome } from '../dialogChrome';
import { usePhoneLayout } from '../phoneLayout';
import { toastError } from '../toast';
import { Avatar } from './Avatar';
import { BottomSheet } from './BottomSheet';
import { ContactPickSheet, type ContactWho } from './DmSidebar';
import { Icon } from './Icon';

/**
 * «Контакт» из листа вложений ЛС (G69, `geocontact1`) с подтверждением: выбор человека (`ContactPickSheet`), затем окно с его
 * карточкой (аватар, имя, @ник) и кнопками «Отмена» / «Отправить» — отправка ТОЛЬКО по «Отправить».
 * Telegram Android: `ChatAttachAlertContactsLayout` → `delegate.didSelectContact` → `PhonebookShareAlert` (заголовок
 * `ShareContactTitle`, карточка контакта, кнопка внизу; закрытие без отправки). Телефон — лист снизу, ПК — окно.
 */
export function ContactSendFlow({ onSend, onClose }: { onSend: (media: ConvMediaInput) => Promise<void>; onClose: () => void }) {
  const [picking, setPicking] = useState(true);
  const [who, setWho] = useState<{ userId: string; info: ContactWho } | null>(null);
  // `ContactPickSheet` по выбору строки зовёт закрытие и затем выбор в одном обработчике: оба состояния обновляются разом.
  // Закрыли список без выбора — закрыт весь поток.
  useEffect(() => {
    if (!picking && !who) onClose();
  }, [picking, who, onClose]);
  if (who) return <ContactConfirm who={who.info} onSend={() => onSend({ kind: 'contact', userId: who.userId })} onClose={onClose} />;
  if (!picking) return null;
  return <ContactPickSheet onPick={(userId, info) => setWho({ userId, info })} onClose={() => setPicking(false)} />;
}

function ContactConfirm({ who, onSend, onClose }: { who: ContactWho; onSend: () => Promise<void>; onClose: () => void }) {
  const phone = usePhoneLayout();
  const [busy, setBusy] = useState(false);
  const send = () => {
    if (busy) return;
    setBusy(true);
    onSend()
      .then(onClose)
      .catch((e: Error) => {
        toastError(e);
        setBusy(false);
      });
  };
  const body = (
    <div className="contact-send">
      <div className="contact-send-card">
        <Avatar url={who.avatarUrl} name={who.name} size={64} />
        <span className="contact-send-name">{who.name}</span>
        {who.username && <span className="contact-send-sub">@{who.username}</span>}
      </div>
      <div className="modal-actions">
        <button type="button" className="link" disabled={busy} onClick={onClose}>
          Отмена
        </button>
        <button type="button" disabled={busy} onClick={send}>
          Отправить
        </button>
      </div>
    </div>
  );
  return phone ? (
    <BottomSheet title="Отправить контакт" onClose={onClose}>
      {body}
    </BottomSheet>
  ) : (
    <ContactModal onClose={onClose}>{body}</ContactModal>
  );
}

/** ПК: окно по центру, Esc и возврат фокуса — `useDialogChrome` (как `GeoPickDialog`). */
function ContactModal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const dialogRef = useDialogChrome<HTMLDivElement>(onClose);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal contact-send-modal"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Отправить контакт"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="admin-head">
          <h2>Отправить контакт</h2>
          <button type="button" className="icon-close" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
