import { accessClosedText } from '../accessClosed';
import { useStore } from '../store';
import { Icon } from './Icon';

/**
 * Окно «сервер закрыт держателем» (#139, F4, §5.3.1, требование 16).
 *
 * 🔴 Одна кнопка — «Понятно». Ни «Повторить», ни «Написать»: решение принял другой человек на
 * другом инстансе, и ничего, что можно нажать отсюда, его не отменит. Кнопка, которая делает вид,
 * что что-то исправит, здесь была бы враньём.
 *
 * ⚠️ Контакты держателя показываем ТЕКСТОМ, а не ссылкой `mailto:`/`tg://`: значение приехало с
 * чужого инстанса, и превращать чужую строку в кликабельный переход — это дать ей увести человека
 * куда угодно. Прочитать и скопировать он может сам.
 */
export function ServerClosedModal() {
  const notice = useStore((s) => s.accessNotice);
  const close = useStore((s) => s.clearAccessNotice);
  if (!notice) return null;
  const { title, body, showContacts } = accessClosedText(notice);

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal create-channel" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="admin-head">
          <h2>
            <Icon name="lock" size={18} /> {title}
          </h2>
          <button type="button" className="icon-close" title="Закрыть" onClick={close}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="sc-body">{body}</div>
        {showContacts && notice.contacts.length > 0 && (
          <div className="inv-contacts">
            <div className="settings-group-label">Связаться с держателем</div>
            <ul>
              {notice.contacts.map((c) => (
                <li key={`${c.kind}:${c.value}`}>
                  <span className="muted">{c.label}</span> {c.value}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="modal-actions">
          <button type="button" onClick={close}>
            Понятно
          </button>
        </div>
      </div>
    </div>
  );
}
