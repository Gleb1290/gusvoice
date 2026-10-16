import { FEATURE_MSGPRIV1, type LastSeenExceptions, type MessagePrivacy } from '@gusvoice/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { exceptionCountLabel } from '../lastSeenExceptionsRules';
import { useStore } from '../store';
import { toastError } from '../toast';
import { ExceptionsDialog } from './LastSeenExceptions';

/** Варианты «Кто может мне писать»: у Telegram «Все» / «Мои контакты и Premium» (`lng_messages_privacy_everyone` / `_restricted`). */
const MESSAGE_PRIVACY_OPTIONS: { value: MessagePrivacy; label: string }[] = [
  { value: 'everyone', label: 'Все' },
  { value: 'contacts', label: 'Мои контакты' },
];

/**
 * «Кто может мне писать» (13.10, #218, решение владельца, `msgpriv1`) — пункт приватности после «Звонков», как у Telegram
 * (Настройки → Конфиденциальность → «Сообщения»: tdesktop `edit_privacy_box.cpp` `lng_messages_privacy_*`, Android
 * `PrivacyControlActivity` `PRIVACY_RULES_TYPE_MESSAGES`). Образец у нас — `CallPrivacySetting` (`.seg` + блок исключений).
 * Исключение одно — «Всегда разрешать» и только при «Мои контакты» (при «Все» ему нечего перекрывать). Без признака сервера — нет.
 */
export function MessagePrivacySetting() {
  const on = useStore((s) => !!s.serverFeatures?.includes(FEATURE_MSGPRIV1));
  const user = useStore((s) => s.user);
  const setAuth = useStore((s) => s.setAuth);
  if (!on || !user) return null;
  const value: MessagePrivacy = user.messagePrivacy ?? 'everyone';
  return (
    <>
      <div className="settings-group-label" id="set-g-messages" style={{ marginTop: 22 }}>
        Сообщения
      </div>
      <div className="muted set-sub-label" style={{ fontSize: 13 }} id="set-messages-label">
        Кто может мне писать
      </div>
      <div className="seg" role="group" aria-labelledby="set-messages-label">
        {MESSAGE_PRIVACY_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            className={value === o.value ? 'on' : ''}
            onClick={() => value !== o.value && void api.updateProfile({ messagePrivacy: o.value }).then(setAuth, toastError)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {/* Web K `Privacy.MessagesInfo`: «…not in your contacts and whom you haven't messaged first». */}
      <div className="muted" style={{ fontSize: 13 }}>
        Можно запретить писать вам тем, кого нет в ваших контактах и кому вы не писали первым. Им вместо поля ввода покажется, что вы
        принимаете сообщения только от контактов.
      </div>
      {value === 'contacts' && <MessageExceptionsBlock />}
    </>
  );
}

function MessageExceptionsBlock() {
  const [lists, setLists] = useState<LastSeenExceptions | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    let alive = true;
    api.messageExceptions().then(
      (v) => alive && setLists(v),
      () => alive && setLists({ always: [], never: [] }),
    );
    return () => {
      alive = false;
    };
  }, []);
  if (!lists) return null;
  return (
    <>
      <div className="settings-group-label" id="set-g-messages-exceptions" style={{ marginTop: 22 }}>
        Исключения
      </div>
      <div className="settings-row">
        <span>Всегда разрешать</span>
        <button type="button" className="settings-action" onClick={() => setEditing(true)}>
          {exceptionCountLabel(lists.always.length)}
        </button>
      </div>
      <div className="muted" style={{ fontSize: 13 }}>
        Эти люди смогут писать вам, даже если их нет в контактах.
      </div>
      {editing && (
        <ExceptionsDialog
          kind="always"
          title="Всегда разрешать"
          initial={lists.always}
          onClose={() => setEditing(false)}
          onSave={async (picked) => {
            setLists(await api.setMessageExceptions(picked.map((u) => u.id)));
            setEditing(false);
          }}
        />
      )}
    </>
  );
}
