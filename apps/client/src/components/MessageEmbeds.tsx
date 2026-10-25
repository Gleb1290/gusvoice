import type { Attachment, MessageEmbed } from '@gusvoice/shared';
import type { ReactNode } from 'react';
import { MessageLink } from '../linkGuard';

/**
 * Карточки сообщения вебхука (#24) — по образцу Discord Embed Object: цветная полоса слева (`color`), автор (значок,
 * имя-ссылка), заголовок-ссылка, описание нашим markdown (`renderText` — тот же рендер, что у текста сообщения), поля
 * (`inline` — в ряд до трёх, сетка `.embed-fields`), миниатюра справа, картинка, подвал со временем.
 *
 * Картинки — только наши (сервер оставляет в `image`/`thumbnail`/`iconUrl` лишь адреса нашего хранилища, `normalizeEmbeds`);
 * чужая картинка приходит в `imageLink`/`thumbnailLink` и показывается обычной ссылкой — браузер читателя на чужой
 * сервер не ходит (пиксель слежения, #4; как у `LinkPreviewCard`). Ссылки — через `MessageLink`: подписанная ссылка
 * (заголовок, имя автора) всегда спрашивает «Открыть ссылку?» с полным адресом — подпись может врать про адрес.
 */
/**
 * Вложения, которые показываются ОТДЕЛЬНО от карточек: файл, на который карточка сослалась `attachment://имя` (сервер
 * подставил в `image`/`thumbnail` его адрес), уже виден картинкой в карточке — как у Discord, второй раз его не рисуем.
 */
export function attachmentsBesideEmbeds(
  attachments: readonly Attachment[] | undefined,
  embeds: readonly MessageEmbed[] | undefined,
): Attachment[] {
  if (!attachments?.length) return [];
  if (!embeds?.length) return [...attachments];
  const inCards = new Set<string>();
  for (const e of embeds) {
    if (e.image?.url) inCards.add(e.image.url);
    if (e.thumbnail?.url) inCards.add(e.thumbnail.url);
  }
  return attachments.filter((a) => !inCards.has(a.url));
}

export function MessageEmbeds({ embeds, renderText }: { embeds: readonly MessageEmbed[]; renderText: (text: string) => ReactNode }) {
  return (
    <div className="embeds">
      {embeds.map((e, i) => (
        <EmbedCard key={i} e={e} renderText={renderText} />
      ))}
    </div>
  );
}

/** 0xRRGGBB → `#rrggbb`; нет цвета — полоса цвета рамки (как у Discord карточка без `color`). */
export function embedColor(color: number | undefined): string | undefined {
  if (typeof color !== 'number' || !Number.isInteger(color) || color < 0 || color > 0xffffff) return undefined;
  return `#${color.toString(16).padStart(6, '0')}`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function EmbedCard({ e, renderText }: { e: MessageEmbed; renderText: (text: string) => ReactNode }) {
  const color = embedColor(e.color);
  const time = e.timestamp ? fmtTime(e.timestamp) : '';
  return (
    <div className="embed" style={color ? { borderLeftColor: color } : undefined}>
      <div className="embed-grid">
        <div className="embed-main">
          {e.author && (
            <div className="embed-author">
              {e.author.iconUrl && <img className="embed-author-icon" src={e.author.iconUrl} alt="" loading="lazy" />}
              {e.author.url ? <MessageLink url={e.author.url} text={e.author.name} /> : <span>{e.author.name}</span>}
            </div>
          )}
          {e.title && (
            <div className="embed-title">{e.url ? <MessageLink url={e.url} text={e.title} /> : e.title}</div>
          )}
          {e.description && <div className="embed-desc">{renderText(e.description)}</div>}
          {e.fields?.length ? (
            <div className="embed-fields">
              {e.fields.map((f, j) => (
                <div key={j} className={`embed-field${f.inline ? ' inline' : ''}`}>
                  {f.name && <div className="embed-field-name">{f.name}</div>}
                  {f.value && <div className="embed-field-value">{renderText(f.value)}</div>}
                </div>
              ))}
            </div>
          ) : null}
        </div>
        {e.thumbnail && <img className="embed-thumb" src={e.thumbnail.url} alt="" loading="lazy" />}
      </div>
      {e.image && <img className="embed-image" src={e.image.url} alt="" loading="lazy" />}
      {(e.imageLink || e.thumbnailLink) && (
        <div className="embed-links">
          {e.thumbnailLink && <MessageLink url={e.thumbnailLink} />}
          {e.imageLink && <MessageLink url={e.imageLink} />}
        </div>
      )}
      {(e.footer || time) && (
        <div className="embed-footer">
          {e.footer?.iconUrl && <img className="embed-footer-icon" src={e.footer.iconUrl} alt="" loading="lazy" />}
          <span>
            {e.footer?.text}
            {e.footer?.text && time ? ' • ' : ''}
            {time}
          </span>
        </div>
      )}
    </div>
  );
}
