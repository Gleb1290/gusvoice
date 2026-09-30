/**
 * Снимок настроек этого устройства — живой и заводской (#153).
 *
 * Отдельный файл от `settingsChanged.ts` не ради красоты: там чистая арифметика, которую можно
 * проверить без браузера, здесь — чтение хранилищ. Смешай их, и счёт отличий стало бы нельзя
 * посчитать нигде, кроме живого окна.
 *
 * ⚠️ Заводской снимок собирается из умолчаний САМИХ модулей, а не из копии значений. Умолчание
 * может зависеть от платформы (шумодав на телефоне) и от системы (анимация аватаров под
 * `prefers-reduced-motion`) — копия рассинхронизировалась бы молча.
 */

import { AUDIO_DEFAULTS, getAudioSettings } from './audioSettings';
import { animatedAvatarsDefault, animatedAvatarsEnabled } from './avatarAnimation';
import { CAMERA_DEFAULT, getCameraPreset } from './cameraSettings';
import { LINK_PREVIEWS_DEFAULT, linkPreviewsEnabled } from './components/LinkPreview';
import { liteModeDefault, liteModeEnabled } from './liteMode';
import { CLOSE_BEHAVIOR_DEFAULT, getCloseBehavior } from './desktopWindow';
import { getDownloadDir } from './downloads';
import { getHotkeys, HOTKEY_DEFAULTS } from './hotkeys';
import { COIN_NOTIFY_DEFAULT, coinNotifyLevel, OS_NOTIFY_DEFAULT, osNotifyLevel } from './notifications';
import { getOverlaySettings, OVERLAY_DEFAULTS } from './overlaySettings';
import type { SettingsSnapshot } from './settingsChanged';
import { getSoundSettings, SOUND_DEFAULTS } from './sounds';
import { getStreamSettings, STREAM_DEFAULTS } from './streamSettings';
import { getTheme, THEME_DEFAULT } from './theme';
import { getToastSettings, TOAST_DEFAULTS } from './toastSettings';
import { getSidebarWidth, getUiScale, SIDEBAR_DEFAULT, UI_SCALE_DEFAULT } from './uiPrefs';

/** Как настроено сейчас. */
export function readSettings(): SettingsSnapshot {
  return {
    audio: getAudioSettings(),
    camera: getCameraPreset(),
    hotkeys: getHotkeys(),
    stream: getStreamSettings(),
    overlay: getOverlaySettings(),
    toast: getToastSettings(),
    sounds: getSoundSettings(),
    theme: getTheme(),
    uiScale: getUiScale(),
    sidebarWidth: getSidebarWidth(),
    animatedAvatars: animatedAvatarsEnabled(),
    liteMode: liteModeEnabled(),
    linkPreviews: linkPreviewsEnabled(),
    osNotify: osNotifyLevel(),
    coinNotify: coinNotifyLevel(),
    closeBehavior: getCloseBehavior(),
    downloadDir: getDownloadDir(),
  };
}

/** Как было бы на чистом устройстве — с поправкой на платформу и системные просьбы. */
export function factorySettings(): SettingsSnapshot {
  return {
    audio: AUDIO_DEFAULTS,
    camera: CAMERA_DEFAULT,
    hotkeys: HOTKEY_DEFAULTS,
    stream: STREAM_DEFAULTS,
    overlay: OVERLAY_DEFAULTS,
    toast: TOAST_DEFAULTS,
    sounds: SOUND_DEFAULTS,
    theme: THEME_DEFAULT,
    uiScale: UI_SCALE_DEFAULT,
    sidebarWidth: SIDEBAR_DEFAULT,
    animatedAvatars: animatedAvatarsDefault(),
    liteMode: liteModeDefault(),
    linkPreviews: LINK_PREVIEWS_DEFAULT,
    osNotify: OS_NOTIFY_DEFAULT,
    coinNotify: COIN_NOTIFY_DEFAULT,
    closeBehavior: CLOSE_BEHAVIOR_DEFAULT,
    downloadDir: null,
  };
}
