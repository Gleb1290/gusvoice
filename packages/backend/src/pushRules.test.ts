import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  contentPreview,
  endpointAllowed,
  redactPushPayload,
  forwardPreview,
  withSilent,
  pushThrottleSource,
  attachmentWords,
  stickerPushText,
  maskPushPayload,
  shouldDeferPush,
  deferredPushRead,
  connActive,
  pushBurstMode,
  PUSH_QUIET_MAX,
} from './pushRules.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { incomingCallPush, ringPushOver } from './callRules.js';

it('пачка пушей: четыре сочетания окон, пять тихих досылок и мутант quiet/drop', () => {
  assert.equal(PUSH_QUIET_MAX, 5);
  const check = (mode: typeof pushBurstMode) => {
    for (const [loud, quiet, expected] of [[false, false, 'loud'], [false, true, 'loud'], [true, false, 'quiet'], [true, true, 'drop']] as const) {
      assert.equal(mode(loud, quiet), expected, 'режим пачки соответствует занятому окну');
    }
  };
  check(pushBurstMode);
  const source = readFileSync(new URL('./pushRules.ts', import.meta.url), 'utf8');
  const body = source.match(/export function pushBurstMode\([^]*?\n\}/)?.[0]; assert.ok(body);
  const anchor = "quietTaken ? 'drop' : 'quiet'"; assert.equal(body.split(anchor).length, 2);
  const load = (code: string) => { const module = { exports: {} as { pushBurstMode: typeof pushBurstMode } };
    runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { module, exports: module.exports }); return module.exports.pushBurstMode; };
  check(load(body)); const changed = body.replace(anchor, "quietTaken ? 'quiet' : 'drop'"); assert.notEqual(changed, body);
  assert.throws(() => check(load(changed)), (error: unknown) => error instanceof assert.AssertionError && error.message.includes('режим пачки'));
});

it('пуш снимает формат, закрывает спойлер и называет стикер даже без emoji', () => {
  // Превью уведомления не должно раскрывать скрытое или показывать технические маркеры разметки.
  assert.equal(contentPreview('**жирный** __курсив__', 0), 'жирный курсив');
  assert.equal(contentPreview('||секрет||', 0), '▚'.repeat(6));
  assert.equal(stickerPushText('🪶'), '🪶 Стикер');
  for (const emoji of [null, undefined, '']) assert.equal(stickerPushText(emoji), 'Стикер');
});

describe('тихий push ЛС', () => {
  it('добавляет silent только тихой нагрузке, оставляя обычную неизменной', () => {
    // Обычный payload сохраняет прежние байты по форме, тихий доставляется с явным признаком.
    const ordinary = { type: 'dm' as const, body: 'текст', dmId: 'c' };
    assert.equal(withSilent(ordinary, false), ordinary);
    assert.deepEqual(withSilent(ordinary, true), { ...ordinary, silent: true });
  });

  it('отделяет тихое окно антиспама от обычного', () => {
    // Тихий push не должен съедать 20-секундное окно обычного сообщения.
    assert.equal(pushThrottleSource('alice', false), 'alice');
    assert.equal(pushThrottleSource('alice', true), 'alice:silent');
  });
});

it('пуш пересылки описывает пачку, текст, вложение и пустое сообщение', () => {
  // Ловит неверный сводный текст пачки и пустое тело одиночной пересылки.
  assert.equal(forwardPreview(3, { content: 'x', attachments: 1 }), '↪ Пересланные сообщения: 3');
  assert.equal(forwardPreview(1, { content: ' x ', attachments: 0 }), '↪ x');
  assert.equal(forwardPreview(1, { content: '', attachments: 1 }), '↪ 📎 Вложение');
  assert.equal(forwardPreview(1, { content: '', attachments: 0 }), '↪ Пересланное сообщение');
});

describe('SSRF-гард push endpoint', () => {
  const base = 'https://ntfy.example.test';

  it('пустая база запрещает любой endpoint', () => {
    // Ловит превращение выключенной push-конфигурации в разрешение произвольной сети.
    assert.equal(endpointAllowed(`${base}/topic`, ''), false);
  });

  it('HTTPS endpoint того же origin с любым путём принимается', () => {
    // Ловит отказ легитимных персональных ntfy topic внутри своего шлюза.
    assert.equal(endpointAllowed(`${base}/user/device-topic`, base), true);
  });

  it('HTTP отклоняется даже на том же host', () => {
    // Ловит утечку bearer-токена через незашифрованный push-запрос.
    assert.equal(endpointAllowed('http://ntfy.example.test/topic', base), false);
  });

  it('дописанный домен и user-info не маскируются под свой origin', () => {
    // Ловит две классические startsWith-ловушки, отправляющие POST на хост атакующего.
    assert.equal(endpointAllowed('https://ntfy.example.test.evil.test/topic', base), false);
    assert.equal(endpointAllowed('https://ntfy.example.test@evil.test/topic', base), false);
  });

  it('другой порт считается другим origin', () => {
    // Ловит доступ к соседнему сервису на том же hostname через подмену порта.
    assert.equal(endpointAllowed('https://ntfy.example.test:8443/topic', base), false);
  });

  it('невалидные endpoint и base возвращают false без исключения', () => {
    // Ловит падение отправки сообщения от повреждённой регистрации устройства или конфигурации.
    assert.equal(endpointAllowed('not a url', base), false);
    assert.equal(endpointAllowed(`${base}/topic`, 'not a url'), false);
  });
});

