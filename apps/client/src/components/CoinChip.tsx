import { useEffect, useState } from 'react';
import coinDefaultIcon from '../assets/guscoin.svg';
import { useMockChip } from '../benchMock';
import { ensureEconomy } from '../economyClient';
import { useStore } from '../store';
import { CoinWalletModal } from './CoinWalletModal';

/**
 * Баланс в шапке сервера (#117).
 *
 * 🔴 Именно в шапке, а не в панели себя внизу: монеты **посерверные**, и шапка — ровно то место,
 * которое меняется при переключении сервера. В панели себя (имя, статус, микрофон, наушники,
 * шестерёнка) и теснее некуда, и смысл был бы другим — там всё глобальное.
 *
 * ⚠️ Ничего не рисуем, пока экономика на сервере выключена: пустой чип с нулём на сервере без
 * монет читается как поломка, а не как «тут этого нет».
 *
 * 🔴 Данные берём из стора и НЕ опрашиваем сервер сами: число двигает пуш `economy.wallet`.
 * Прежняя версия держала свою копию и опрашивала раз в минуту — вместе с оверлеем типа это давало
 * два разных баланса в одном окне после каждого типа.
 */
export function CoinChip({ serverId }: { serverId: string }) {
  const view = useStore((s) => s.economy[serverId]);
  const [walletOpen, setWalletOpen] = useState(false);
  // Макет из стенда эффектов (#120). Рисуется ЗДЕСЬ намеренно: только так он наследует все условия
  // видимости настоящего чипа — скрытый сайдбар на мобильной, другой сайдбар в личных сообщениях.
  const mock = useMockChip();

  useEffect(() => {
    ensureEconomy(serverId);
    // Возврат фокуса — страховка на случай пропущенного события шины: приложение могло простоять
    // свёрнутым с оборванным сокетом, и тогда число протухло бы до следующей выплаты.
    const refresh = () => ensureEconomy(serverId, true);
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [serverId]);

  if (!view?.enabled) {
    if (!mock) return null;
    return (
      <span className="eco-chip bench-chip" title="Макет стенда: настоящей экономики тут нет">
        <img src={coinDefaultIcon} alt="" />
        12 480
      </span>
    );
  }
  const { balance } = view.wallet;
  return (
    <>
      <button
        type="button"
        className="eco-chip"
        onClick={() => setWalletOpen(true)}
        aria-haspopup="dialog"
        aria-label={`Открыть кошелёк: ${balance} ${view.currencyName}`}
      >
        {/* Свой значок владельца — приоритетнее; без него утверждённый знак ГусКоина (#117). */}
        <img src={view.iconUrl || coinDefaultIcon} alt="" />
        {balance}
      </button>
      {walletOpen && (
        <CoinWalletModal
          serverId={serverId}
          view={view}
          onViewChange={(v) => useStore.getState().setEconomy(serverId, v)}
          onClose={() => setWalletOpen(false)}
        />
      )}
    </>
  );
}
