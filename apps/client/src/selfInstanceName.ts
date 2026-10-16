/**
 * Название СВОЕГО инстанса — как его видит собеседник с другого (Э7 ч.3, D; живая проверка 12.10: у получателя «через
 * «voice.example.org», не подтверждено» вместо названия). Локальное имя записи (`Instance.name`) — подпись значка в
 * переключателе, по умолчанию адрес; настоящее название задаёт хозяин инстанса (`GET /api/instance` → `name`), его же
 * видит сосед в визитке и в плашке «пишем через «…»» (с 13.10 — поле `fedName`: название из визитки федерации; `name`
 * с вкладки «Инстанс» соседям не уходит, на проде его нет вовсе). Спрашиваем после входа и при смене аккаунта / инстанса (один запрос
 * на адрес API); ответ — в поле стора `selfInstanceName` (читает `DmChatView`: `viaSelf`). Пока ответа нет или названия нет —
 * пусто, и показывается прежнее (`fedVia.self`: локальное имя / домен).
 */
import { api } from './api';
import { config } from './config';
import { useStore } from './store';

let askedFor = '';
let started = false;

function ask(): void {
  const key = config.apiUrl;
  if (askedFor === key) return;
  askedFor = key;
  useStore.setState({ selfInstanceName: '' });
  api
    .instance()
    .then((info) => {
      // Название для соседей (визитка, `fedName`) — его и видит собеседник; нет — название с вкладки «Инстанс».
      if (askedFor === key) useStore.setState({ selfInstanceName: info.fedName?.trim() || info.name?.trim() || '' });
    })
    .catch(() => {
      if (askedFor === key) askedFor = ''; // сеть подвела — спросим при следующей смене
    });
}

/** Подключить (`main.tsx`). */
export function startSelfInstanceName(): void {
  if (started) return;
  started = true;
  if (useStore.getState().user) ask();
  useStore.subscribe((s, prev) => {
    if (s.user !== prev.user && s.user) ask();
  });
}
