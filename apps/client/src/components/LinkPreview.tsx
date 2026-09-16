import { useEffect, useState } from 'react';
import { api } from '../api';
import { isOwnLink, LinkConfirmModal, openLink, shouldWarnAboutLink } from '../linkGuard';

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

export function LinkPreviewCard({
  url,
  authorId,
  authorName,
}: {
  url: string;
  authorId: string | null;
  authorName: string;
}) {
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
    if (shouldWarnAboutLink(url, authorId)) setAsk(true);
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
        <LinkConfirmModal url={url} authorId={authorId} authorName={authorName} onClose={() => setAsk(false)} />
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
