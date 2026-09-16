import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CLIP_BLOCK_TEXT,
  SOUNDBOARD_NAME_MAX,
  clipBlock,
  clipPriceCoins,
  soundboardChannelKey,
  soundboardName,
  type ClipInput,
} from './soundboardRules.js';

const clip = (patch: Partial<ClipInput> = {}): ClipInput => ({
  clip: { id: 'clip-1', serverId: 'srv-1' },
  serverId: 'srv-1',
  channelBusy: false,
  ...patch,
});

describe('выстрел сэмпла', () => {
  it('свой сэмпл в свободном канале проходит', () => {
    assert.equal(clipBlock(clip()), null);
  });

  it('несуществующий сэмпл отвергается', () => {
    assert.equal(clipBlock(clip({ clip: null })), 'unknown-clip');
  });

  /**
   * 🔴 Главная проверка модуля. Идентификаторы сэмплов ничем не защищены, и без сверки сервера
   * участник подставил бы в запрос чужой и выстрелил у себя звуком с сервера, куда его не звали.
   * Канал СВОБОДЕН намеренно: так тест ловит и случай, когда сверку по невнимательности утопили
   * внутрь ветки занятости.
   */
  it('сэмпл с чужого сервера отвергается даже когда канал свободен', () => {
    assert.equal(clipBlock(clip({ clip: { id: 'clip-1', serverId: 'srv-2' }, channelBusy: false })), 'wrong-server');
  });

  it('занятый канал не даёт выстрелить своим сэмплом', () => {
    assert.equal(clipBlock(clip({ channelBusy: true })), 'channel-busy');
  });

  /**
   * ⚠️ Совпадение текстов — ТРЕБОВАНИЕ, а не копипаста: разный текст подтверждал бы, что сэмпл с
   * таким идентификатором существует, просто на другом сервере. Без этой проверки чью-то будущую
   * «доброту» («уточним человеку, что звук не отсюда») никто не остановит.
   */
  it('чужой сервер и несуществующий сэмпл отвечают ОДИНАКОВО', () => {
    assert.equal(CLIP_BLOCK_TEXT['wrong-server'], CLIP_BLOCK_TEXT['unknown-clip']);
  });

  it('пауза канала считается по каналу, а не по человеку', () => {
    assert.notEqual(soundboardChannelKey('ch-1'), soundboardChannelKey('ch-2'));
    assert.ok(soundboardChannelKey('ch-1').includes('ch-1'));
  });
});

describe('имя сэмпла', () => {
  it('пустое и пробельное не принимаются', () => {
    assert.equal(soundboardName(''), null);
    assert.equal(soundboardName('   '), null);
    assert.equal(soundboardName('\n\t '), null);
  });

  it('края режутся, внутренние пробелы схлопываются', () => {
    assert.equal(soundboardName('  бах   бах  '), 'бах бах');
    assert.equal(soundboardName('бах\nбах'), 'бах бах');
  });

  /** Граница: ровно предел проходит, на один символ длиннее — нет. */
  it('длина проверяется по включительной границе', () => {
    const at = 'а'.repeat(SOUNDBOARD_NAME_MAX);
    assert.equal(soundboardName(at), at);
    assert.equal(soundboardName('а'.repeat(SOUNDBOARD_NAME_MAX + 1)), null);
  });

  /**
   * ⚠️ Длина меряется ПОСЛЕ схлопывания, а не до. Иначе имя, которое на кнопке выглядит коротким,
   * отвергалось бы из-за невидимых пробелов — отказ, который человеку нечем объяснить.
   */
  it('невидимые пробелы не съедают предел длины', () => {
    const padded = `  ${'а'.repeat(SOUNDBOARD_NAME_MAX)}      `;
    assert.ok(padded.length > SOUNDBOARD_NAME_MAX);
    assert.equal(soundboardName(padded), 'а'.repeat(SOUNDBOARD_NAME_MAX));
  });
});

describe('clipPriceCoins', () => {
  it('своя цена важнее общей', () => {
    assert.equal(clipPriceCoins(120, 30), 120);
  });

  it('НОЛЬ — это цена «даром», а не «нет цены»', () => {
    // Самая опасная путаница здесь: спутай мы ноль с отсутствием — владелец, поставивший «даром»,
    // молча получил бы общую цену, и звук перестал бы быть бесплатным без единого сообщения.
    assert.equal(clipPriceCoins(0, 30), 0);
  });

  it('null и undefined откатывают на общую', () => {
    assert.equal(clipPriceCoins(null, 30), 30);
    assert.equal(clipPriceCoins(undefined, 30), 30);
  });

  it('мусор откатывает на общую, а не превращается в ноль', () => {
    assert.equal(clipPriceCoins(Number.NaN, 30), 30);
    assert.equal(clipPriceCoins(Number.POSITIVE_INFINITY, 30), 30);
  });

  it('отрицательное схлопывается в ноль — доплаты за выстрел не бывает', () => {
    assert.equal(clipPriceCoins(-50, 30), 0);
  });

  it('дробное округляется вниз: монета не делится', () => {
    assert.equal(clipPriceCoins(12.9, 30), 12);
  });
});
