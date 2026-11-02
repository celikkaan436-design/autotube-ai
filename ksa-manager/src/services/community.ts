import { embed } from '../discord/ui.js';
import type { MemberInfo } from '../discord/port.js';
import { BRAND } from '../domain/constants.js';
import { isStaff, resolveLevel } from '../domain/permissions.js';
import { errInfo } from '../logging/logger.js';
import { UserError } from '../util/errors.js';
import { authConfig, type AppContext } from './context.js';

/**
 * Community: Begrüßung, Regelbestätigung, Interessenrollen und ein einfacher
 * Flood-Schutz. Der Flood-Schutz zählt nur Zeitstempel im Arbeitsspeicher –
 * Nachrichteninhalte werden weder gelesen noch gespeichert.
 */
export class CommunityService {
  private readonly recent = new Map<string, number[]>();
  private readonly lastAlert = new Map<string, number>();

  constructor(private readonly ctx: AppContext) {}

  async welcome(member: MemberInfo): Promise<void> {
    if (member.isBot || !this.ctx.settings.get('community.welcomeEnabled')) return;
    const channelId = this.ctx.registry.channelId('willkommen');
    if (!channelId) return;
    const rules = this.ctx.registry.channelId('regeln');
    const tickets = this.ctx.registry.channelId('ticket_erstellen');
    await this.ctx.port
      .sendMessage(channelId, {
        content: `<@${member.userId}>`,
        embeds: [
          embed({
            description: `Willkommen bei ${BRAND}! Lies zuerst ${rules ? `<#${rules}>` : 'die Regeln'}${this.ctx.settings.get('community.requireRulesAcceptance') ? ' und bestätige sie' : ''}. Anfragen laufen über ${tickets ? `<#${tickets}>` : 'Tickets'}.`,
          }),
        ],
        allowedMentions: { users: [member.userId] },
      })
      .catch((err: unknown) => this.ctx.log.warn({ err: errInfo(err) }, 'Begrüßung fehlgeschlagen'));
  }

  async acceptRules(userId: string): Promise<'added' | 'already'> {
    const roleId = this.ctx.registry.roleId('community');
    if (!roleId) throw new UserError('Die Community-Rolle ist noch nicht eingerichtet.');
    const member = await this.ctx.port.fetchMember(userId, { force: true });
    if (!member) throw new UserError('Mitglied nicht gefunden.');
    if (member.roleIds.includes(roleId)) return 'already';
    await this.ctx.port.addRole(userId, roleId, 'Regeln akzeptiert');
    this.ctx.audit.record(userId, 'community.rules_accepted');
    return 'added';
  }

  async toggleInterest(userId: string, key: 'warzone' | 'multiplayer'): Promise<'added' | 'removed'> {
    const roleId = this.ctx.registry.roleId(key);
    if (!roleId) throw new UserError('Diese Rolle ist noch nicht eingerichtet.');
    const member = await this.ctx.port.fetchMember(userId, { force: true });
    if (!member) throw new UserError('Mitglied nicht gefunden.');
    if (member.roleIds.includes(roleId)) {
      await this.ctx.port.removeRole(userId, roleId, 'Interessenrolle entfernt');
      return 'removed';
    }
    await this.ctx.port.addRole(userId, roleId, 'Interessenrolle gewählt');
    return 'added';
  }

  private communityChannels(): Set<string> {
    const ids = (['allgemein', 'mitspieler', 'clips', 'bot_befehle'] as const)
      .map((k) => this.ctx.registry.channelId(k))
      .filter((x): x is string => Boolean(x));
    return new Set(ids);
  }

  /** Gibt true zurück, wenn die Nachricht als Flood gewertet wurde. */
  async onMessage(m: { channelId: string; messageId: string; authorId: string; roleIds: string[]; isBot: boolean }): Promise<boolean> {
    const st = this.ctx.settings;
    if (m.isBot || !st.get('community.floodGuardEnabled') || !this.communityChannels().has(m.channelId)) return false;
    if (isStaff(resolveLevel({ userId: m.authorId, roleIds: m.roleIds }, authConfig(this.ctx)))) return false;
    const now = this.ctx.clock.now();
    const windowMs = st.get('community.floodWindowSeconds') * 1000;
    const list = (this.recent.get(m.authorId) ?? []).filter((t) => now - t < windowMs);
    list.push(now);
    this.recent.set(m.authorId, list);
    if (this.recent.size > 5000) this.recent.clear();
    if (list.length <= st.get('community.floodMaxMessages')) return false;

    await this.ctx.port.deleteMessage(m.channelId, m.messageId).catch(() => false);
    const last = this.lastAlert.get(m.authorId) ?? 0;
    if (now - last > 60_000) {
      this.lastAlert.set(m.authorId, now);
      const minutes = st.get('community.floodTimeoutMinutes');
      let timedOut = false;
      if (minutes > 0) {
        try {
          await this.ctx.port.timeoutMember(m.authorId, minutes * 60_000, 'Flood-Schutz: zu viele Nachrichten in kurzer Zeit');
          timedOut = true;
        } catch {
          timedOut = false;
        }
      }
      this.ctx.audit.record('system', 'community.flood', { type: 'user', id: m.authorId }, { timedOut });
      await this.ctx.audit.teamLog('Flood-Schutz', [`<@${m.authorId}> hat in <#${m.channelId}> sehr viele Nachrichten gesendet.${timedOut ? ` Timeout: ${minutes} Min.` : ''}`]);
    }
    return true;
  }
}
