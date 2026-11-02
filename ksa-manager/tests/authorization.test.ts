import { describe, expect, it } from 'vitest';
import { argInt, cid, parseCid } from '../src/domain/customId.js';
import { authorize, resolveLevel, type Action, type AuthConfig } from '../src/domain/permissions.js';
import { checkTransition } from '../src/domain/orderStatus.js';

const auth: AuthConfig = {
  ownerIds: ['1551640828185940140', '1047235303146008598', '1008361725336231986'],
  roles: { founder: 'R_FOUNDER', admin: 'R_ADMIN', support: 'R_SUPPORT', operator: 'R_OPERATOR' },
};

const founder = { userId: '1047235303146008598', roleIds: [] };
const admin = { userId: 'u_admin', roleIds: ['R_ADMIN'] };
const support = { userId: 'u_support', roleIds: ['R_SUPPORT'] };
const operator = { userId: 'u_op', roleIds: ['R_OPERATOR'] };
const foreignOperator = { userId: 'u_op2', roleIds: ['R_OPERATOR'] };
const customer = { userId: 'u_customer', roleIds: [] };
const member = { userId: 'u_member', roleIds: [] };
const scope = { customerId: 'u_customer', assignedOperatorId: 'u_op' };

const can = (actor: { userId: string; roleIds: string[] }, action: Action, withScope = true) => authorize(actor, auth, action, withScope ? scope : undefined).allowed;

describe('Rollenauflösung', () => {
  it('erkennt Founder ausschließlich über Nutzer-IDs', () => {
    expect(resolveLevel(founder, auth)).toBe('founder');
    // Die Discord-Rolle "KSA Founder" ohne passende Nutzer-ID ergibt keine Founder-Rechte
    expect(resolveLevel({ userId: 'x', roleIds: ['R_FOUNDER'] }, auth)).toBe('admin');
    // Ein gleichnamiges, fremdes Rollen-ID wird ignoriert (Namen spielen keine Rolle)
    expect(resolveLevel({ userId: 'x', roleIds: ['ANDERE_ROLLE_NAMENS_KSA_FOUNDER'] }, auth)).toBe('member');
  });
  it('ordnet Rollen-IDs korrekt zu', () => {
    expect(resolveLevel(admin, auth)).toBe('admin');
    expect(resolveLevel(support, auth)).toBe('support');
    expect(resolveLevel(operator, auth)).toBe('operator');
    expect(resolveLevel(member, auth)).toBe('member');
  });
});

