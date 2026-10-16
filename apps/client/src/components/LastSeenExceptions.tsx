import type { LastSeenExceptions, LastSeenExceptionUser, LastSeenPrivacy } from '@gusvoice/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { resetExactCache } from '../dmOnline';
import { useDialogChrome } from '../dialogChrome';
import {
  applyExceptionPick,
  EXCEPTION_PICK_MAX,
  exceptionCountLabel,
  exceptionKindsShown,
  exceptionsBody,
  exceptionTitles,
  serverCallPrivacy,
  serverLastSeenExceptions,
  type ExceptionKind,
  type PrivacySetting,
} from '../lastSeenExceptionsRules';
import { usePhoneLayout } from '../phoneLayout';
import { useStore } from '../store';
import { toastError } from '../toast';
import { BottomSheet } from './BottomSheet';
import { PeoplePicker } from './GroupDialogs';

/**
 * «Исключения» настройки «Время захода» (G07, `lastseen3`): «Всегда показывать» и «Никогда не показывать» — два списка людей
 * поверх правила Все / Собеседники / Никто. Как Telegram (tdesktop `boxes/edit_privacy_box.cpp`, Android `PrivacyControlActivity`):
 * строка списка с числом людей → окно выбора (поиск по своим и людям с общих серверов, выбранные чипами) → «Сохранить».
 * Списки живут на сервере (`PUT /users/me/last-seen-exceptions`), правила вида — `lastSeenExceptionsRules.ts`.
 * `setting="calls"` (`presence4`) — те же два списка у «Кто может звонить» («Всегда разрешать» / «Никогда не разрешать»,
 * `/users/me/call-exceptions`).
 */
export function LastSeenExceptionsBlock({ privacy, setting = 'lastSeen' }: { privacy: LastSeenPrivacy; setting?: PrivacySetting }) {
  const calls = setting === 'calls';
  const on = useStore((s) => (calls ? serverCallPrivacy(s.serverFeatures) : serverLastSeenExceptions(s.serverFeatures)));
  const titles = exceptionTitles(setting);
  const [lists, setLists] = useState<LastSeenExceptions | null>(null);
  const [editing, setEditing] = useState<ExceptionKind | null>(null);
  useEffect(() => {
    if (!on) return;
    let alive = true;
    (calls ? api.callExceptions() : api.lastSeenExceptions()).then(
      (v) => alive && setLists(v),
      () => alive && setLists({ always: [], never: [] }),
    );
    return () => {
      alive = false;
    };
  }, [on, calls]);
  if (!on || !lists) return null;
  return (
    <>
      <div className="settings-group-label" id={calls ? 'set-g-calls-exceptions' : 'set-g-lastseen-exceptions'} style={{ marginTop: 22 }}>
        Исключения
      </div>
      {exceptionKindsShown(privacy).map((kind) => (
        <div key={kind} className="settings-row">
          <span>{titles[kind]}</span>
          <button type="button" className="settings-action" onClick={() => setEditing(kind)}>
            {exceptionCountLabel(lists[kind].length)}
          </button>
        </div>
      ))}
      <div className="muted" style={{ fontSize: 13 }}>
        {calls
          ? 'Эти люди смогут или не смогут вам звонить независимо от настроек выше.'
          : 'Исключения перекрывают настройки выше. Время захода тех, от кого вы своё скрыли, вы тоже не увидите.'}
      </div>
      {editing && (
        <ExceptionsDialog
          kind={editing}
          title={titles[editing]}
          initial={lists[editing]}
          onClose={() => setEditing(null)}
          onSave={async (picked) => {
            const next = applyExceptionPick(lists, editing, picked);
            if (calls) {
              setLists(await api.setCallExceptions(exceptionsBody(next)));
            } else {
              setLists(await api.setLastSeenExceptions(exceptionsBody(next)));
              // Исключения меняют взаимную видимость: кэш «время захода видно» (`dmOnline`) перезапросить (ревью №3).
              resetExactCache();
            }
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const phone = usePhoneLayout();
  const ref = useDialogChrome<HTMLDivElement>(onClose);
  if (phone)
    return (
      <BottomSheet title={title} onClose={onClose}>
        {children}
      </BottomSheet>
    );
  // Через портал: окно настроек анимируется `transform`, а у предка с ним `position: fixed` считается от него.
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
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
    </div>,
    document.body,
  );
}

export function ExceptionsDialog({
  title,
  initial,
  onClose,
  onSave,
}: {
  kind: ExceptionKind;
  title: string;
  initial: LastSeenExceptionUser[];
  onClose: () => void;
  onSave: (picked: LastSeenExceptionUser[]) => Promise<void>;
}) {
  const [picked, setPicked] = useState<LastSeenExceptionUser[]>(initial);
  const [busy, setBusy] = useState(false);
  const save = () => {
    setBusy(true);
    onSave(picked).catch((e: Error) => {
      toastError(e);
      setBusy(false);
    });
  };
  return (
    <Shell title={title} onClose={onClose}>
      <PeoplePicker taken={[]} picked={picked} setPicked={setPicked} heading="Люди" maxPick={EXCEPTION_PICK_MAX} />
      <div className="modal-actions">
        <button type="button" className="link" onClick={onClose}>
          Отмена
        </button>
        <button type="button" disabled={busy} onClick={save}>
          {busy ? '…' : 'Сохранить'}
        </button>
      </div>
    </Shell>
  );
}
