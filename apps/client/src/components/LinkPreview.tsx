import { useEffect, useState } from 'react';
import { api } from '../api';
import { isOwnLink, LinkConfirmModal, openLink, shouldWarnAboutLink } from '../linkGuard';
import { composerPreviewLink, LINK_PREVIEW_DELAY_MS } from '../linkPreviewRules';
import { Icon } from './Icon';

/**
 * Карточка под сообщением со ссылкой (#64).
 *
 * Картинки в карточке НЕТ намеренно, и это не «не успел». Показать `og:image` как есть — значит
 * заставить браузер каждого читателя сходить на чужой сервер, раскрыв ему свой IP и факт чтения.
 * Ровно эту дыру уже закрывали для вложений (см. `storage.ts`: вложения ограничены нашим бакетом,
 * иначе произвольный URL в сообщении = трекинг-пиксель). Возвращать её через предпросмотр нельзя.
 * Правильный путь — проксировать картинку через свой storage; до тех пор карточка текстовая.
 *
 * Клик по карточке ведёт себя как клик по ссылке: то же предупреждение о переходе (#63), те же
 * галочки доверия. Иначе карточка стала бы дырой в обход предупреждения.
 */
const KEY = 'gv_link_preview';

/** Карточки ссылок показываем, пока человек их не выключил. */
export const LINK_PREVIEWS_DEFAULT = true;

export function linkPreviewsEnabled(): boolean {
  return localStorage.getItem(KEY) !== 'off';
}
export function setLinkPreviewsEnabled(on: boolean): void {
  localStorage.setItem(KEY, on ? 'on' : 'off');
}

type Preview = { url: string; title: string | null; description: string | null; siteName: string | null };

/**
 * Пер-вкладочный кэш: один и тот же адрес встречается в ленте много раз, а сообщения
 * перерисовываются постоянно. Без него каждый ререндер = запрос к нашему бэкенду.
 * `null` = «карточки нет», её тоже надо помнить, иначе бесполезный запрос повторяется вечно.
 */
const cache = new Map<string, Preview | null>();
const inflight = new Map<string, Promise<void>>();

/** Карточка по адресу — из кэша или с сервера; «карточки нет» и сбой — `null` (и тоже в кэше). */
function loadPreview(url: string): Promise<Preview | null> {
  if (cache.has(url)) return Promise.resolve(cache.get(url) ?? null);
  const run =
    inflight.get(url) ??
    api
      .linkPreview(url)
      .then((p) => {
        cache.set(url, p ?? null);
      })
      .catch(() => {
        cache.set(url, null);
      })
      .finally(() => inflight.delete(url));
  inflight.set(url, run);
  return run.then(() => cache.get(url) ?? null);
}

/**
 * Превью над полем ввода (G19, Telegram Desktop `WebpageProcessor` + Web A `WebPagePreview`): через секунду после последней
 * буквы берётся ПЕРВАЯ ссылка текста, над полем встаёт полоса «сайт · заголовок · описание» с крестиком. Крестик
 * (`onDismiss`) — отправить без превью (`noPreview` у сообщения); пока ссылки в тексте остаются, полоса не возвращается
 * (признак держит зовущий, `linkPreviewRules.nextDismissed`). Тот же запрос и кэш, что у карточки под сообщением, — без
 * картинки (почему — в комментарии выше). Выключенные в настройках карточки ссылок полосу тоже не рисуют.
 */
export function ComposerLinkPreview({ text, dismissed, onDismiss }: { text: string; dismissed: boolean; onDismiss: () => void }) {
  const [link, setLink] = useState<string | null>(null);
  const [data, setData] = useState<Preview | null>(null);
  useEffect(() => {
    const next = composerPreviewLink(text, isOwnLink);
    // Ссылка пропала из текста — полоса уходит сразу; новая или изменённая — после паузы в наборе.
    if (next === null) {
      setLink(null);
      return;
    }
    const t = setTimeout(() => setLink(next), LINK_PREVIEW_DELAY_MS);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => {
    if (!link || !linkPreviewsEnabled()) {
      setData(null);
      return;
    }
    let alive = true;
    void loadPreview(link).then((p) => {
      if (alive) setData(p);
    });
    return () => {
      alive = false;
    };
  }, [link]);
  if (dismissed || !link || !data || !linkPreviewsEnabled()) return null;
  let host = link;
  try {
    host = new URL(link).host;
  } catch {
    /* оставляем как есть */
  }
  return (
    <div className="reply-strip link-strip" data-testid="composer-link-preview">
      <Icon name="link" size={14} />
      <span className="ls-body">
        <b className="ls-title">{data.title || data.siteName || host}</b>
        <span className="ls-desc">{data.description || link}</span>
      </span>
      <button
        type="button"
        className="rs-close"
        title="Отправить без превью"
        aria-label="Отправить без превью"
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onDismiss}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

export function LinkPreviewCard({ url }: { url: string }) {
  const [data, setData] = useState<Preview | null | undefined>(() => cache.get(url));
  const [ask, setAsk] = useState(false);

  useEffect(() => {
    if (!linkPreviewsEnabled()) return;
    if (cache.has(url)) {
      setData(cache.get(url));
      return;
    }
    let alive = true;
    const run =
      inflight.get(url) ??
      api
        .linkPreview(url)
        // 204 «карточки нет» приходит как undefined — приводим к null, чтобы `cache.has` работал.
        .then((p) => {
          cache.set(url, p ?? null);
        })
        .catch(() => {
          cache.set(url, null); // не долбим бэкенд на каждый ререндер после ошибки
        })
        .finally(() => inflight.delete(url));
    inflight.set(url, run);
    void run.then(() => {
      if (alive) setData(cache.get(url) ?? null);
    });
    return () => {
      alive = false;
    };
  }, [url]);

  if (!data) return null;

  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* оставляем как есть */
  }

  function go() {
    if (shouldWarnAboutLink(url)) setAsk(true);
    else openLink(url);
  }

  return (
    <>
      <button type="button" className="lp-card" onClick={go} title={url}>
        <span className="lp-site">{data.siteName || host}</span>
        {data.title && <span className="lp-title">{data.title}</span>}
        {data.description && <span className="lp-desc">{data.description}</span>}
      </button>
      {ask && (
        <LinkConfirmModal url={url} onClose={() => setAsk(false)} />
      )}
    </>
  );
}

/**
 * Ссылки из текста сообщения — не больше двух, иначе одно сообщение забивает всю ленту.
 * Ссылки на свой инстанс пропускаем: предпросмотр собственных страниц бессмыслен, а запрос лишний.
 */
export function previewableLinks(content: string): string[] {
  const found = content.match(/https?:\/\/[^\s<>"]+/g) ?? [];
  const out: string[] = [];
  for (const raw of found) {
    const url = raw.replace(/[.,;:!?)\]]+$/, ''); // хвостовая пунктуация не часть адреса
    if (!out.includes(url) && !isOwnLink(url)) out.push(url);
    if (out.length === 2) break;
  }
  return out;
}
