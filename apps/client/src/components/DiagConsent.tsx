import { useState } from 'react';
import { api } from '../api';
import { config } from '../config';
import { getDiagConsent, setDiagConsent } from '../diagConsent';
import { isDesktop } from '../hotkeys';
import { toast, toastError } from '../toast';
import { Toggle } from './Toggle';

/**
 * Согласие на сбор диагностики и управление им (#113).
 *
 * 🔴 **Перечень собираемого живёт ЗДЕСЬ, в одном месте**, и показывается и в окне согласия, и в
 * настройках. Разъехавшись, эти два текста превратились бы в обман: человек соглашался на один
 * список, а проверить может по другому.
 *
 * ⚠️ Формулировки намеренно про пользу ЧЕЛОВЕКА, а не про наши нужды: спрашиваем в момент, когда
 * польза очевидна («чтобы можно было разобрать, почему у ТЕБЯ лагает показ»), и не превращаем это в
 * юридическое согласие на обработку — иначе его нажимают не читая, и оно ничего не значит.
 */

/** Что уезжает. Формулировки человеческие: люди читают это, а не схему. */
const COLLECTED: { title: string; text: string }[] = [
  {
    title: 'Про компьютер',
    text: 'модель видеокарты и её загрузка, частоты, температура; сколько всего памяти и сколько занято; число ядер; версия Windows и версия приложения.',
  },
  {
    title: 'Про четыре программы, поимённо',
    text: 'GusVoice, его встроенный браузер, проводник и диспетчер окон Windows: сколько каждая ест памяти и процессора. Список остальных программ НЕ собирается.',
  },
  {
    title: 'Про показ экрана',
    text: 'разрешение, частота кадров, битрейт, кодек, сколько времени уходит на снятие кадра, потери и отклик сети, во что упирается кодировщик.',
  },
  {
    title: 'Про то, что вы смотрите',
    text: 'сколько потоков принимаете, потери и задержки по ним.',
  },
  {
    title: 'Про отзывчивость системы',
    text: 'отвечает ли проводник и панель задач, сколько миллисекунд назад был любой ввод — сами нажатия не записываются.',
  },
];

const NOT_COLLECTED =
  'Ни переписки, ни названий окон и программ, ни списка установленного, ни скриншотов, ни звука, ни нажатий клавиш, ни адресов и путей к файлам.';

function WhatWeCollect() {
  return (
    <>
      <ul className="diag-what">
        {COLLECTED.map((c) => (
          <li key={c.title}>
            <b>{c.title}:</b> {c.text}
          </li>
        ))}
      </ul>
      <p className="diag-note">
        <b>Чего нет вообще.</b> {NOT_COLLECTED}
      </p>
      <p className="diag-note">
        Отчёты уходят на тот сервер, к которому вы подключены, привязаны к вашей учётной записи и хранятся
        <b> 7 дней</b>, потом удаляются сами. Выключить и удалить всё можно в любой момент в настройках.
      </p>
    </>
  );
}

/**
 * Окно первого вопроса. Показывается ОДИН раз — и «нет» здесь окончательное: повторный вопрос после
 * отказа это уже выпрашивание, а не согласие.
 */
export function DiagConsentDialog({ onDecide }: { onDecide: () => void }) {
  const [more, setMore] = useState(false);
  const decide = (v: 'yes' | 'no') => {
    setDiagConsent(v);
    onDecide();
  };
  return (
    <div className="modal-overlay">
      <div className="modal diag-consent" role="dialog" aria-modal="true" aria-labelledby="diag-consent-title">
        <h3 id="diag-consent-title">Помочь разобраться, если что-то залагает?</h3>
        <p>
          Приложение может собирать технические счётчики, пока вы в голосовом канале, и отправлять их на этот
          сервер. Нужно это ровно для одного: когда у <b>вас</b> залагает показ или пропадёт звук, причину можно
          будет найти по числам, а не гадать.
        </p>
        <p className="diag-note">Без этого разбор жалобы упирается в «у меня тормозит» — и дальше угадывание.</p>

        {more ? (
          <WhatWeCollect />
        ) : (
          <button type="button" className="diag-more" onClick={() => setMore(true)}>
            Что именно собирается?
          </button>
        )}

        <div className="modal-actions">
          <button type="button" onClick={() => decide('no')}>
            Не собирать
          </button>
          <button type="button" className="primary" onClick={() => decide('yes')}>
            Разрешить
          </button>
        </div>
      </div>
    </div>
  );
}

/** Постоянный тумблер в настройках + кнопка удаления. Показывается, только если инстанс собирает. */
export function DiagSettingsSection() {
  const [consent, setConsent] = useState(getDiagConsent());
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!isDesktop() || !config.diagEnabled) return null;

  const flip = (v: boolean) => {
    setDiagConsent(v ? 'yes' : 'no');
    setConsent(v ? 'yes' : 'no');
  };

  const wipe = async () => {
    setBusy(true);
    try {
      const { deleted } = await api.deleteMyDiag();
      toast('success', deleted > 0 ? `Удалено отчётов: ${deleted}` : 'Отчётов и не было');
    } catch (e) {
      toastError(e as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="settings-group-label" style={{ marginTop: 18 }}>
        Диагностика
      </div>
      <div className="settings-row">
        <span>Отправлять технические счётчики</span>
        <Toggle checked={consent === 'yes'} onChange={flip} label="Отправлять технические счётчики" />
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        {consent === 'yes'
          ? 'Пока вы в голосовом канале, приложение собирает счётчики и отправляет их на этот сервер — чтобы можно было разобрать, почему у вас лагает показ.'
          : 'Счётчики не собираются. Если что-то залагает, разбираться придётся на словах.'}{' '}
        <button type="button" className="diag-more" onClick={() => setMore((v) => !v)}>
          {more ? 'Свернуть' : 'Что именно собирается?'}
        </button>
      </div>
      {more && <WhatWeCollect />}
      <div className="settings-row">
        <span>Всё, что уже отправлено</span>
        <button type="button" onClick={() => void wipe()} disabled={busy}>
          Удалить мои отчёты
        </button>
      </div>
    </>
  );
}
