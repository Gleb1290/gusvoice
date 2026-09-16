import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ALL_PERMISSIONS,
  basePermissions,
  canPublishCamera,
  canPublishScreen,
  has,
  isAdmin,
  normalizeLegacyPerms,
  Permission,
  permsFromString,
  permsToString,
  resolveChannelPermissions,
  voicePublishBits,
  VOICE_PUBLISH_MASK,
} from './permissions.js';

/**
 * Тесты разрешений. Здесь ошибка стоит дороже всего в проекте: перепутанный порядок наложения
 * прав — это не «косметика поехала», а человек читает канал, куда его не пускали, или наоборот
 * теряет доступ. Проверяем ровно те свойства, на которые опирается остальной код.
 */
const { SEND_MESSAGES, VIEW_CHANNEL, MANAGE_MESSAGES, ADMINISTRATOR, SPEAK } = Permission;

describe('базовые проверки', () => {
  it('has требует ВСЕ биты запрошенного права', () => {
    assert.equal(has(SEND_MESSAGES | VIEW_CHANNEL, SEND_MESSAGES), true);
    assert.equal(has(SEND_MESSAGES, SEND_MESSAGES | VIEW_CHANNEL), false);
  });

  it('администратор проходит любую проверку', () => {
    assert.equal(has(ADMINISTRATOR, MANAGE_MESSAGES), true);
    assert.equal(isAdmin(ADMINISTRATOR | SPEAK), true);
    assert.equal(isAdmin(SPEAK), false);
  });

  it('нулевые права не дают ничего', () => {
    assert.equal(has(0n, VIEW_CHANNEL), false);
  });

  it('роли складываются объединением', () => {
    const p = basePermissions([{ permissions: VIEW_CHANNEL }, { permissions: SEND_MESSAGES }]);
    assert.equal(p, VIEW_CHANNEL | SEND_MESSAGES);
  });

  it('роль с администратором раскрывается во все права', () => {
    assert.equal(basePermissions([{ permissions: SPEAK }, { permissions: ADMINISTRATOR }]), ALL_PERMISSIONS);
  });

  it('без ролей прав нет', () => {
    assert.equal(basePermissions([]), 0n);
  });

  it('камера разрешается новым VIDEO и старым STREAM, но не посторонним правом', () => {
    assert.equal(canPublishCamera(Permission.VIDEO), true);
    assert.equal(canPublishCamera(Permission.STREAM), true);
    assert.equal(canPublishCamera(Permission.SPEAK), false);
  });

  it('демонстрация разрешается новым SHARE_SCREEN и старым STREAM, но не посторонним правом', () => {
    assert.equal(canPublishScreen(Permission.SHARE_SCREEN), true);
    assert.equal(canPublishScreen(Permission.STREAM), true);
    assert.equal(canPublishScreen(Permission.SPEAK), false);
  });

  it('ADMINISTRATOR получает оба права публикации через обычную проверку', () => {
    // Ловит отдельную проверку прямых битов, которая сломала бы камеру и показ у администратора.
    assert.equal(canPublishCamera(Permission.ADMINISTRATOR), true);
    assert.equal(canPublishScreen(Permission.ADMINISTRATOR), true);
  });
});

describe('наложение в канале', () => {
  it('запрет @everyone снимает право', () => {
    const p = resolveChannelPermissions(VIEW_CHANNEL | SEND_MESSAGES, {
      everyone: { allow: 0n, deny: SEND_MESSAGES },
    });
    assert.equal(has(p, SEND_MESSAGES), false);
    assert.equal(has(p, VIEW_CHANNEL), true);
  });

  it('разрешение роли перебивает запрет @everyone', () => {
    // Ровно тот порядок, ради которого всё и написано: закрыли канал для всех,
    // открыли одной роли.
    const p = resolveChannelPermissions(VIEW_CHANNEL, {
      everyone: { allow: 0n, deny: SEND_MESSAGES },
      roleOverwrites: [{ allow: SEND_MESSAGES, deny: 0n }],
    });
    assert.equal(has(p, SEND_MESSAGES), true);
  });

  it('внутри ролей запрет одной НЕ перебивает разрешение другой', () => {
    // Все роли складываются сначала (allow|allow, deny|deny), и только потом deny применяется
    // перед allow — то есть разрешение выигрывает. Это поведение Discord.
    const p = resolveChannelPermissions(0n, {
      roleOverwrites: [
        { allow: 0n, deny: SEND_MESSAGES },
        { allow: SEND_MESSAGES, deny: 0n },
      ],
    });
    assert.equal(has(p, SEND_MESSAGES), true);
  });

  it('персональный запрет перебивает разрешение роли', () => {
    const p = resolveChannelPermissions(0n, {
      roleOverwrites: [{ allow: SEND_MESSAGES, deny: 0n }],
      memberOverwrite: { allow: 0n, deny: SEND_MESSAGES },
    });
    assert.equal(has(p, SEND_MESSAGES), false);
  });

  it('персональное разрешение перебивает запрет @everyone', () => {
    const p = resolveChannelPermissions(0n, {
      everyone: { allow: 0n, deny: VIEW_CHANNEL },
      memberOverwrite: { allow: VIEW_CHANNEL, deny: 0n },
    });
    assert.equal(has(p, VIEW_CHANNEL), true);
  });

  it('администратора не трогает НИ ОДИН запрет', () => {
    const p = resolveChannelPermissions(ADMINISTRATOR, {
      everyone: { allow: 0n, deny: ALL_PERMISSIONS },
      roleOverwrites: [{ allow: 0n, deny: ALL_PERMISSIONS }],
      memberOverwrite: { allow: 0n, deny: ALL_PERMISSIONS },
    });
    assert.equal(p, ALL_PERMISSIONS);
  });

  it('без наложений база не меняется', () => {
    const base = VIEW_CHANNEL | SPEAK;
    assert.equal(resolveChannelPermissions(base, {}), base);
  });
});

