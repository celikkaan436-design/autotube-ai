import type { AutoModRuleSpec } from '../discord/port.js';

/**
 * Discord-AutoMod-Regeln (benötigt das Bot-Recht „Server verwalten“).
 * Trigger-Typen laut Discord-Doku: KEYWORD=1 (max. 6), SPAM=3 (max. 1),
 * MENTION_SPAM=5 (max. 1). Aktionen: BLOCK_MESSAGE=1, SEND_ALERT_MESSAGE=2.
 */
export interface AutoModBlueprint {
  key: 'mention_spam' | 'spam' | 'invites';
  name: string;
  triggerType: 1 | 3 | 5;
  /** Von diesem Trigger-Typ erlaubt Discord nur eine Regel pro Server. */
  singleton: boolean;
  build(ids: { teamLogChannelId: string | undefined; exemptRoleIds: string[] }): Omit<AutoModRuleSpec, 'reason'>;
}

export const AUTOMOD_RULES: readonly AutoModBlueprint[] = [
  {
    key: 'mention_spam',
    name: 'KSA – Erwähnungs-Spam',
    triggerType: 5,
    singleton: true,
    build: ({ teamLogChannelId, exemptRoleIds }) => ({
      name: 'KSA – Erwähnungs-Spam',
      eventType: 1,
      triggerType: 5,
      triggerMetadata: { mention_total_limit: 5, mention_raid_protection_enabled: true },
      actions: [
        { type: 1, metadata: { custom_message: 'Zu viele Erwähnungen in einer Nachricht.' } },
        ...(teamLogChannelId ? [{ type: 2, metadata: { channel_id: teamLogChannelId } }] : []),
      ],
      exemptRoles: exemptRoleIds,
    }),
  },
  {
    key: 'spam',
    name: 'KSA – Spam-Inhalte',
    triggerType: 3,
    singleton: true,
    build: ({ exemptRoleIds }) => ({
      name: 'KSA – Spam-Inhalte',
      eventType: 1,
      triggerType: 3,
      triggerMetadata: {},
      actions: [{ type: 1, metadata: { custom_message: 'Diese Nachricht wurde als Spam erkannt.' } }],
      exemptRoles: exemptRoleIds,
    }),
  },
  {
    key: 'invites',
    name: 'KSA – Einladungslinks',
    triggerType: 1,
    singleton: false,
    build: ({ teamLogChannelId, exemptRoleIds }) => ({
      name: 'KSA – Einladungslinks',
      eventType: 1,
      triggerType: 1,
      triggerMetadata: { regex_patterns: ['(?:discord\\.gg|discord(?:app)?\\.com/invite)/[A-Za-z0-9-]+'] },
      actions: [
        { type: 1, metadata: { custom_message: 'Einladungslinks zu anderen Servern sind hier nicht erlaubt.' } },
        ...(teamLogChannelId ? [{ type: 2, metadata: { channel_id: teamLogChannelId } }] : []),
      ],
      exemptRoles: exemptRoleIds,
    }),
  },
];
