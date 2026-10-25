import { useState } from 'react';
import { createPortal } from 'react-dom';
import { config } from './config';
import { isDesktop } from './hotkeys';
import { openExternal } from './desktopWindow';
import { displayUrl, isSuspiciousUrl, rangesVisible, suspiciousRanges } from './linkSafety';
import { DangerousMessageLink } from './dangerousLink';
import { isDangerousLink } from './dangerousLinkRules';

/**
 * Ссылки в сообщениях — ровно как у Telegram (#218, п.4; решение владельца 10.10).
 *
 * Видимая ссылка (текст = адрес) открывается СРАЗУ. Окно «Открыть ссылку?» — только если адрес подозрительный
 * (`linkSafety.isSuspiciousUrl`: логин/пароль в адресе, битый punycode, смесь письменностей в хосте). Скрытых ссылок
 * (текст ≠ адрес) в нашей разметке нет (`messageText.tsx`), поэтому второго повода для окна нет. Галочек «не спрашивать»
 * и настройки «предупреждать» у Telegram нет — их убрали; старый ключ `gv_link_warn` в localStorage просто не читается.
 *
 * Ссылки на свой инстанс (voice.example.com и его api./presence./lk.) не спрашивают никогда.
 */

/** Hosts that are "us": the instance's own API/app — never worth an interstitial. */
function isOwnHost(u: URL): boolean {
  const own = new Set<string>();
  try {
    own.add(new URL(config.apiUrl).host);
  } catch {
    /* apiUrl may be relative in embedded builds */
  }
  own.add(location.host);
  // api.voice.example.com and voice.example.com are the same instance to a human.
  const base = (h: string) => h.replace(/^(api|presence|lk)\./, '');
  return [...own].some((h) => base(h) === base(u.host));
}

/** Ссылка на наш же инстанс. Такие не предупреждаем (#63) и не превьюим (#64). */
export function isOwnLink(url: string): boolean {
  try {
    return isOwnHost(new URL(url));
  } catch {
    return false;
  }
}

/** Нужно ли окно «Открыть ссылку?»: чужой подозрительный адрес. Обычная видимая ссылка — нет. */
export function shouldWarnAboutLink(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (isOwnHost(u)) return false;
  return isSuspiciousUrl(url);
}

/** Open a link the way this platform should: desktop hands it to the OS browser, web opens a tab. */
export function openLink(url: string) {
  if (isDesktop()) {
    void openExternal(url).catch(() => window.open(url, '_blank', 'noopener,noreferrer'));
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/** Shorten a long URL for display without hiding the host — the host is the part that matters. */
function display(url: string): string {
  try {
    const u = new URL(url);
    const rest = (u.pathname + u.search).replace(/\/$/, '');
    const short = rest.length > 34 ? rest.slice(0, 33) + '…' : rest;
    return u.host + short;
  } catch {
    return url;
  }
}

/**
 * Окно «Открыть ссылку?» — вид tdesktop (`core/click_handler_types.cpp:410-540`, `lang.strings:5193-5195`): вопрос,
 * адрес целиком (хост в Юникоде), символы чужого алфавита подсвечены, под адресом пояснение, кнопки «Отмена» / «Открыть».
 * Если подсветки нет (логин в адресе, битый punycode) — жирным выделен домен (`BoldDomainInUrl`).
 */
export function LinkConfirmModal({ url, onClose }: { url: string; onClose: () => void }) {
  let shown = displayUrl(url);
  let ranges = suspiciousRanges(shown);
  if (!rangesVisible(shown, ranges)) {
    // Подсвеченные символы невидимы — показываем закодированный адрес, где видно всё.
    try {
      shown = new URL(url).href;
    } catch {
      shown = url;
    }
    ranges = [];
  }
  const parts: Array<{ text: string; kind: 'plain' | 'mark' | 'host' }> = [];
  if (ranges.length) {
    let at = 0;
    for (const r of ranges) {
      if (r.from > at) parts.push({ text: shown.slice(at, r.from), kind: 'plain' });
      parts.push({ text: shown.slice(r.from, r.from + r.length), kind: 'mark' });
      at = r.from + r.length;
    }
    if (at < shown.length) parts.push({ text: shown.slice(at), kind: 'plain' });
  } else {
    const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?([^/?#:]*)/i.exec(shown);
    if (m) {
      const at = m.index + m[0].length - m[1].length;
      const www = m[1].startsWith('www.') ? 4 : 0;
      parts.push({ text: shown.slice(0, at + www), kind: 'plain' });
      parts.push({ text: m[1].slice(www), kind: 'host' });
      parts.push({ text: shown.slice(at + m[1].length), kind: 'plain' });
    } else parts.push({ text: shown, kind: 'plain' });
  }

  /* В портал, а не на месте (фаза 0.4 ЛС, 30.09): ссылка живёт внутри ленты, а у `.messages` теперь `contain: strict`,
     и для `position: fixed` она сама становится рамкой — окно прижалось бы к ленте вместо всего экрана. */
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal link-confirm"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lc-title"
      >
        <h2 id="lc-title">Открыть ссылку?</h2>
        <div className="lc-url" data-marked={ranges.length ? '1' : undefined}>
          {parts.map((p, i) =>
            p.kind === 'plain' ? (
              p.text
            ) : (
              <span key={i} className={p.kind === 'mark' ? 'lc-mark' : 'lc-bold'}>
                {p.text}
              </span>
            ),
          )}
        </div>
        {ranges.length > 0 && (
          <div className="lc-hint">Выделенные символы из другого алфавита, чем остальной адрес.</div>
        )}
        <div className="modal-actions">
          <button type="button" className="link" onClick={onClose}>
            Отмена
          </button>
          <button
            type="button"
            onClick={() => {
              openLink(url);
              onClose();
            }}
          >
            Открыть
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Ссылка в сообщении: обычная открывается сразу, подозрительная — через окно «Открыть ссылку?»; опасная (`linkthreats1`) — «Опасная ссылка». */
export function MessageLink({ url, dangerous, text }: {
  url: string;
  /** `Message.dangerousLinks` (признак `linkthreats1`): ссылка с таким хостом — «Опасная ссылка» (`dangerousLink.tsx`). */
  dangerous?: readonly string[] | null;
  /**
   * Подпись вместо адреса (карточка вебхука, #24: заголовок, имя автора). Подписанная чужая ссылка ВСЕГДА спрашивает
   * «Открыть ссылку?» с полным адресом — подпись может врать про адрес (так же делает Discord с маскированными ссылками).
   */
  text?: string;
}) {
  const [ask, setAsk] = useState(false);
  if (isDangerousLink(url, dangerous)) return <DangerousMessageLink url={url} text={text ?? display(url)} />;
  return (
    <>
      <a
        className="msg-link"
        href={url}
        title={url}
        rel="noopener noreferrer"
        target="_blank"
        onClick={(e) => {
          e.preventDefault();
          if (text !== undefined ? !isOwnLink(url) : shouldWarnAboutLink(url)) setAsk(true);
          else openLink(url);
        }}
      >
        {text ?? display(url)}
      </a>
      {ask && <LinkConfirmModal url={url} onClose={() => setAsk(false)} />}
    </>
  );
}
