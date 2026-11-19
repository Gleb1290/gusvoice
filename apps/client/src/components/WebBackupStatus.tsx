import { useEffect, useState } from 'react';
import { isTauri } from '../hotkeys';

const messages = {
  saving: 'Веб-интерфейс сохраняется…',
  ready: 'Веб-интерфейс готов к повторному открытию.',
  failed: 'Не удалось подтвердить сохранение веб-интерфейса.',
};

function askWorker(worker: ServiceWorker): Promise<boolean> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    const timeout = window.setTimeout(() => finish(false), 1000);

    function finish(ready: boolean) {
      window.clearTimeout(timeout);
      port1.close();
      resolve(ready);
    }

    port1.onmessage = (event) => finish(event.data === true);
    try {
      worker.postMessage('gusvoice:offline-shell-status', [port2]);
    } catch {
      port2.close();
      finish(false);
    }
  });
}

async function hasOfflineShell(): Promise<boolean> {
  const origin = window.location.origin;
  const registration = await navigator.serviceWorker.getRegistration(origin + '/');
  const worker = registration?.active;
  if (registration?.scope !== origin + '/' || worker?.scriptURL !== origin + '/sw.js' ||
      worker.state !== 'activated') return false;

  return await askWorker(worker) && registration.active === worker && worker.state === 'activated';
}

export function WebBackupStatus() {
  const native = isTauri();
  const supported = !native && import.meta.env.PROD && window.isSecureContext &&
    'serviceWorker' in navigator && 'MessageChannel' in window;
  const [status, setStatus] = useState<keyof typeof messages>(supported ? 'saving' : 'failed');

  useEffect(() => {
    if (!supported) return;

    let stopped = false;
    let retry: number | undefined;
    const deadline = window.setTimeout(() => finish('failed'), 15_000);

    function stop() {
      stopped = true;
      window.clearTimeout(deadline);
      window.clearTimeout(retry);
    }

    function finish(result: 'ready' | 'failed') {
      if (stopped) return;
      stop();
      setStatus(result);
    }

    async function check() {
      try {
        if (await hasOfflineShell()) {
          finish('ready');
          return;
        }
      } catch {
        finish('failed');
        return;
      }
      if (!stopped) retry = window.setTimeout(() => void check(), 500);
    }

    void check();
    return stop;
  }, [supported]);

  if (native) return null;
  return <span role="status">{messages[status]}</span>;
}
