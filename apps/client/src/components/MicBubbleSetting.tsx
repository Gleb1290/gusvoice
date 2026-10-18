import { useEffect, useMemo, useRef, useState } from 'react';
import { getAudioSettings, type AudioSettings } from '../audioSettings';
import { confirmAction } from '../confirm';
import { isAndroid } from '../hotkeys';
import { micBubbleToggle, needsMicBubbleHint } from '../micActionRules';
import { canDrawOverlays, micBubbleSupported, openOverlaySettings } from '../nativeMicActions';
import { Toggle } from './Toggle';

/**
 * Пузырь микрофона поверх других приложений (#156, порция 2, натив — `MicBubble.kt`): строка-тумблер «Кнопка поверх
 * приложений» в группе «Режим передачи» и подсказка под рацией (`needsMicBubbleHint`). Только Android-приложение, у
 * которого мост знает пузырь (`micBubbleSupported`); на ПК, в вебе и в старом APK — ничего.
 *
 * Разрешение «Показ поверх других приложений» просим в момент включения своим окном (`confirmAction`) → экран Android;
 * по возврату на экран (`visibilitychange`/`focus` ПОСЛЕ ухода страницы) перепроверяем и включаем. Не дали — тумблер
 * остаётся выключенным, повторно не просим (только по новому нажатию).
 */
export function MicBubbleSetting({ s, update }: { s: AudioSettings; update: (next: AudioSettings) => void }) {
  const supported = useMemo(() => isAndroid() && micBubbleSupported(), []);
  const [asked, setAsked] = useState(false);
  // Свежий `update` без перезапуска ожидания: окно настроек пересоздаёт функцию на каждой отрисовке.
  const updateRef = useRef(update);
  updateRef.current = update;

  useEffect(() => {
    if (!asked) return;
    let left = false;
    const onReturn = () => {
      if (document.visibilityState === 'hidden') {
        left = true;
        return;
      }
      // `focus` сразу после закрытия своего окна — ещё до ухода в настройки: не в счёт.
      if (!left) return;
      setAsked(false);
      if (canDrawOverlays()) updateRef.current({ ...getAudioSettings(), micBubble: true });
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => {
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, [asked]);

  if (!supported) return null;

  const on = s.micBubble === true;

  async function flip(next: boolean) {
    const act = micBubbleToggle(next, canDrawOverlays());
    if (act !== 'ask') {
      update({ ...s, micBubble: act === 'enable' });
      return;
    }
    const ok = await confirmAction({
      title: 'Показ поверх других приложений',
      body:
        'Чтобы кнопка микрофона была видна поверх игр и других приложений, Android просит разрешить это GusVoice. ' +
        'Откроются настройки «Показ поверх других приложений»: выберите GusVoice, разрешите и вернитесь — кнопка включится сама. ' +
        'Не разрешите — всё останется как было.',
      confirmLabel: 'Открыть настройки',
      cancelLabel: 'Не сейчас',
      tone: 'neutral',
    });
    if (!ok) return;
    setAsked(true);
    openOverlaySettings();
  }

  return (
    <>
      {/* Без пузыря рацию на телефоне зажать нечем — человек немеет. */}
      {needsMicBubbleHint({ supported, pushToTalk: s.pushToTalk, micBubble: on }) && (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Чтобы говорить с рацией, включите кнопку поверх приложений.
        </div>
      )}
      <div className="settings-row">
        <span>Кнопка поверх приложений</span>
        <Toggle checked={on} onChange={(v) => void flip(v)} label="Кнопка поверх приложений" />
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        Круглая кнопка микрофона поверх игр и других приложений: нажал — выключил/включил микрофон, с рацией — держишь и
        говоришь.
      </div>
    </>
  );
}
