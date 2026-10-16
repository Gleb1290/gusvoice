import { confirmAction } from './confirm';
import {
  dangerousLinkBody,
  dangerousLinkHost,
  DANGEROUS_LINK_CANCEL,
  DANGEROUS_LINK_CONFIRM,
  DANGEROUS_LINK_LABEL,
  DANGEROUS_LINK_TITLE,
} from './dangerousLinkRules';
import { Icon } from './components/Icon';
import { openLink } from './linkGuard';

/**
 * «Опасная ссылка» (gitea #218 п.5): ссылка, чей хост сервер нашёл в локальном списке угроз (`Message.dangerousLinks`),
 * рисуется с красной плашкой, а нажатие открывает окно с предупреждением — «Отмена» в фокусе (`confirm.ts`: Enter не
 * подтверждает), «Всё равно открыть» — только после отдельного подтверждения. Обычное окно «Переход на сторонний сайт» и
 * «больше не спрашивать» здесь НЕ действуют: пропустить предупреждение об опасной ссылке нельзя.
 */

/** Окно предупреждения; открыть ссылку — только по «Всё равно открыть». */
export async function openDangerousLink(url: string): Promise<void> {
  const host = dangerousLinkHost(url) ?? url;
  const ok = await confirmAction({
    title: DANGEROUS_LINK_TITLE,
    body: dangerousLinkBody(host),
    items: [url],
    tone: 'danger',
    icon: 'alert-circle',
    confirmLabel: DANGEROUS_LINK_CONFIRM,
    cancelLabel: DANGEROUS_LINK_CANCEL,
  });
  if (ok) openLink(url);
}

/** Плашка «Опасная ссылка» рядом со ссылкой. */
export function DangerousLinkBadge() {
  return (
    <span className="danger-link-badge" data-testid="danger-link-badge">
      <Icon name="alert-circle" size={12} />
      {DANGEROUS_LINK_LABEL}
    </span>
  );
}

/** Ссылка в тексте сообщения, помеченная как опасная. */
export function DangerousMessageLink({ url, text }: { url: string; text: string }) {
  return (
    <>
      <a
        className="msg-link danger-link"
        href={url}
        title={url}
        rel="noopener noreferrer nofollow"
        target="_blank"
        onClick={(e) => {
          e.preventDefault();
          void openDangerousLink(url);
        }}
      >
        {text}
      </a>
      <DangerousLinkBadge />
    </>
  );
}
