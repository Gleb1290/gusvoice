// GusVoice noise gate — runs on the audio render thread so it keeps gating even when the app window
// is unfocused/minimized (a plain rAF loop would freeze there). Passes the mic through, multiplied by
// a smoothed envelope that opens when the block peak crosses `threshold` and holds open briefly after.
//
// `threshold` is 0..1 in the SAME scale as the mic-test meter (float peak * 1.422, capped at 1), so a
// marker on that meter lines up with what actually gates. threshold <= 0 => always open (gate off).
// The main thread pushes { threshold } via port messages on every settings change.
class GusGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.threshold = 0; // 0 = gate disabled
    this.env = 0; // current gain envelope, 0..1
    this.hold = 0; // samples remaining to stay open after dropping below threshold
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.threshold === 'number') this.threshold = e.data.threshold;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    // 🔴 Идём по каналам ВЫХОДА, а не входа. Микрофон почти всегда МОНО (input.length === 1),
    // а выход у AudioWorkletNode создаётся стерео — старый цикл `c < input.length` заполнял
    // только левый канал, правый оставался тишиной. Итог: и «прослушать себя», и отправляемый
    // трек звучали в одном ухе. Моно-вход раздаём во все каналы выхода.
    if (this.threshold <= 0) {
      // Gate off: straight passthrough (and keep the envelope open for a clean re-enable).
      for (let c = 0; c < output.length; c++) output[c].set(input[Math.min(c, input.length - 1)]);
      this.env = 1;
      return true;
    }

    // Block peak across channels, mapped to the meter's 0..1 scale.
    let peak = 0;
    for (let c = 0; c < input.length; c++) {
      const ch = input[c];
      for (let i = 0; i < ch.length; i++) {
        const a = ch[i] < 0 ? -ch[i] : ch[i];
        if (a > peak) peak = a;
      }
    }
    const level = Math.min(1, peak * 1.422);
    const open = level >= this.threshold;
    if (open) this.hold = sampleRate * 0.25; // 250ms hold-open so speech tails aren't chopped

    // ⚠️ Огибающая считается ПО СЭМПЛАМ, а каналы — внутри. Раньше внешним был цикл по каналам,
    // и на стереовыходе `env` успевала обновиться дважды за сэмпл: атака и спад шли вдвое быстрее
    // заявленных, а правый канал получал уже другую огибающую, чем левый.
    const frames = output[0].length;
    for (let i = 0; i < frames; i++) {
      const target = this.hold > 0 ? 1 : 0;
      // Fast attack, slow release for a natural gate.
      const coeff = target > this.env ? 0.02 : 0.0009;
      this.env += (target - this.env) * coeff;
      if (this.hold > 0) this.hold--;
      for (let c = 0; c < output.length; c++) {
        output[c][i] = input[Math.min(c, input.length - 1)][i] * this.env;
      }
    }
    return true;
  }
}

registerProcessor('gv-gate', GusGateProcessor);