describe('сериализация', () => {
  it('переживает круг через строку', () => {
    const p = VIEW_CHANNEL | SEND_MESSAGES | MANAGE_MESSAGES;
    assert.equal(permsFromString(permsToString(p)), p);
  });
  it('пустое значение читается как отсутствие прав', () => {
    assert.equal(permsFromString(null), 0n);
    assert.equal(permsFromString(undefined), 0n);
    assert.equal(permsFromString(''), 0n);
  });
  it('большие битфилды не теряют точность', () => {
    // Права — bigint именно поэтому: за 2^53 обычное число начинает врать.
    assert.equal(permsFromString(permsToString(ALL_PERMISSIONS)), ALL_PERMISSIONS);
  });
});

describe('нормализация старого права на стрим', () => {
  it('STREAM заменяется современной парой, а остальные права сохраняются', () => {
    // Ловит потерю несвязанных разрешений при миграции старой роли в редакторе.
    const source = Permission.STREAM | Permission.SPEAK | Permission.MANAGE_MESSAGES;
    const expected = Permission.VIDEO | Permission.SHARE_SCREEN | Permission.SPEAK | Permission.MANAGE_MESSAGES;
    assert.equal(normalizeLegacyPerms(source), expected);
  });

  it('роль без STREAM остаётся побитово неизменной', () => {
    // Ловит случай, когда нормализация самовольно выдаёт камеру или демонстрацию новым ролям.
    const source = Permission.SPEAK | Permission.MANAGE_MESSAGES;
    assert.equal(normalizeLegacyPerms(source), source);
  });

  it('современная пара VIDEO и SHARE_SCREEN не меняется', () => {
    // Ловит ошибку повторной миграции уже обновлённой роли.
    const source = Permission.VIDEO | Permission.SHARE_SCREEN | Permission.CONNECT;
    assert.equal(normalizeLegacyPerms(source), source);
  });

  it('ADMINISTRATOR сам по себе не превращается в права публикации', () => {
    // Ловит ошибочную опору на has(), где администратор короткозамкнуто «имеет» любой бит.
    assert.equal(normalizeLegacyPerms(Permission.ADMINISTRATOR), Permission.ADMINISTRATOR);
    assert.equal(
      normalizeLegacyPerms(Permission.ADMINISTRATOR | Permission.STREAM),
      Permission.ADMINISTRATOR | Permission.VIDEO | Permission.SHARE_SCREEN,
    );
  });

  it('частичная миграция STREAM дополняется недостающим правом и остаётся идемпотентной', () => {
    // Ловит сохранение устаревшего зонтика или потерю уже включённой камеры при повторном открытии роли.
    const source = Permission.STREAM | Permission.VIDEO | Permission.MANAGE_MESSAGES;
    const normalized = Permission.VIDEO | Permission.SHARE_SCREEN | Permission.MANAGE_MESSAGES;
    assert.equal(normalizeLegacyPerms(source), normalized);
    assert.equal(normalizeLegacyPerms(normalized), normalized);
  });
});

describe('права, влияющие на голосовой токен', () => {
  it('пустое и отсутствующее значение дают пустую маску', () => {
    // Ловит падение на bootstrap без строки permissions и ложный перевыпуск токена.
    assert.equal(voicePublishBits(''), 0n);
    assert.equal(voicePublishBits(null), 0n);
    assert.equal(voicePublishBits(undefined), 0n);
  });

  it('все права публикации попадают в маску без потерь', () => {
    // Ловит забытый бит, из-за которого выдача голосового права не обновляет LiveKit-токен.
    assert.equal(voicePublishBits(VOICE_PUBLISH_MASK.toString()), VOICE_PUBLISH_MASK);
  });

  it('маска содержит ровно шесть прав, влияющих на голосовой токен', () => {
    // Ловит самореферентный тест: добавленный посторонний или забытый publish-bit иначе пройдёт незамеченным.
    assert.equal(
      VOICE_PUBLISH_MASK,
      Permission.CONNECT |
        Permission.SPEAK |
        Permission.VIDEO |
        Permission.STREAM |
        Permission.SHARE_SCREEN |
        Permission.PRIORITY_SPEAKER,
    );
  });

  it('постороннее право управления сервером в маску не попадает', () => {
    // Ловит лишний перевыпуск голосового токена при изменении несвязанного разрешения.
    const source = Permission.SPEAK | Permission.MANAGE_SERVER;
    assert.equal(voicePublishBits(source.toString()), Permission.SPEAK);
  });

  it('смена только текстового права не меняет результат', () => {
    // Ловит зависимость голосового токена от прав чата, не влияющих на публикацию медиа.
    const voice = Permission.CONNECT | Permission.SPEAK;
    assert.equal(voicePublishBits(voice.toString()), voicePublishBits((voice | Permission.SEND_MESSAGES).toString()));
  });
});
