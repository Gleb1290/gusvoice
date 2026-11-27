import { useId } from 'react';
import { Toggle } from './Toggle';

export function ChannelMuteSetting({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  const id = useId();
  return (
    <div className="settings-row">
      <div>
        <span id={id}>Тихий канал для всех</span>
        <div className="muted" id={id + '-hint'}>
          Сообщения и упоминания приходят без уведомлений. Счётчик непрочитанного скрыт.
        </div>
      </div>
      <Toggle checked={checked} onChange={onChange} labelledBy={id} describedBy={id + '-hint'} />
    </div>
  );
}
