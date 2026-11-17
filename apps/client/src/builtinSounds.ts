import { registerBuiltinSound, warmBuiltinSound, type SoundEvent } from './sounds';

/**
 * Вшитые записи звуков игр (29.10, выбраны владельцем на прослушивании; список и источники —
 * `assets/sounds/README.md`). Файл `assets/sounds/<имя>.mp3|ogg` подменяет синтез события по таблице ниже;
 * нет файла — звучит синтез `CUES` (`sounds.ts`). Новая запись встаёт файлом без правки кода, если её имя уже здесь
 * (`wheel-jackpot`, `duel-win` — ждут переделанных записей).
 *
 * 🔴 Регистрация — здесь, а не в `sounds.ts`: `import.meta.glob` есть только у Vite, а `sounds.ts` тесты исполняют
 * без сборки. Модуль подключён в `main.tsx` побочным импортом — исполняется при старте до первого звука.
 */
export const BUILTIN_SOUND_FILES: Readonly<Record<string, SoundEvent>> = {
  'wheel-tick': 'wheelTick',
  'wheel-win': 'wheelWin',
  'wheel-jackpot': 'wheelJackpot',
  'dice-roll': 'diceRoll',
  'duel-win': 'duelWin',
  'duel-lose': 'duelLose',
  'duel-invite': 'duelInvite',
  'greedy-burn': 'greedyBurn',
  'rps-reveal': 'rpsReveal',
  'prediction-result': 'predictionResult',
  'prediction-open': 'predictionOpen',
  'prediction-closed': 'predictionClosed',
  'games-launch': 'gamesLaunch',
};

/**
 * Пары «событие → ссылка» из найденных сборкой файлов (ключ — путь `…/<имя>.<ext>`, значение — ссылка на ассет).
 * Чужие имена пропускаются; если у события есть и `.mp3`, и `.ogg` — берётся `.mp3` (его играют все движки, `.ogg` —
 * не Safari). Чистая функция: проверяется без Vite.
 */
export function builtinSoundsFrom(files: Readonly<Record<string, string>>): Array<[SoundEvent, string]> {
  const picked = new Map<SoundEvent, { url: string; mp3: boolean }>();
  for (const [path, url] of Object.entries(files)) {
    const m = /([^/]+)\.(mp3|ogg)$/.exec(path);
    if (!m || !url || !Object.prototype.hasOwnProperty.call(BUILTIN_SOUND_FILES, m[1])) continue;
    const event = BUILTIN_SOUND_FILES[m[1]];
    const mp3 = m[2] === 'mp3';
    const prev = picked.get(event);
    if (!prev || (mp3 && !prev.mp3)) picked.set(event, { url, mp3 });
  }
  return [...picked].map(([event, { url }]) => [event, url]);
}

const FILES: Record<string, string> = import.meta.glob<string>('./assets/sounds/*.{mp3,ogg}', {
  eager: true,
  import: 'default',
  query: '?url',
});
for (const [event, url] of builtinSoundsFrom(FILES)) registerBuiltinSound(event, url);

/**
 * Трещотка колеса планирует щелчки только готовым буфером (`scheduleWheelTicks`) — декодируем запись щелчка на первом
 * жесте человека: до жеста браузер не даёт завести `AudioContext`, а к первому вращению буфер уже готов.
 */
if (typeof window !== 'undefined') {
  const warm = () => warmBuiltinSound('wheelTick');
  window.addEventListener('pointerdown', warm, { once: true, capture: true });
  window.addEventListener('keydown', warm, { once: true, capture: true });
}