describe('текст push-превью', () => {
  it('непустой текст обрезается по краям', () => {
    // Ловит push из одних пробелов вокруг нормального сообщения.
    assert.equal(contentPreview('  привет  ', 0), 'привет');
  });

  it('ровно 140 символов проходят без многоточия', () => {
    // Ловит ошибку на единицу, преждевременно режущую допустимую границу.
    assert.equal(contentPreview('a'.repeat(140), 0), 'a'.repeat(140));
  });

  it('141 символ сокращается до итоговых 140 с многоточием', () => {
    // Ловит превью длиннее лимита либо потерю маркера обрезки.
    const result = contentPreview('a'.repeat(141), 0);
    assert.equal(result, `${'a'.repeat(139)}…`);
    assert.equal(result.length, 140);
  });

  it('пустой текст различает сообщение с вложением и полностью пустое', () => {
    // Ловит невидимый push о файле и ложную скрепку у пустого сообщения.
    assert.equal(contentPreview('   ', 1), '📎 Вложение');
    assert.equal(contentPreview('', 0), '');
  });
  it('слова для вложений различают типы, смеси, мусор и не раскрывают длительность или имя файла', () => {
    // Превью повторяет согласованную форму списка: без длительности и без префикса «Файл:» перед именем.
    assert.equal(attachmentWords([]), '');
    assert.equal(attachmentWords([null, 7, 'bad']), '📎 Вложение');
    assert.equal(contentPreview('', 2), '📎 Вложение');
    assert.equal(contentPreview('', [{ contentType: 'image/png' }, { contentType: 'image/jpeg' }]), '2 фото');
    assert.equal(contentPreview('', [{ contentType: 'video/mp4' }, { contentType: 'image/png' }]), '2 файла');
    assert.equal(contentPreview('', [{ contentType: 'audio/ogg', waveform: [1], durationMs: 42_000 }]), 'Голосовое сообщение');
    assert.equal(contentPreview('', [{ name: 'report.pdf' }]), 'report.pdf');
    assert.equal(forwardPreview(1, { content: '', attachments: [{ contentType: 'video/mp4', durationMs: 42_000 }] }), '↪ Видео', 'пересланное видео тоже не раскрывает длительность');
  });
});

describe('пуш без ключей шифрования', () => {
  it('личное сообщение и упоминание теряют текст, но сохраняют адрес перехода', () => {
    // Ловит как утечку текста через открытый ntfy topic, так и поломанный тап по обезличенному пушу.
    const dm = {
      type: 'dm' as const,
      title: 'Иван',
      body: 'секрет',
      dmId: 'dm-1',
      instanceId: 'peer-1',
    };
    const mention = {
      type: 'mention' as const,
      title: 'Сервер',
      body: '@me секрет',
      channelId: 'ch-1',
      serverId: 'srv-1',
      instanceId: 'peer-2',
    };
    assert.deepEqual(redactPushPayload(dm), { ...dm, body: 'Новое личное сообщение' });
    assert.deepEqual(redactPushPayload(mention), { ...mention, body: 'Вас упомянули' });
    const call = incomingCallPush(
      { id: 'call-1', conversationId: 'dm-call', callerId: 'a', video: false, createdAt: '2026-10-08T12:00:00Z' },
      { displayName: 'Аня', username: 'anya', avatarUrl: null },
    );
    assert.equal(redactPushPayload(call), call, 'пуш звонка не содержит текста переписки и сохраняет приглашение');
  });
});

