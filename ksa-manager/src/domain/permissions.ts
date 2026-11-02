/**
 * Zentrale Autorisierung. Jede Interaktion wird hier serverseitig geprüft –
 * sichtbare oder unsichtbare Buttons spielen für die Berechtigung keine Rolle.
 *
 * Founder werden ausschließlich über Nutzer-IDs (OWNER_IDS) erkannt.
 * Alle anderen Stufen über die beim Setup gespeicherten Rollen-IDs – niemals über Namen.
 */

export type Level = 'founder' | 'admin' | 'support' | 'operator' | 'member';

const LEVEL_RANK: Record<Level, number> = {
  founder: 4,
  admin: 3,
  support: 2,
  operator: 1,
  member: 0,
};

export interface Actor {
  userId: string;
  roleIds: readonly string[];
}

export interface RoleDirectory {
  founder?: string | undefined;
  admin?: string | undefined;
  support?: string | undefined;
  operator?: string | undefined;
}

export interface AuthConfig {
  ownerIds: readonly string[];
  roles: RoleDirectory;
}

/** Ressource mit Ticketbezug (Ticket, Angebot, Auftrag, Proof, Bewertung). */
export interface TicketScope {
  customerId: string;
  assignedOperatorId: string | null;
}

export type Action =
  | 'setup.run'
  | 'setup.diagnose'
  | 'config.read'
  | 'config.write'
  | 'panel.manage'
  | 'boost.roleMode'
  | 'boost.diagnose'
  | 'boost.sync'
  | 'health.view'
  | 'ticket.list'
  | 'ticket.view'
  | 'ticket.claim'
  | 'ticket.assign'
  | 'ticket.close'
  | 'ticket.reopen'
  | 'ticket.export.internal'
  | 'ticket.export.customer'
  | 'offer.create'
  | 'offer.withdraw'
  | 'offer.view'
  | 'offer.accept'
  | 'order.view'
  | 'order.view.internal'
  | 'order.status'
  | 'order.status.cancel'
  | 'order.progress'
  | 'order.note'
  | 'order.payment'
  | 'proof.submit'
  | 'proof.edit'
  | 'proof.view'
  | 'proof.teamApprove'
  | 'proof.customerConsent'
  | 'proof.customerRevoke'
  | 'proof.withdraw'
  | 'review.submit'
  | 'review.withdrawOwn'
  | 'review.moderate';

type Rule =
  | { kind: 'minLevel'; level: Level }
  /** Mindeststufe ODER zugewiesener Operator der Ressource. */
  | { kind: 'staffOrAssigned'; level: Level }
  /** Kunde der Ressource, Mindeststufe ODER zugewiesener Operator. */
  | { kind: 'participant'; level: Level }
  /** Ausschließlich der Kunde der Ressource – auch Founder nicht stellvertretend. */
  | { kind: 'customerOnly' }
  /** Kunde der Ressource oder Mindeststufe. */
  | { kind: 'customerOrLevel'; level: Level };

const POLICY: Record<Action, Rule> = {
  'setup.run': { kind: 'minLevel', level: 'founder' },
  'config.write': { kind: 'minLevel', level: 'founder' },
  'boost.roleMode': { kind: 'minLevel', level: 'founder' },

  'setup.diagnose': { kind: 'minLevel', level: 'admin' },
  'config.read': { kind: 'minLevel', level: 'admin' },
  'panel.manage': { kind: 'minLevel', level: 'admin' },
  'boost.diagnose': { kind: 'minLevel', level: 'admin' },
  'boost.sync': { kind: 'minLevel', level: 'admin' },
  'order.payment': { kind: 'minLevel', level: 'admin' },
  'proof.withdraw': { kind: 'minLevel', level: 'admin' },

  'health.view': { kind: 'minLevel', level: 'support' },
  'ticket.list': { kind: 'minLevel', level: 'support' },
  'ticket.claim': { kind: 'minLevel', level: 'support' },
  'ticket.assign': { kind: 'minLevel', level: 'support' },
  'ticket.reopen': { kind: 'minLevel', level: 'support' },
  'ticket.export.internal': { kind: 'minLevel', level: 'support' },
  'offer.create': { kind: 'minLevel', level: 'support' },
  'offer.withdraw': { kind: 'minLevel', level: 'support' },
  'order.status.cancel': { kind: 'minLevel', level: 'support' },
  'proof.teamApprove': { kind: 'minLevel', level: 'support' },
  'review.moderate': { kind: 'minLevel', level: 'support' },

  'order.view.internal': { kind: 'staffOrAssigned', level: 'support' },
  'order.status': { kind: 'staffOrAssigned', level: 'support' },
  'order.progress': { kind: 'staffOrAssigned', level: 'support' },
  'order.note': { kind: 'staffOrAssigned', level: 'support' },
  'proof.submit': { kind: 'staffOrAssigned', level: 'support' },
  'proof.edit': { kind: 'staffOrAssigned', level: 'support' },

  'ticket.view': { kind: 'participant', level: 'support' },
  'offer.view': { kind: 'participant', level: 'support' },
  'order.view': { kind: 'participant', level: 'support' },
  'proof.view': { kind: 'participant', level: 'support' },

  'ticket.close': { kind: 'customerOrLevel', level: 'support' },
  'ticket.export.customer': { kind: 'customerOrLevel', level: 'support' },

  'offer.accept': { kind: 'customerOnly' },
  'proof.customerConsent': { kind: 'customerOnly' },
  'proof.customerRevoke': { kind: 'customerOnly' },
  'review.submit': { kind: 'customerOnly' },
  'review.withdrawOwn': { kind: 'customerOnly' },
};

