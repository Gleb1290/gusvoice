import { useState } from 'react';
import { config } from './config';
import { isDesktop } from './hotkeys';
import { openExternal } from './desktopWindow';

/**
 * Interstitial for links posted in chat: show where the link actually goes before leaving.
 *
 * The point isn't ceremony, it's that a link in a message is text somebody else wrote — a friendly
 * chat is exactly where a "смотри что нашёл" leads somewhere it shouldn't. So the destination gets
 * shown once, with the host spelled out, and the user can silence the prompt per-author or entirely.
 *
 * Never prompts for links to this instance itself (voice.example.com and its api./media./lk. neighbours) — warning about your
 * own server would train everyone to click through without reading, which defeats the whole thing.
 */
const KEY = 'gv_link_warn';

type Prefs = { off: boolean; trusted: string[] };

function load(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Prefs>;
    return { off: raw.off === true, trusted: Array.isArray(raw.trusted) ? raw.trusted : [] };
  } catch {
    return { off: false, trusted: [] };
  }
}
function save(p: Prefs) {
  localStorage.setItem(KEY, JSON.stringify(p));
}

/** Silence the prompt for everything (Настройки → Внешний вид, or the checkbox in the prompt). */
export function setLinkWarningsOff(off: boolean) {
  save({ ...load(), off });
}
export function linkWarningsOff(): boolean {
  return load().off;
}
/** Silence the prompt for one author's links. */
export function trustLinksFrom(userId: string) {
  const p = load();
  if (!p.trusted.includes(userId)) save({ ...p, trusted: [...p.trusted, userId] });
}
export function trustedLinkAuthors(): string[] {
  return load().trusted;
}
export function forgetTrustedLinkAuthors() {
  save({ ...load(), trusted: [] });
}

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

export function shouldWarnAboutLink(url: string, authorId: string | null): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (isOwnHost(u)) return false;
  const p = load();
  if (p.off) return false;
  if (authorId && p.trusted.includes(authorId)) return false;
  return true;
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

export function LinkConfirmModal({
  url,
  authorId,
  authorName,
  onClose,
}: {
  url: string;
  authorId: string | null;
  authorName: string;
  onClose: () => void;
}) {
  const [trustAuthor, setTrustAuthor] = useState(false);
  const [never, setNever] = useState(false);
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep the raw string */
  }

  function go() {
    if (trustAuthor && authorId) trustLinksFrom(authorId);
    if (never) setLinkWarningsOff(true);
    openLink(url);
    onClose();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal link-confirm"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lc-title"
      >
        <h2 id="lc-title">Переход на сторонний сайт</h2>
        <div className="lc-host">{host}</div>
        {/* Full URL in a scrollable box: the host answers "куда", the rest answers "точно туда?" */}
        <div className="lc-url">{url}</div>
        <label className="lc-check">
          <input type="checkbox" checked={trustAuthor} onChange={(e) => setTrustAuthor(e.target.checked)} />
          <span>Больше не спрашивать про ссылки от {authorName}</span>
        </label>
        <label className="lc-check">
          <input type="checkbox" checked={never} onChange={(e) => setNever(e.target.checked)} />
          <span>Больше не спрашивать про ссылки вообще</span>
        </label>
        <div className="modal-actions">
          <button type="button" className="link" onClick={onClose}>
            Отмена
          </button>
          <button type="button" onClick={go}>
            Перейти
          </button>
        </div>
      </div>
    </div>
  );
}

/** A link inside a message: shows where it goes, asks first unless silenced. */
export function MessageLink({
  url,
  authorId,
  authorName,
}: {
  url: string;
  authorId: string | null;
  authorName: string;
}) {
  const [ask, setAsk] = useState(false);
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
          if (shouldWarnAboutLink(url, authorId)) setAsk(true);
          else openLink(url);
        }}
      >
        {display(url)}
      </a>
      {ask && (
        <LinkConfirmModal url={url} authorId={authorId} authorName={authorName} onClose={() => setAsk(false)} />
      )}
    </>
  );
}
