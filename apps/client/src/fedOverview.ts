import type { FederationOverview } from '@gusvoice/shared';

/**
 * Состояние федерации для вкладки админки, когда сервер его не отдал (30.09, нашёл держатель коробки с GitHub).
 *
 * 🔴 При `FEDERATION_ENABLED=false` (так коробка ставится по умолчанию) сервер НЕ регистрирует маршруты федерации
 * вовсе — и `GET /admin/federation` тоже (`index.ts`: «выключено => маршрутов нет»). Вкладка получала 404, показывала
 * всплывашку «Not Found» и «Состояние федерации недоступно», а её же экран «Федерация выключена, включается так-то»
 * не срабатывал никогда. У нас на проде федерация включена — поэтому не видели.
 *
 * 404 здесь значит ровно «федерации на этом сервере нет» (выключена или сервер старше неё) — это состояние, а не
 * ошибка. Остальные коды — настоящие сбои, их вызывающий показывает как раньше.
 */
export const FEDERATION_OFF: FederationOverview = {
  status: 'off',
  problem: null,
  paused: false,
  contacts: [],
  instance: null,
  links: [],
};

export function overviewAfterError(status: number | undefined): FederationOverview | null {
  return status === 404 ? FEDERATION_OFF : null;
}
