/**
 * Что делать, когда состав устройств изменился (#131) — ЧИСТО, без DOM и без React.
 *
 * 🔴 Задачи здесь ДВЕ, и путать их нельзя:
 *   1. выбранное устройство ИСЧЕЗЛО — надо перейти на системное, иначе человек остаётся без
 *      микрофона или без звука и обычно даже не понимает, почему;
 *   2. устройство ПОЯВИЛОСЬ — самовольно переключаться нельзя, это чужой выбор.
 * Единственное исключение во втором пункте: вернулось ровно то, что человек выбирал сам и что мы у
 * него отобрали в пункте 1. Это не навязывание, а возврат его же решения.
 */

/** Виды устройств ровно в тех именах, которыми их зовёт LiveKit и `enumerateDevices`. */
export type DeviceKind = 'audioinput' | 'audiooutput' | 'videoinput';

/** Выбор человека: пустая строка = «системное по умолчанию». */
export interface DeviceChoice {
  inputDeviceId: string;
  outputDeviceId: string;
  cameraDeviceId: string;
}

export const KIND_OF: Record<keyof DeviceChoice, DeviceKind> = {
  inputDeviceId: 'audioinput',
  outputDeviceId: 'audiooutput',
  cameraDeviceId: 'videoinput',
};

/** Человеческое имя вида — для сообщения, которое увидит человек. */
export const KIND_NAME: Record<DeviceKind, string> = {
  audioinput: 'Микрофон',
  audiooutput: 'Вывод звука',
  videoinput: 'Камера',
};

/**
 * Идентификаторы, которые в браузере есть ВСЕГДА и не могут «пропасть»: это не конкретные железки,
 * а указатели «то, что система считает основным». Считать их потерянными — значит сбрасывать выбор
 * на ровном месте при каждом втыкании чего угодно.
 */
const VIRTUAL_IDS = new Set(['', 'default', 'communications']);

export interface DeviceInfoLike {
  kind: string;
  deviceId: string;
  label?: string;
}

/**
 * Можно ли вообще судить по этому списку о наличии устройств данного вида.
 *
 * 🔴 **Замерено в живом браузере, а не предположено.** Пока доступ к микрофону не выдан,
 * `enumerateDevices()` возвращает НЕ пустоту, а по одной заглушке на вид — с пустыми `deviceId` и
 * `label`. Наивная проверка «моего id в списке нет» на таком ответе объявляет пропавшим ВСЁ и
 * стирает человеку выбор устройств при каждой загрузке страницы, пока он не пустит к микрофону.
 * Признак настоящего списка ровно один: хотя бы у одной записи вида есть непустой `deviceId`.
 */
function listTellsAbout(devices: DeviceInfoLike[], kind: DeviceKind): boolean {
  return devices.some((d) => d.kind === kind && d.deviceId !== '');
}

/**
 * Какие из выбранных устройств пропали из системы.
 *
 * ⚠️ Молчим не только на заглушках, но и на пустом списке: `enumerateDevices` отдаёт пустоту и на
 * короткой перестройке звукового стека. Сбросить по такому поводу — отобрать настройки за икоту.
 */
export function lostDevices(
  choice: DeviceChoice,
  devices: DeviceInfoLike[],
): { field: keyof DeviceChoice; kind: DeviceKind; id: string }[] {
  const out: { field: keyof DeviceChoice; kind: DeviceKind; id: string }[] = [];
  for (const field of Object.keys(KIND_OF) as (keyof DeviceChoice)[]) {
    const id = choice[field];
    if (VIRTUAL_IDS.has(id)) continue;
    const kind = KIND_OF[field];
    if (!listTellsAbout(devices, kind)) continue;
    if (!devices.some((d) => d.kind === kind && d.deviceId === id)) out.push({ field, kind, id });
  }
  return out;
}

/**
 * Какие из ОТОБРАННЫХ нами устройств вернулись и могут быть возвращены человеку.
 *
 * ⚠️ Возвращаем только то, что забрали сами и только если человек с тех пор не выбрал что-то
 * другое руками: иначе мы перебьём его свежее решение своим воспоминанием.
 */
export function restorableDevices(
  choice: DeviceChoice,
  devices: DeviceInfoLike[],
  remembered: Partial<Record<keyof DeviceChoice, string>>,
): { field: keyof DeviceChoice; kind: DeviceKind; id: string }[] {
  const out: { field: keyof DeviceChoice; kind: DeviceKind; id: string }[] = [];
  for (const field of Object.keys(KIND_OF) as (keyof DeviceChoice)[]) {
    const id = remembered[field];
    if (!id) continue;
    if (choice[field] !== '') continue; // человек уже выбрал сам — не трогаем
    const kind = KIND_OF[field];
    if (devices.some((d) => d.kind === kind && d.deviceId === id)) out.push({ field, kind, id });
  }
  return out;
}

/**
 * Как назвать устройство человеку. Метки пусты, пока не выдан доступ к медиа, — тогда честнее
 * сказать «системное», чем показать пустые кавычки.
 */
export function deviceLabel(devices: DeviceInfoLike[], kind: DeviceKind, id: string): string {
  const found = devices.find((d) => d.kind === kind && d.deviceId === id);
  return found?.label?.trim() || 'системное по умолчанию';
}
