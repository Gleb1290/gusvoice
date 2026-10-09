/**
 * «Картинка в картинке» у видео (решение владельца Р-3: везде; сейчас — браузерная `requestPictureInPicture` в вебе и
 * десктопе WebView2, нативная Android — в релизной волне Р2). Как у Telegram Desktop (`media/view/media_view_pip.cpp`):
 * видео уходит в плавающее окошко, просмотр закрывается, лента остаётся под рукой.
 *
 * Играет ОДИН общий скрытый `<video>` у `body`, а не плеер просмотрщика или кадр в пузыре: те живут, пока на экране
 * (закрыли просмотр, лента пролистала пузырь — окошко погасло бы вместе с ними). Позиция и скорость переносятся.
 *
 * Нет API (Android WebView, Firefox без флага) — `pipSupported()` ложно, кнопок нет.
 */

let host: HTMLVideoElement | null = null;

/** Браузер умеет «картинку в картинке» для `<video>` и не запрещает её политикой. */
export function pipSupported(): boolean {
  if (typeof document === 'undefined' || typeof HTMLVideoElement === 'undefined') return false;
  return document.pictureInPictureEnabled === true && typeof HTMLVideoElement.prototype.requestPictureInPicture === 'function';
}

function hostVideo(): HTMLVideoElement {
  if (host && host.isConnected) return host;
  const v = document.createElement('video');
  v.className = 'gv-pip-host';
  v.playsInline = true;
  v.preload = 'auto';
  v.setAttribute('aria-hidden', 'true');
  v.tabIndex = -1;
  // Невидимая точка: элемент обязан быть в документе, но на странице его не видно.
  v.style.cssText = 'position:fixed;left:-2px;top:-2px;width:1px;height:1px;opacity:0;pointer-events:none';
  // Окошко закрыли — звук не играет дальше в невидимом элементе, файл отпускаем.
  v.addEventListener('leavepictureinpicture', () => {
    v.pause();
    v.removeAttribute('src');
    v.load();
  });
  document.body.appendChild(v);
  host = v;
  return v;
}

function metadataOf(v: HTMLVideoElement): Promise<void> {
  if (v.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = (ok: boolean) => {
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('error', onErr);
      window.clearTimeout(t);
      if (ok) resolve();
      else reject(new Error('video metadata'));
    };
    const onMeta = () => done(true);
    const onErr = () => done(false);
    // Жест человека «живёт» около 5 с — дольше ждать начала файла бессмысленно: окошко уже не дадут.
    const t = window.setTimeout(() => done(false), 5000);
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('error', onErr);
  });
}

/**
 * Открыть видео в окошке поверх всех окон. Звать прямо из нажатия (браузер требует жест человека). `at` — с какой
 * секунды, `rate` — скорость, `loop` — по кругу. Не вышло (нет API, отказ браузера) — бросает.
 */
export async function openPip(src: { url: string; at?: number; rate?: number; loop?: boolean }): Promise<void> {
  if (!pipSupported()) throw new Error('pip unsupported');
  const v = hostVideo();
  if (v.getAttribute('src') !== src.url) v.setAttribute('src', src.url);
  v.loop = !!src.loop;
  v.muted = false;
  await metadataOf(v);
  if (src.at && Number.isFinite(src.at)) v.currentTime = src.at;
  v.playbackRate = src.rate && src.rate > 0 ? src.rate : 1;
  if (document.pictureInPictureElement !== v) await v.requestPictureInPicture();
  // Скорость сбрасывается сменой файла — ставим ещё раз после загрузки.
  v.playbackRate = src.rate && src.rate > 0 ? src.rate : 1;
  await v.play().catch(() => {});
}
