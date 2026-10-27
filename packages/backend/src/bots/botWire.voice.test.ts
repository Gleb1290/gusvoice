import assert from 'node:assert/strict';
import { it } from 'node:test';
import { UPDATE_TYPES } from '../../../bot-sdk/src/wire.js';
import * as wire from './botWire.js';
import { BOT_UPDATE_TYPES } from './botRules.js';
import type { BotWireSdkChecks } from './botWireSdk.js';

// Typecheck обязан включать двусторонний контракт SDK, не только тестовый JSON.
type VoiceMirrorIsChecked = BotWireSdkChecks;
const mirror: VoiceMirrorIsChecked | undefined = undefined;
void mirror;
it('R306 voice_state зеркалится в SDK, прежние типы доставки не теряются', () => {
  assert.deepEqual([...BOT_UPDATE_TYPES], [...UPDATE_TYPES]); assert.equal(BOT_UPDATE_TYPES.includes('voice_state'), true);
});
it('R306 joinVoice принимает обе границы bitrate, отказывает рядом и разбирает форму', () => {
  for (const bitrate of [24000, 64000, 128000]) {
    assert.deepEqual(wire.joinVoiceParams.parse({ chat_id: 'voice', bitrate }), { chat_id: 'voice', bitrate });
    assert.equal(wire.joinVoiceParams.parse({ chat_id: 'voice', bitrate: String(bitrate) }).bitrate, bitrate);
  }
  for (const bitrate of [23999, 128001, 64000.5, 'no', null]) assert.equal(wire.joinVoiceParams.safeParse({ chat_id: 'voice', bitrate }).success, false);
  assert.deepEqual(wire.joinVoiceParams.parse({ chat_id: 'voice' }), { chat_id: 'voice' });
});
it('R306 выход без chat_id означает все комнаты, чтение участников требует непустой id', () => {
  assert.deepEqual(wire.leaveVoiceParams.parse({}), {});
  for (const schema of [wire.joinVoiceParams, wire.getVoiceChatMembersParams]) {
    assert.equal(schema.safeParse({}).success, false); assert.equal(schema.safeParse({ chat_id: '' }).success, false);
    assert.equal(schema.safeParse({ chat_id: 'voice' }).success, true);
  }
  assert.deepEqual(wire.leaveVoiceParams.parse({ chat_id: 'voice' }), { chat_id: 'voice' });
});
it('R306 voice_state с move_to и гостем проходит настоящий провод, неизвестное действие отвергается', () => {
  const chat = wire.voiceChat({ id: 'v', name: 'Голос', serverId: 's' });
  assert.deepEqual(chat, { id: 'v', type: 'voice', server_id: 's', title: 'Голос' });
  const state = { chat, user: { id: 'guest', username: 'peer_user', display_name: 'Гость', bot: false, instance_domain: 'peer.invalid' },
    action: 'left', date: 1700000000, move_to: { ...chat, id: 'v2' } };
  assert.deepEqual(wire.wireUpdate.parse({ update_id: 1, voice_state: state }), { update_id: 1, voice_state: state });
  assert.equal(wire.wireVoiceState.safeParse({ ...state, action: 'updated' }).success, false);
  const result = { url: 'wss://livekit.invalid', token: 'synthetic-not-a-token', room: 'channel_v', chat,
    server_muted: true, expires_in: 600, audio: { sample_rate: 48000, channels: 2, bitrate: 64000 } };
  assert.deepEqual(wire.wireJoinVoice.parse(result), result);
  assert.equal(wire.wireVoiceChatMember.safeParse({ user: state.user, muted: true, deafened: false, server_muted: true, is_bot: false }).success, true);
});