describe('видимость уведомления по выбору получателя', () => {
  const dm = {
    type: 'dm',
    title: 'Галя',
    body: 'привет',
    author: 'Галя',
    authorId: 'galya',
    avatar: 'https://cdn.example/avatar.png',
    group: 'Команда',
    dmId: 'dm-1',
  };

  it('«всё» не меняет payload, а «имя» оставляет отправителя и скрывает текст', () => {
    // «Показывать имя» не должно оставлять текст сообщения рядом с настоящим именем автора.
    assert.equal(maskPushPayload(dm, 'all'), dm);
    assert.deepEqual(maskPushPayload(dm, 'name'), { ...dm, body: 'Новое сообщение' });
  });

  it('«ничего» скрывает и имя, и текст, но сохраняет маршрут; для звонка оставляет смысловой текст', () => {
    // Нельзя раскрыть имя звонящего, но нельзя и превратить звонок в пустое обычное уведомление.
    const hidden = maskPushPayload(dm, 'nothing');
    assert.equal(hidden.title, 'GusVoice');
    assert.equal(hidden.body, 'Новое сообщение');
    for (const key of ['author', 'authorId', 'avatar', 'group']) assert.equal(Object.hasOwn(hidden, key), false);
    assert.equal(hidden.dmId, dm.dmId);

    const call = { type: 'call', title: 'Галя', body: 'Входящий звонок', author: 'Галя', authorId: 'galya' };
    assert.deepEqual(maskPushPayload(call, 'name'), call);
    assert.deepEqual(maskPushPayload(call, 'nothing'), { type: 'call', title: 'GusVoice', body: 'Входящий звонок' });
  });
});

describe('отложенный push ждёт только пока прочтение можно проверить', () => {
  it('откладывает активному получателю только личное сообщение с беседой и числовым ключом', () => {
    // Без ключа нельзя отличить прочитанное от непрочитанного, а канал и звонок не относятся к defer-очереди ЛС.
    assert.equal(shouldDeferPush({ type: 'dm', dmId: 'dm', key: 4 }, true), true);
    assert.equal(shouldDeferPush({ type: 'dm', dmId: 'dm', key: 4 }, false), false);
    assert.equal(shouldDeferPush({ type: 'dm', dmId: 'dm' }, true), false);
    assert.equal(shouldDeferPush({ type: 'dm', key: 4 }, true), false);
    assert.equal(shouldDeferPush({ type: 'mention', dmId: 'dm', key: 4 }, true), false);
    assert.equal(shouldDeferPush({ type: 'call', dmId: 'dm', key: 4 }, true), false);
  });

  it('считает ровный ключ прочитанным, но соседний больший ключ — ещё нет', () => {
    // Равенство last_read_key — последняя прочитанная строка, поэтому порог должен быть включительным.
    assert.equal(deferredPushRead(10, 9), true);
    assert.equal(deferredPushRead(10, 10), true);
    assert.equal(deferredPushRead(10, 11), false);
    assert.equal(deferredPushRead(null, 10), false);
  });

  it('активность живёт до 30 секунд, но ровно на границе уже истекла', () => {
    // Строгая граница совпадает с Telegram idle timeout; лишняя миллисекунда задержала бы пуш на вечность по циклу.
    assert.equal(connActive(70_001, 100_000), true);
    assert.equal(connActive(70_000, 100_000), false);
    assert.equal(connActive(null, 100_000), false);
  });
});

describe('пуш входящего звонка', () => {
  const call = { id: 'call-1', conversationId: 'dm-1', callerId: 'a', video: true, createdAt: '2026-10-08T10:00:00.000Z' };

  it('сохраняет признак видео, берёт username без displayName и только http(s)-аватар', () => {
    // При пустом имени звонок всё равно должен объяснять, кто звонит, а небезопасный URL не уходит на телефон.
    const push = incomingCallPush(call, { displayName: '  ', username: 'alpha', avatarUrl: 'javascript:alert(1)' });
    assert.equal(push.title, 'alpha');
    assert.equal(push.author, 'alpha');
    assert.equal(push.body, 'Входящий видеозвонок');
    assert.equal(push.video, true);
    assert.equal(Object.hasOwn(push, 'avatar'), false);
    assert.equal(push.ts, Date.parse(call.createdAt));
  });

  it('не помечает голосовой звонок видео и снимает пуш только при выходе из ringing', () => {
    // Активный разговор не снимается как ringing push: для него уже иной видимый экран/запись.
    const voice = incomingCallPush({ ...call, video: false }, { displayName: 'Аня', username: 'anya', avatarUrl: 'https://cdn.example/a.png' });
    assert.equal(voice.body, 'Входящий звонок');
    assert.equal(Object.hasOwn(voice, 'video'), false);
    assert.equal(voice.avatar, 'https://cdn.example/a.png');
    assert.equal(ringPushOver({ phase: 'ringing' }, { phase: 'active' }), true);
    assert.equal(ringPushOver({ phase: 'ringing' }, { phase: 'ended' }), true);
    assert.equal(ringPushOver({ phase: 'active' }, { phase: 'ended' }), false);
  });
});
