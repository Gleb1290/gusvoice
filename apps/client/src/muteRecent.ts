import { DM_MUTE_PERIODS, rememberMutePeriod } from './dmListRules';

/**
 * Запомненные сроки подменю «Выключить уведомления» (07.10, G03, как у Telegram Desktop: два значения, выбранных в окне
 * «Выключить на время…»; правило — `dmListRules.rememberMutePeriod`). Хранятся на устройстве, не на сервере: у Telegram это
 * тоже настройка клиента (`main_session_settings.cpp`, 03·1.2.5). Недоступное хранилище или мусор — как «ничего не запомнено».
 */
const KEY = 'gv.mute.recent';

/** Запомненные сроки в секундах, по возрастанию, только из известного списка (`DM_MUTE_PERIODS`), не больше двух. */
export function loadMuteRecent(): number[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    const known = new Set(DM_MUTE_PERIODS.map((p) => p.seconds));
    return [...new Set(raw.filter((x): x is number => typeof x === 'number' && known.has(x)))].sort((a, b) => a - b).slice(0, 2);
  } catch {
    return [];
  }
}

/** Запомнить срок, выбранный в окне «Выключить на время…». */
export function saveMuteRecent(chosen: number): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(rememberMutePeriod(loadMuteRecent(), chosen)));
  } catch {
    /* хранилище недоступно — меню просто не запомнит */
  }
}
