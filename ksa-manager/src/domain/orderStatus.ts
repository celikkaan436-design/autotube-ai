import type { Level } from './permissions.js';
import { atLeast } from './permissions.js';
import type { OrderStatus } from './constants.js';

/** Erlaubte Statuswechsel eines Auftrags. Abgeschlossen und Storniert sind Endzustände. */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  angebot_angenommen: ['wartet', 'in_bearbeitung', 'storniert'],
  wartet: ['in_bearbeitung', 'pausiert', 'storniert'],
  in_bearbeitung: ['pausiert', 'wartet', 'abgeschlossen', 'storniert'],
  pausiert: ['in_bearbeitung', 'wartet', 'storniert'],
  abgeschlossen: [],
  storniert: [],
};

/** Ein zugewiesener Operator darf bearbeiten, pausieren und abschließen – nicht stornieren. */
const OPERATOR_TARGETS: readonly OrderStatus[] = ['wartet', 'in_bearbeitung', 'pausiert', 'abgeschlossen'];

export type TransitionCheck = { ok: true } | { ok: false; reason: string };

export function checkTransition(from: OrderStatus, to: OrderStatus, actorLevel: Level, isAssignedOperator: boolean): TransitionCheck {
  if (from === to) return { ok: false, reason: 'Der Auftrag hat diesen Status bereits.' };
  if (!ORDER_TRANSITIONS[from].includes(to)) {
    return { ok: false, reason: `Wechsel von „${from}“ nach „${to}“ ist nicht erlaubt.` };
  }
  if (atLeast(actorLevel, 'support')) return { ok: true };
  if (isAssignedOperator && OPERATOR_TARGETS.includes(to)) return { ok: true };
  if (to === 'storniert') return { ok: false, reason: 'Stornieren darf nur der Support, ein Admin oder ein Founder.' };
  return { ok: false, reason: 'Nur der zugewiesene Operator oder der Support darf den Status ändern.' };
}

export function isFinal(status: OrderStatus): boolean {
  return ORDER_TRANSITIONS[status].length === 0;
}

export function isActive(status: OrderStatus): boolean {
  return !isFinal(status);
}
