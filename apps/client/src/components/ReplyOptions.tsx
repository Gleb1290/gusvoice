import { useRef, useState, type ReactNode } from 'react';
import { REPLY_QUOTE_MAX } from '@gusvoice/shared';
import { useDialogChrome } from '../dialogChrome';
import { usePhoneLayout } from '../phoneLayout';
import { quoteFromSelection, type ReplyQuoteDraft } from '../replyQuoteRules';
import { toast } from '../toast';
import { BottomSheet, SheetRow } from './BottomSheet';
import { Icon } from './Icon';

const TITLE_ID = 'reply-opts-title';

export interface ReplyOptionsProps {
  /** Имя автора цитируемого — над текстом, как в пузыре. */
  author: string;
  /** Сырой текст цитируемого: по нему сверяется выделение (`quoteFromSelection`). */
  content: string;
  /** Текст цитируемого, как в пузыре (разметка, упоминания): его и выделяют. */
  body: ReactNode;
  /** Цитата, уже стоящая в поле: под текстом, с «Убрать цитату». */
  quote: ReplyQuoteDraft | null;
  /** «Цитировать фрагмент» / «Сохранить» (`null` — убрать цитату); окно закрывает вызывающий. */
  onApply: (quote: ReplyQuoteDraft | null) => void;
  /** «Ответить в другом чате» — нет у ответа на сообщение другой беседы (оно уже «в другом чате»). */
  onAnotherChat?: (quote: ReplyQuoteDraft | null) => void;
  /** «Показать в чате» — к цитируемому в ленте. */
  onShow?: () => void;
  /** «Убрать ответ». */
  onRemove: () => void;
  onClose: () => void;
}

/**
 * Окно параметров ответа (08.10, #211, G55, `quote1`) — Telegram Desktop `DraftOptionsBox`
 * (`history_view_draft_options.cpp`, вкладка «Ответ»): само сообщение, в котором можно выделить фрагмент; строки «Ответить
 * в другом чате», «Показать в чате», «Убрать ответ» (красная); подпись «Вы можете процитировать фрагмент текста.»; внизу
 * «Отмена» и «Сохранить» — пока что-то выделено, «Цитировать фрагмент». Длиннее 1024 знаков — тост «Слишком длинная
 * цитата» (`lng_reply_quote_long_title` / `_text`), окно не закрывается. Телефон — нижний лист (Android `MessagePreviewView`),
 * ПК — окно по центру, как «Переслать в…» (`.modal-overlay > .modal.create-channel`).
 */
export function ReplyOptions({ author, content, body, quote, onApply, onAnotherChat, onShow, onRemove, onClose }: ReplyOptionsProps) {
  const phone = usePhoneLayout();
  const boxRef = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<ReplyQuoteDraft | 'too-long' | null>(null);
  const [cur, setCur] = useState<ReplyQuoteDraft | null>(quote);

  /** Выделение внутри текста сообщения → кандидат цитаты (смещение — ближе к месту выделения в тексте). */
  const readSelection = () => {
    const box = boxRef.current;
    const sel = window.getSelection();
    if (!box || !sel || sel.isCollapsed || sel.rangeCount === 0) return setPicked(null);
    const range = sel.getRangeAt(0);
    if (!box.contains(range.commonAncestorContainer)) return setPicked(null);
    const before = document.createRange();
    before.selectNodeContents(box);
    before.setEnd(range.startContainer, range.startOffset);
    setPicked(quoteFromSelection(content, sel.toString(), before.toString().length));
  };

  const submit = () => {
    if (picked === 'too-long') {
      toast('error', 'Слишком длинная цитата', `Выбран слишком длинный фрагмент: не больше ${REPLY_QUOTE_MAX} знаков.`);
      return;
    }
    onApply(picked ?? cur);
  };

  const inner = (
    <div className="reply-opts">
      <div
        className="reply-opts-msg"
        ref={boxRef}
        onMouseUp={readSelection}
        onKeyUp={readSelection}
        onTouchEnd={() => setTimeout(readSelection, 0)}
      >
        <div className="rq-author">{author}</div>
        <div className="message-body">{body}</div>
      </div>
      {cur && !picked && (
        <div className="reply-opts-quote">
          <span className="rs-text">«{cur.text}»</span>
          <button type="button" className="link" onClick={() => setCur(null)}>
            Убрать цитату
          </button>
        </div>
      )}
      {onAnotherChat && <SheetRow icon="forward" label="Ответить в другом чате" onClick={() => onAnotherChat(picked && picked !== 'too-long' ? picked : cur)} />}
      {onShow && <SheetRow icon="eye" label="Показать в чате" onClick={onShow} />}
      <SheetRow icon="trash" label="Убрать ответ" danger onClick={onRemove} />
      {content.trim() !== '' && <p className="modal-what reply-opts-hint">Вы можете процитировать фрагмент текста.</p>}
      <div className="modal-actions">
        <button type="button" className="link" onClick={onClose}>
          Отмена
        </button>
        <button type="button" onClick={submit}>
          {picked ? 'Цитировать фрагмент' : 'Сохранить'}
        </button>
      </div>
    </div>
  );

  if (phone)
    return (
      <BottomSheet title="Ответ на сообщение" onClose={onClose}>
        {inner}
      </BottomSheet>
    );
  return <ReplyOptionsDialog onClose={onClose}>{inner}</ReplyOptionsDialog>;
}

function ReplyOptionsDialog({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const dialogRef = useDialogChrome<HTMLDivElement>(onClose);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal create-channel reply-opts-modal"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="admin-head">
          <h2 id={TITLE_ID}>Ответ на сообщение</h2>
          <button type="button" className="icon-close" aria-label="Закрыть" title="Закрыть" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
