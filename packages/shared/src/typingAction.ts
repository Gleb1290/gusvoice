/**
 * Виды действия в событии набора (ЛС #211, G21, Telegram 02·11.1–11.4): вместо одного «печатает…» ещё «записывает
 * голосовое…» и «отправляет фото / видео / файл…»; затем «отправляет голосовое…» (`voice_upload`) — пока записанное голосовое
 * ещё грузится (до него собеседник видел «отправляет файл»; решение владельца 07.10, 02·11.1).
 *
 * Поле `action` в кадре `typing` — ТОЛЬКО добавление (правило 11): старый клиент его не знает и показывает «печатает»;
 * сервер, не знающий поля, не передаёт его — тогда новый клиент тоже показывает «печатает». Поэтому «печатает» в кадре
 * НЕ пишется вовсе (отсутствие поля = «печатает»), а всё неизвестное при разборе отбрасывается в «печатает».
 * `sticker` — «выбирает стикер…» (С2 порция 2; tdesktop `lng_send_action_choose_sticker`), пока открыта панель стикеров:
 * клиент до него показывает «печатает» (`parseTypingAction`), сервер до него пересылает кадр без вида — тоже «печатает».
 * `round` — «записывает видеосообщение…» (кружок; tdesktop `lng_send_action_record_round`, Android `RecordingRound`): пока пишется
 * кружок. В отличие от стикера, для него есть запасной вид — прежнее «записывает голосовое»: шлюз отдаёт `round` ТОЛЬКО
 * соединению с возможностью `typing2` (`FEATURE_TYPING2`, `typingActionFor`), остальным — `voice`; клиент при сервере без
 * признака `typing2` сам шлёт `voice` (`typingActionToServer`).
 */
/**
 * Признак СЕРВЕРА и возможность СОЕДИНЕНИЯ (09.10, сверка с Telegram п.6): вид действия `round` («записывает видеосообщение…») в
 * кадре `typing`. Клиент объявляет `typing2` в `identify.caps` — шлюз отдаёт `round` только таким соединениям, остальным
 * прежнее `voice` («записывает голосовое»); `/auth/me` `features` с `typing2` говорит клиенту, что сервер `round` понимает
 * (иначе клиент шлёт `voice`). Миграции нет. Только добавления (правило 11). Живёт здесь, а не в `ws.ts`: модуль грузится в тесте отдельно, без зависимостей.
 */
export const FEATURE_TYPING2 = 'typing2';

export const TYPING_ACTIONS = ['typing', 'voice', 'photo', 'video', 'file', 'voice_upload', 'sticker', 'round'] as const;
export type TypingAction = (typeof TYPING_ACTIONS)[number];

/** Вид действия из чужого кадра: неизвестное или отсутствующее — `'typing'` (никогда не бросает). */
export function parseTypingAction(raw: unknown): TypingAction {
  return typeof raw === 'string' && (TYPING_ACTIONS as readonly string[]).includes(raw) ? (raw as TypingAction) : 'typing';
}

/**
 * Что главнее, когда у одного человека одновременно идёт несколько действий (пока файл грузится, он ещё и печатает
 * следующее): запись голоса = отправка голосового > отправка файла/фото/видео > набор текста. Меньшее не вытесняет живое
 * большее. «Отправляет голосовое» РАВНО «записывает»: запись только что кончилась, её сигнал жив до 5 с, и более слабый не
 * сменил бы подпись, а нужен именно переход «записывает» → «отправляет».
 */
export function typingActionRank(action: TypingAction): number {
  if (action === 'sticker') return 1; // «выбирает стикер» — слабое, как набор текста
  if (action === 'round') return 3; // «записывает видеосообщение» — как запись голоса
  return action === 'voice' || action === 'voice_upload' ? 3 : action === 'typing' ? 1 : 2;
}

/**
 * Вид действия для получателя с известными возможностями: `round` («записывает видеосообщение») — только тому, кто объявил
 * `typing2`; остальные видят прежнее «записывает голосовое» (правило 11: новое значение не доходит до того, кто его не
 * поймёт). Остальные виды не трогаем.
 */
export function typingActionFor(action: TypingAction, caps: ReadonlySet<string> | undefined): TypingAction {
  return action === 'round' && !caps?.has(FEATURE_TYPING2) ? 'voice' : action;
}

/** То же для отправителя: сервер без признака `typing2` не знает `round` — шлём `voice` (иначе собеседнику «печатает»). */
export function typingActionToServer(action: TypingAction, features: readonly string[] | null | undefined): TypingAction {
  return action === 'round' && !features?.includes(FEATURE_TYPING2) ? 'voice' : action;
}

/** Что писать в исходящем/пересылаемом кадре: `'typing'` — НИЧЕГО (поле опускается, кадр как до G21). */
export function typingActionField(action: TypingAction): { action?: TypingAction } {
  return action === 'typing' ? {} : { action };
}

/**
 * Какое действие соответствует отправке файлов (по MIME каждого): только картинки — «фото», только видео — «видео»,
 * любая другая смесь или не-медиа — «файл»; пусто — `null` (нечего сообщать). Картинка без типа (`''`) — «файл».
 */
export function uploadTypingAction(mimes: readonly string[]): TypingAction | null {
  if (mimes.length === 0) return null;
  if (mimes.every((m) => m.startsWith('image/'))) return 'photo';
  if (mimes.every((m) => m.startsWith('video/'))) return 'video';
  return 'file';
}
