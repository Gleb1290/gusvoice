import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lostCueDelayMs, REJOIN_WINDOW_MS, shouldAutoRejoin, type VoiceSessionLike } from './voiceCueRules.js';

const session = (ts: number): VoiceSessionLike => ({ serverId: 'server', channelId: 'voice', ts });

describe('задержка звука потери связи', () => {
  it('звук ставится ровно на половину окна отключения', () => {
    // Ловит возврат фиксированной задержки, которая разъедется при смене grace-периода.
    assert.equal(lostCueDelayMs(12_000), 6_000);
  });

  it('нечётное окно округляется вниз до целой миллисекунды', () => {
    // Ловит дробную задержку, которую таймер всё равно округлил бы неявно.
    assert.equal(lostCueDelayMs(5), 2);
  });
});

describe('автоматический возврат в голосовой канал', () => {
  it('без сохранённой сессии приложение не возвращает ушедшего добровольно', () => {
    // Ловит самовольное втягивание человека обратно после обычного выхода из голоса.
    assert.equal(shouldAutoRejoin({ session: null, inVoice: false, now: 10_000 }), false);
  });

  it('уже подключённого к голосу не выдёргивает в старый канал', () => {
    // Ловит перенос из канала, который человек успел выбрать руками во время обрыва.
    assert.equal(shouldAutoRejoin({ session: session(1_000), inVoice: true, now: 2_000 }), false);
  });

  it('сессия принимается до границы окна включительно и отвергается сразу после', () => {
    // Ловит ошибку на единицу в пятиминутном окне авто-возврата.
    assert.equal(shouldAutoRejoin({ session: session(1_000), inVoice: false, now: 1_000 + REJOIN_WINDOW_MS - 1 }), true);
    assert.equal(shouldAutoRejoin({ session: session(1_000), inVoice: false, now: 1_000 + REJOIN_WINDOW_MS }), true);
    assert.equal(shouldAutoRejoin({ session: session(1_000), inVoice: false, now: 1_000 + REJOIN_WINDOW_MS + 1 }), false);
  });

  it('сессия из будущего не считается свежей при разъехавшихся часах', () => {
    // Ловит принятие отрицательного возраста как значения внутри допустимого окна.
    assert.equal(shouldAutoRejoin({ session: session(2_001), inVoice: false, now: 2_000 }), false);
  });

  it('настраиваемое окно соблюдает ту же включительную границу', () => {
    // Ловит использование глобальных пяти минут вопреки явно переданному окну.
    assert.equal(shouldAutoRejoin({ session: session(100), inVoice: false, now: 350, windowMs: 250 }), true);
    assert.equal(shouldAutoRejoin({ session: session(100), inVoice: false, now: 351, windowMs: 250 }), false);
  });
});

