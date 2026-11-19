import { serverHost, type Instance } from './configRules';

export interface EntryTarget {
  id: string;
  host: string;
}

/** Своих гостей можно открыть из текущей семьи. Другой дом сам является отдельным входом. */
export function savedEntryTargets(registry: readonly Instance[], activeId: string | null): EntryTarget[] {
  const active = registry.find((instance) => instance.id === activeId);
  const homeId = active?.guestOf ?? active?.id;
  const hasFamily = !!active?.token && registry.some((instance) => instance.id === homeId && !instance.guestOf);
  return registry
    .filter((instance) =>
      instance.id !== activeId && instance.apiUrl && instance.token &&
      (!instance.guestOf || (hasFamily && instance.guestOf === homeId)),
    )
    .map((instance) => ({ id: instance.id, host: serverHost(instance.apiUrl) }));
}

/** Идентификатор проверки на клиенте. Продление JWT меняет подпись и срок, но сохраняет sub и gen. */
export function entryAccount(token: string | null): string | null {
  if (!token) return null;
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const { sub, gen } = JSON.parse(atob(payload)) as { sub?: unknown; gen?: unknown };
    if (typeof sub === 'string' && sub) return JSON.stringify([sub, gen ?? 0]);
  } catch {
    /* Старый или повреждённый токен всё равно проверит сервер. */
  }
  return token;
}

export function entryFailure(error: unknown): 'unreachable' | 'refused' {
  const status = (error as { status?: number } | null)?.status;
  return status === undefined || status >= 500 ? 'unreachable' : 'refused';
}

/** Предел включает чтение тела ответа и действует в WebView без AbortSignal.timeout. */
export async function withEntryDeadline<T>(
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  scope?: AbortSignal,
): Promise<T> {
  if (scope?.aborted) throw new Error('Проверка отменена');
  const controller = new AbortController();
  const abort = () => controller.abort();
  const stopped = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => {
      reject(new Error(scope?.aborted ? 'Проверка отменена' : 'Сервер не ответил'));
    }, { once: true });
  });
  const timer = setTimeout(abort, timeoutMs);
  scope?.addEventListener('abort', abort, { once: true });
  try {
    return await Promise.race([stopped, request(controller.signal)]);
  } finally {
    clearTimeout(timer);
    scope?.removeEventListener('abort', abort);
  }
}
