/**
 * Тумблер федерации в админке (#224): включить и выключить федерацию и ЛС между инстансами без `.env` и перезапуска.
 *
 * Флаги живут в `instance_settings` (ключ `federation_switch`, миграция 0148) и складываются с `.env`: `FEDERATION_ENABLED=true`
 * / `FEDERATION_DM_ENABLED=true` включают «из .env», и выключить их из панели нельзя (у прода всё в `.env` — для него ничего
 * не меняется). Пароль к ключу инстанса: `FEDERATION_KEY_PASSPHRASE` из `.env`, если задан; иначе — сгенерированный здесь при
 * первом включении (`randomBytes(32)`, hex) и сохранённый в базе (ключ `federation_key_passphrase`). Ключ — по-прежнему файл
 * в `fed-keys`: для переноса сервера нужны вместе резервная копия базы и эта папка.
 *
 * 🔴 Пароль не уходит клиенту (в `FederationSwitchView` его нет) и не пишется в лог.
 * Выключение не трогает связки, ключи и пароль: следующее включение читает тот же файл — личность та же.
 */

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FederationSwitchPatch, FederationSwitchView } from '@gusvoice/shared';
import { db } from '../db/index.js';
import { instanceSettings } from '../db/schema.js';
import { env } from '../env.js';
import { federation, useFederationPassphrase } from './instance.js';

/** Флаги, поставленные в админке. */
export const FED_SWITCH_KEY = 'federation_switch';
/** Пароль к ключу инстанса, если его нет в `.env`. 🔴 Значение не читать наружу ни одним маршрутом. */
export const FED_PASSPHRASE_KEY = 'federation_key_passphrase';

interface PanelSwitch {
  enabled: boolean;
  dmEnabled: boolean;
}

async function readSetting(key: string): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, key))
    .limit(1);
  return row?.value ?? null;
}

async function readPanelSwitch(): Promise<PanelSwitch> {
  const v = (await readSetting(FED_SWITCH_KEY)) ?? {};
  return { enabled: v.enabled === true, dmEnabled: v.dmEnabled === true };
}

async function writePanelSwitch(next: PanelSwitch): Promise<void> {
  const value = { enabled: next.enabled, dmEnabled: next.dmEnabled };
  await db
    .insert(instanceSettings)
    .values({ key: FED_SWITCH_KEY, value })
    .onConflictDoUpdate({ target: instanceSettings.key, set: { value, updatedAt: new Date() } });
}

/** Пароль из базы; нет — завести. Два одновременных включения не разойдутся: остаётся записанный первым. */
async function passphraseFromBase(): Promise<string> {
  const stored = (await readSetting(FED_PASSPHRASE_KEY))?.passphrase;
  if (typeof stored === 'string' && stored.length > 0) return stored;
  await db
    .insert(instanceSettings)
    .values({ key: FED_PASSPHRASE_KEY, value: { passphrase: randomBytes(32).toString('hex') } })
    .onConflictDoNothing();
  const again = (await readSetting(FED_PASSPHRASE_KEY))?.passphrase;
  return typeof again === 'string' ? again : '';
}

const listeners: Array<() => void> = [];

/** Флаги сменились (включили, выключили, поменяли ЛС) — `index.ts` перевешивает крючки и заводит фоновые задачи. */
export function onFederationSwitch(fn: () => void): void {
  listeners.push(fn);
}

// Переключения идут строго по одному: два быстрых нажатия не должны поднимать ключ дважды.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

async function apply(panel: PanelSwitch): Promise<void> {
  const enabled = env.federation.envEnabled || panel.enabled;
  const dmEnabled = enabled && (env.federation.envDmEnabled || panel.dmEnabled);
  if (enabled && federation.status() !== 'ready') {
    // Пароль из `.env` главнее; пусто — из базы (заводится при первом включении).
    if (env.federation.keyPassphrase) useFederationPassphrase(env.federation.keyPassphrase, 'env');
    else {
      let fromBase = '';
      try {
        fromBase = await passphraseFromBase();
      } catch (err) {
        console.warn(`[fed] пароль к ключу из базы не прочитан: ${err instanceof Error ? err.message : String(err)}`);
      }
      useFederationPassphrase(fromBase, 'base');
    }
    env.federation.enabled = true;
    env.federation.dmEnabled = dmEnabled;
    // Ошибки ключа `start()` ловит сам и показывает во вкладке («Ключ инстанса не расшифрован…»).
    await federation.start();
  } else if (!enabled && env.federation.enabled) {
    env.federation.enabled = false;
    env.federation.dmEnabled = false;
    federation.stop();
  } else {
    env.federation.enabled = enabled;
    env.federation.dmEnabled = dmEnabled;
  }
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.warn(`[fed] переключение федерации: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * При старте, до `listen` (на месте прежнего `federation.start()`): флаги из `.env` и из базы. База недоступна — как до
 * #224, только `.env`.
 */
export async function startFederationSwitch(): Promise<void> {
  let panel: PanelSwitch = { enabled: false, dmEnabled: false };
  try {
    panel = await readPanelSwitch();
  } catch (err) {
    console.warn(`[fed] тумблер федерации из базы не прочитан: ${err instanceof Error ? err.message : String(err)}`);
  }
  await serial(() => apply(panel));
  if (!env.federation.enabled) await federation.start(); // пишет в лог «федерация выключена», как раньше
}

/** Что показать во вкладке: флаги, откуда они и поднялся ли ключ. Без пароля. */
export function federationSwitchView(): FederationSwitchView {
  const f = env.federation;
  return {
    enabled: f.enabled,
    source: f.envEnabled ? 'env' : f.enabled ? 'panel' : 'off',
    dmEnabled: f.dmEnabled,
    dmSource: f.envDmEnabled ? 'env' : f.dmEnabled ? 'panel' : 'off',
    status: federation.status(),
    problem: federation.problem(),
  };
}

/** Почему переключение отклонено — код для клиента (тексты у него). */
export type SwitchRefusal = 'env_locked' | 'dm_env_locked' | 'federation_off';

/** `PATCH /admin/federation/switch`. Включено в `.env` — выключить нельзя; ЛС — только при включённой федерации. */
export async function setFederationSwitch(patch: FederationSwitchPatch): Promise<SwitchRefusal | null> {
  return serial(async () => {
    if (patch.enabled === false && env.federation.envEnabled) return 'env_locked';
    if (patch.dmEnabled === false && env.federation.envDmEnabled) return 'dm_env_locked';
    const panel = await readPanelSwitch();
    const next: PanelSwitch = {
      enabled: patch.enabled ?? panel.enabled,
      dmEnabled: patch.dmEnabled ?? panel.dmEnabled,
    };
    if (patch.dmEnabled === true && !(env.federation.envEnabled || next.enabled)) return 'federation_off';
    await writePanelSwitch(next);
    await apply(next);
    return null;
  });
}