export function resolveLevel(actor: Actor, auth: AuthConfig): Level {
  if (auth.ownerIds.includes(actor.userId)) return 'founder';
  const has = (id: string | undefined) => id !== undefined && actor.roleIds.includes(id);
  // Die Discord-Rolle "KSA Founder" allein verleiht keine Founder-Rechte im Bot
  // (Founder ausschließlich über Nutzer-IDs), sondern höchstens operative Admin-Rechte.
  if (has(auth.roles.founder) || has(auth.roles.admin)) return 'admin';
  if (has(auth.roles.support)) return 'support';
  if (has(auth.roles.operator)) return 'operator';
  return 'member';
}

export function atLeast(level: Level, min: Level): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[min];
}

export function isStaff(level: Level): boolean {
  return level !== 'member';
}

export interface Decision {
  allowed: boolean;
  reason?: string;
}

const DENY_LEVEL: Record<Level, string> = {
  founder: 'Diese Aktion ist den Foundern vorbehalten.',
  admin: 'Diese Aktion ist Admins und Foundern vorbehalten.',
  support: 'Diese Aktion ist dem Support-Team vorbehalten.',
  operator: 'Diese Aktion ist dem Team vorbehalten.',
  member: 'Keine Berechtigung.',
};

export function authorize(actor: Actor, auth: AuthConfig, action: Action, scope?: TicketScope): Decision {
  const rule = POLICY[action];
  const level = resolveLevel(actor, auth);
  const isCustomer = scope !== undefined && scope.customerId === actor.userId;
  const isAssigned =
    scope !== undefined &&
    scope.assignedOperatorId !== null &&
    scope.assignedOperatorId === actor.userId &&
    atLeast(level, 'operator');

  switch (rule.kind) {
    case 'minLevel':
      return atLeast(level, rule.level) ? { allowed: true } : { allowed: false, reason: DENY_LEVEL[rule.level] };
    case 'staffOrAssigned':
      if (scope === undefined) return { allowed: false, reason: 'Kein Ticket- oder Auftragsbezug.' };
      if (atLeast(level, rule.level) || isAssigned) return { allowed: true };
      return { allowed: false, reason: 'Nur das zuständige Team bzw. der zugewiesene Operator darf das.' };
    case 'participant':
      if (scope === undefined) return { allowed: false, reason: 'Kein Ticket- oder Auftragsbezug.' };
      if (isCustomer || isAssigned || atLeast(level, rule.level)) return { allowed: true };
      return { allowed: false, reason: 'Du bist an diesem Vorgang nicht beteiligt.' };
    case 'customerOnly':
      if (scope === undefined) return { allowed: false, reason: 'Kein Ticket- oder Auftragsbezug.' };
      return isCustomer
        ? { allowed: true }
        : { allowed: false, reason: 'Das kann ausschließlich der Kunde dieses Vorgangs.' };
    case 'customerOrLevel':
      if (scope === undefined) return { allowed: false, reason: 'Kein Ticket- oder Auftragsbezug.' };
      return isCustomer || atLeast(level, rule.level)
        ? { allowed: true }
        : { allowed: false, reason: 'Nur der Kunde oder der Support darf das.' };
  }
}

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export function assertAllowed(actor: Actor, auth: AuthConfig, action: Action, scope?: TicketScope): void {
  const d = authorize(actor, auth, action, scope);
  if (!d.allowed) throw new AuthorizationError(d.reason ?? 'Keine Berechtigung.');
}

export const LEVEL_LABEL: Record<Level, string> = {
  founder: 'Founder',
  admin: 'Admin',
  support: 'Support',
  operator: 'Operator',
  member: 'Mitglied',
};