describe('Berechtigungsmatrix', () => {
  it('nur Founder dürfen Setup, Konfiguration und Rollenmodus', () => {
    for (const a of ['setup.run', 'config.write', 'boost.roleMode'] as Action[]) {
      expect(can(founder, a)).toBe(true);
      expect(can(admin, a)).toBe(false);
      expect(can(support, a)).toBe(false);
      expect(can(operator, a)).toBe(false);
      expect(can(member, a)).toBe(false);
    }
  });
  it('Zahlungsstatus und Proof-Rücknahme nur Admin/Founder', () => {
    for (const a of ['order.payment', 'proof.withdraw'] as Action[]) {
      expect(can(founder, a)).toBe(true);
      expect(can(admin, a)).toBe(true);
      expect(can(support, a)).toBe(false);
      expect(can(operator, a)).toBe(false);
      expect(can(customer, a)).toBe(false);
    }
  });
  it('Support verwaltet Tickets, Angebote und Team-Freigaben', () => {
    for (const a of ['ticket.claim', 'ticket.assign', 'ticket.reopen', 'offer.create', 'proof.teamApprove', 'ticket.export.internal'] as Action[]) {
      expect(can(support, a)).toBe(true);
      expect(can(operator, a)).toBe(false);
      expect(can(customer, a)).toBe(false);
      expect(can(member, a)).toBe(false);
    }
  });
  it('Operator nur für zugewiesene Aufträge', () => {
    for (const a of ['order.status', 'order.progress', 'order.note', 'proof.submit', 'order.view.internal'] as Action[]) {
      expect(can(operator, a)).toBe(true);
      expect(can(foreignOperator, a)).toBe(false);
      expect(can(customer, a)).toBe(false);
      expect(can(member, a)).toBe(false);
      expect(can(support, a)).toBe(true);
    }
  });
  it('Kundenaktionen kann ausschließlich der Kunde ausführen – auch kein Founder', () => {
    for (const a of ['offer.accept', 'proof.customerConsent', 'proof.customerRevoke', 'review.submit'] as Action[]) {
      expect(can(customer, a)).toBe(true);
      expect(can(founder, a)).toBe(false);
      expect(can(admin, a)).toBe(false);
      expect(can(support, a)).toBe(false);
      expect(can(operator, a)).toBe(false);
      expect(can(member, a)).toBe(false);
    }
  });
  it('fremde Tickets sind für normale Mitglieder und fremde Operatoren gesperrt', () => {
    expect(can(member, 'ticket.view')).toBe(false);
    expect(can(foreignOperator, 'ticket.view')).toBe(false);
    expect(can(customer, 'ticket.view')).toBe(true);
    expect(can(operator, 'ticket.view')).toBe(true);
    expect(can(member, 'ticket.export.customer')).toBe(false);
  });
  it('Aktionen ohne Ticketbezug werden für Scope-Regeln abgelehnt', () => {
    expect(can(customer, 'offer.accept', false)).toBe(false);
    expect(can(operator, 'order.status', false)).toBe(false);
  });
});

describe('Statusmaschine', () => {
  it('erlaubt nur definierte Wechsel', () => {
    expect(checkTransition('angebot_angenommen', 'in_bearbeitung', 'support', false).ok).toBe(true);
    expect(checkTransition('abgeschlossen', 'in_bearbeitung', 'founder', false).ok).toBe(false);
    expect(checkTransition('storniert', 'wartet', 'founder', false).ok).toBe(false);
    expect(checkTransition('wartet', 'abgeschlossen', 'support', false).ok).toBe(false);
  });
  it('Operator darf bearbeiten/abschließen, aber nicht stornieren', () => {
    expect(checkTransition('wartet', 'in_bearbeitung', 'operator', true).ok).toBe(true);
    expect(checkTransition('in_bearbeitung', 'abgeschlossen', 'operator', true).ok).toBe(true);
    expect(checkTransition('in_bearbeitung', 'storniert', 'operator', true).ok).toBe(false);
    expect(checkTransition('wartet', 'in_bearbeitung', 'operator', false).ok).toBe(false);
    expect(checkTransition('wartet', 'in_bearbeitung', 'member', false).ok).toBe(false);
  });
});

describe('Custom-IDs', () => {
  it('kodiert und dekodiert', () => {
    const id = cid('of', 'accept', 42, 'abcdef0123456789');
    expect(parseCid(id)).toEqual({ ns: 'of', action: 'accept', args: ['42', 'abcdef0123456789'] });
  });
  it('weist manipulierte IDs zurück', () => {
    expect(parseCid('fremd:of:accept:1')).toBeNull();
    expect(parseCid('ksa:of')).toBeNull();
    expect(parseCid('ksa:of:accept:1;DROP TABLE')).toBeNull();
    expect(parseCid(`ksa:of:accept:${'1'.repeat(120)}`)).toBeNull();
    const p = parseCid('ksa:of:accept:-1')!;
    expect(argInt(p, 0)).toBeNull();
    expect(argInt(parseCid('ksa:of:accept:0')!, 0)).toBeNull();
    expect(argInt(parseCid('ksa:of:accept:abc')!, 0)).toBeNull();
  });
  it('erzwingt das Discord-Limit von 100 Zeichen', () => {
    expect(() => cid('a', 'b', 'x'.repeat(40), 'y'.repeat(40), 'z'.repeat(40))).toThrow();
  });
});
