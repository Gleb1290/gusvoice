import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('стыки нового пути личных бесед', () => {
  it('conv1 без conv2 оставляет старый путь и не объявляет caps бесед', () => {
    // Ловит потерю живой доставки ЛС на сервере 0.8.17, где есть conv1, но нет новой рассылки.
    for (const path of ['./App.tsx', './components/UserSettingsModal.tsx']) {
      const s = source(path);
      assert.match(s, /features\?\.includes\(CAP_CONV1\)\s*&&\s*!!features\?\.includes\(FEATURE_CONV2\)/, path);
    }
    const app = source('./App.tsx');
    assert.match(app, /const active = [^;]+&& convClientSwitch\(\);\s*st\.setConvActive\(active\)/);
    assert.match(source('./sockets.ts'), /convActive \? \[CAP_CONV1\] : undefined/);
  });
  it('черновик не пересоздаёт стор при равном значении и удаляется после очистки поля', () => {
    // Ловит дорогие перерисовки ленты на каждой букве и возврат очищенного черновика.
    const s = source('./store.ts');
    assert.match(s, /const drafts = updateDrafts\(s\.drafts, convId, text, replyToId\)/);
    assert.match(s, /return drafts === s\.drafts \? s : \{ drafts \}/);
  });

  it('лента начинает с черновика, сохраняет состояние до правки и при размонтировании', () => {
    // Ловит потерю текста при входе в голос и запись редактируемого сообщения вместо черновика.
    const s = source('./components/MessagePane.tsx');
    assert.match(s, /useState\(draft\?\.text \?\? ''\)/);
    assert.match(s, /draftSaver\.change\(\s*draftToSave\(/);
    assert.match(s, /beforeEdit: before && \{ text: before\.text, replyToId: before\.replyingTo\?\.id \?\? null \}/);
    assert.match(s, /if \(!onDraftRef\.current\) return/);
    assert.match(s, /useEffect\(\(\) => \(\) => draftSaver\.flush\(\), \[draftSaver\]\)/);
  });

  it('вид ЛС берёт черновик однократно, без подписки на каждую букву', () => {
    // Ловит пересоздание всей ленты при вводе текста черновика.
    const s = source('./components/DmChatView.tsx');
    assert.match(s, /useState\(\(\) => \(convActive \? useStore\.getState\(\)\.drafts\[dm\.id\]/);
    assert.doesNotMatch(s, /useStore\(\(s\) => s\.drafts/);
  });

  it('очередь у ленты отправляет через enqueue, каналы сохраняют прежний onSend с тем же ключом', () => {
    // Ловит двойную отправку в режиме бесед и потерю идемпотентного ключа на старом пути.
    const s = source('./components/MessagePane.tsx');
    assert.match(s, /if \(outbox\) \{[\s\S]{0,160}outbox\.enqueue\(/);
    assert.match(s, /onSend\(item\.content, item\.files, item\.replyToId, item\.key\)/);
    assert.match(s, /outbox \? outbox\.items : outgoing\.filter/);
    assert.match(s, /clientId === o\.key/);
  });

  it('выход дожидается стирания кеша до перезагрузки интерфейса', () => {
    // Ловит возвращение старых личных сообщений после мгновенной перезагрузки.
    for (const path of ['./components/MobileProfile.tsx', './components/UserSettingsModal.tsx']) {
      const s = source(path);
      assert.ok(/await logout\(\);\s*(?:onClose\(\);\s*)?location\.reload\(\)/.test(s), path);
      assert.ok(!/(?<!await )logout\(\);\s*(?:onClose\(\);\s*)?location\.reload\(\)/.test(s), path);
    }
  });

  it('поколение сброса отменяет ответы старой догонки и старой отправки', () => {
    // Ловит примешивание данных прежнего аккаунта после переключения инстанса.
    const s = source('./convStore.ts');
    assert.match(s, /convReset: \(\) => \{\s*gen\+\+/);
    assert.match(s, /if \(myGen !== gen\) return/);
    assert.match(s, /for \(const t of pumpTimers\.values\(\)\) clearTimeout\(t\)/);
    assert.match(s, /sending\.clear\(\)/);
  });

  it('шлюз объявляет новую возможность только клиенту с включёнными беседами', () => {
    // Ловит двойную доставку нового и старого протокола одной вкладке.
    const s = source('./sockets.ts');
    assert.match(s, /convActive \? \[CAP_CONV1\] : undefined/);
    assert.match(s, /if \(store\.convActive\) void store\.convOnReady\(\)/);
  });

  it('старый токен не уходит в чужой API при нескольких инстансах', () => {
    // Ловит утечку bearer-токена через запасной ключ старой установки.
    const s = source('./api.ts');
    assert.match(s, /if \(active\?\.token\) return active\.token/);
    assert.match(s, /instances\(\)\.length <= 1 \? localStorage\.getItem\('gv_token'\) : null/);
  });

  it('по умолчанию беседы включены, а локальный 0 откатывает только это устройство', () => {
    // Ловит случайный возврат всех веб-клиентов на старые ЛС после релиза.
    const s = source('./convStore.ts');
    assert.match(s, /CONV_CLIENT_DEFAULT = true/);
    assert.match(s, /if \(v === '1'\) return true;\s*if \(v === '0'\) return false/);
    assert.match(s, /return CONV_CLIENT_DEFAULT/);
  });

  it('при старте метка своего ключа снимается после уборки, но до чтения и записи кеша', () => {
    // Ловит удаление новых черновиков следующей загрузкой либо подъём данных до отложенной очистки.
    const s = source('./App.tsx');
    const body = s.slice(s.indexOf('async function decideConvMode'), s.indexOf('function bounceStrandedGuestHome'));
    const at = (needle: string) => body.indexOf(needle);
    assert.ok(at('await finishConvCacheWipes()') < at('clearConvCacheWipe(key)'));
    assert.ok(at('clearConvCacheWipe(key)') < at('await readConvCache(key)'));
    assert.ok(at('await readConvCache(key)') < at('startConvCacheWriter()'));
  });

  it('приглашение оставляет восстановление места, а забранный адресный пуш его подавляет', () => {
    // Ловит открытие старого канала поверх намеренного перехода и зависание окна приглашения без места.
    const push = source('./nativeUnifiedPush.ts');
    const app = source('./App.tsx');
    assert.match(push, /return !link\.startsWith\('invite:'\)/);
    assert.match(app, /const tookLink = consumeDeepLink\(\)/);
    assert.match(app, /if \(!tookLink && !st\.currentServerId && !st\.currentDmId\)/);
  });

  it('чужое прочтение отмечает посещение только при нуле, росте ключа и вне открытой ленты', () => {
    // Ловит перенос черты «новые» у читающего или её возврат после другого устройства.
    const s = source('./convStore.ts');
    const body = s.slice(s.indexOf('function takeSummary'), s.indexOf('function takeMessage'));
    assert.match(body, /applied\.unread === 0/);
    assert.match(body, /applied\.lastReadKey > before\.lastReadKey/);
    assert.match(body, /onScreenId\(get\(\)\) !== s\.id/);
    assert.match(body, /markChannelSeen\(s\.id/);
  });

  it('профиль обновляет сводки бесед, а выход метит всю семью до удаления кешей', () => {
    // Ловит старое имя в списке ЛС и оставшуюся гостевую переписку после выхода из дома.
    const s = source('./store.ts');
    assert.match(s, /const conv = patchPeer\(s\.conv, userId, displayName, avatarUrl\)/);
    const body = s.slice(s.indexOf('logout: () => {'), s.indexOf('loadPushMutes: async'));
    assert.match(body, /i\.id !== homeId && i\.guestOf !== homeId/);
    assert.ok(body.indexOf('for (const k of cacheKeys) markConvCacheWipe(k)') < body.indexOf('deleteConvCache(k)'));
    assert.match(body, /if \(ok\) clearConvCacheWipe\(k\)/);
  });
});
