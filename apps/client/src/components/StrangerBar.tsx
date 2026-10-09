import type { DmReportReason } from '@gusvoice/shared';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { REPORT_COMMENT_MAX, REPORT_REASON_LABEL, REPORT_REASONS } from '../strangerBarRules';
import { toast, toastError } from '../toast';
import { Icon } from './Icon';

/**
 * Плашка незнакомца над лентой ЛС (08.10, #211, С7, G30, Р-10, признак `stranger1`). Telegram Desktop
 * (`history_view_contact_status.cpp`): под шапкой во всю ширину две текстовые кнопки («Добавить» / «Заблокировать» у начавшего
 * первым) и крестик справа — он скрывает плашку насовсем (`hide_peer_settings_bar`). «Добавить в контакты» — с сервером `contacts1`
 * (окно `ContactEditModal`), рядом «Пожаловаться» (Android `reportSpamView`) и «Заблокировать». Плашка гаснет, когда я ответил,
 * добавил в контакты, заблокировал, пожаловался или скрыл.
 */
export function StrangerBar({
  peerName,
  onAdd,
  onBlock,
  onHide,
  onReport,
}: {
  peerName: string;
  /** Сервер умеет контакты (`contacts1`) — первой кнопкой «Добавить в контакты», как Telegram `Type::AddOrBlock`. */
  onAdd?: () => void;
  onBlock: () => void;
  onHide: () => void;
  onReport: () => void;
}) {
  return (
    <div className="stranger-bar" role="region" aria-label={`${peerName} — незнакомый собеседник`}>
      <span className="stranger-bar-text">Вы с {peerName} не состоите на одном сервере</span>
      <span className="stranger-bar-actions">
        {onAdd && (
          <button type="button" className="stranger-bar-btn" onClick={onAdd}>
            Добавить в контакты
          </button>
        )}
        {/* С «Добавить» на телефоне кнопок две, как у Telegram Android (`addToContactsButton` / `reportSpamButton`): «Пожаловаться»
            уходит в меню ⋮ беседы (`DmChatView`), иначе три кнопки в 412 px не влезают. */}
        <button type="button" className={`stranger-bar-btn${onAdd ? ' report' : ''}`} onClick={onReport}>
          Пожаловаться
        </button>
        <button type="button" className="stranger-bar-btn danger" onClick={onBlock}>
          Заблокировать
        </button>
      </span>
      <button type="button" className="icon-close stranger-bar-x" title="Скрыть" aria-label="Скрыть плашку" onClick={onHide}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}

/**
 * Окно «Пожаловаться» (Telegram `ReportReasonBox`: причины списком, комментарий до 512 знаков). Что уйдёт держателю инстанса,
 * сказано до нажатия: причина, комментарий и последние сообщения собеседника (до пяти) — они лежат на сервере, из окна ничего
 * не отправляется. «Заблокировать» стоит по умолчанию, как у Telegram после жалобы на спам.
 */
export function StrangerReportModal({
  convId,
  peer,
  blocked,
  onBlock,
  onClose,
}: {
  convId: string;
  peer: { id: string; displayName: string };
  blocked: boolean;
  onBlock: () => Promise<void>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<DmReportReason>('spam');
  const [comment, setComment] = useState('');
  const [alsoBlock, setAlsoBlock] = useState(!blocked);
  const [busy, setBusy] = useState(false);
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  async function submit() {
    setBusy(true);
    try {
      await useStore.getState().reportStranger(convId, reason, comment.trim() || undefined);
      toast('success', 'Жалоба отправлена', 'Её увидит администратор инстанса.');
    } catch (e) {
      toastError(e);
      setBusy(false);
      return;
    }
    if (alsoBlock && !blocked) await onBlock().catch(toastError);
    onClose();
  }

  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div className="modal create-channel stranger-report" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="stranger-report-title">
        <div className="admin-head">
          <h2 id="stranger-report-title">Пожаловаться на {peer.displayName}</h2>
          <button type="button" className="icon-close" title="Закрыть" disabled={busy} onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="reg-policy" role="radiogroup" aria-label="Причина жалобы">
          {REPORT_REASONS.map((r) => (
            <label key={r} className={`reg-card${reason === r ? ' selected' : ''}`} title={REPORT_REASON_LABEL[r].text}>
              <input type="radio" name="stranger-report-reason" value={r} checked={reason === r} onChange={() => setReason(r)} />
              <span className="reg-card-dot" aria-hidden="true" />
              <span className="reg-card-body">
                <span className="reg-card-title">{REPORT_REASON_LABEL[r].title}</span>
              </span>
            </label>
          ))}
        </div>
        <label className="field">
          Комментарий (необязательно)
          <textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={REPORT_COMMENT_MAX} rows={2} placeholder="Что произошло" />
        </label>
        <div className="reg-policy-note">К жалобе приложатся последние сообщения {peer.displayName} (до пяти). Остальную переписку администратор не увидит.</div>
        {!blocked && (
          <label className="ctx-ban-report">
            <input type="checkbox" checked={alsoBlock} onChange={(e) => setAlsoBlock(e.target.checked)} />
            <span>Заблокировать {peer.displayName}</span>
          </label>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button type="button" className="danger" ref={okRef} onClick={() => void submit()} disabled={busy}>
            Пожаловаться
          </button>
        </div>
      </div>
    </div>
  );
}
