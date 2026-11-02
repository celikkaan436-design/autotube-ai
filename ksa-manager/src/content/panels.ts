import type { MessagePayload } from '../discord/port.js';
import { button, ButtonStyle, embed, row } from '../discord/ui.js';
import { BRAND, COLORS, GAME_LABEL } from '../domain/constants.js';
import { cid } from '../domain/customId.js';
import { CHANNELS, type ChannelKey, type RoleKey } from '../setup/blueprint.js';

/**
 * Fertige deutsche Panel-Inhalte. Keine erfundenen Preise, Lieferzeiten,
 * Kundenzahlen, Testimonials oder Ranggrenzen. Ränge und Saison stammen
 * ausschließlich aus der Konfiguration (/config).
 */

export const ACTIVISION_POLICY_URL = 'https://support.activision.com/codpolicy';
export const DISCORD_BOOST_HELP_URL = 'https://support.discord.com/hc/articles/360028038352';
export const DISCORD_TERMS_URL = 'https://discord.com/terms';
export const DISCORD_GUIDELINES_URL = 'https://discord.com/guidelines';

export interface PanelContext {
  guildId: string;
  channels: Partial<Record<ChannelKey, string>>;
  roles: Partial<Record<RoleKey, string>>;
  booster: { roleId: string | null; hoist: boolean; managed: boolean };
  settings: {
    maxOpenTickets: number;
    requireRulesAcceptance: boolean;
    warzoneRanks: string[];
    multiplayerRanks: string[];
    season: string;
    extraBoostPerks: string[];
  };
  logoUrl?: string | undefined;
}

export const PANEL_KEYS = [
  'welcome',
  'rules',
  'roles',
  'faq',
  'process',
  'offer_warzone',
  'offer_multiplayer',
  'pricing',
  'ticket',
  'boost_info',
  'proofs_info',
  'reviews_info',
  'orders_overview',
] as const;
export type PanelKey = (typeof PANEL_KEYS)[number];

export interface PanelDefinition {
  key: PanelKey;
  channel: ChannelKey;
  title: string;
  /** Live-Panels werden vom Bot laufend aktualisiert; das Setup prüft nur ihre Existenz. */
  live?: boolean;
  render(ctx: PanelContext): MessagePayload;
}

function ch(ctx: PanelContext, key: ChannelKey): string {
  const id = ctx.channels[key];
  if (id) return `<#${id}>`;
  return `#${CHANNELS.find((c) => c.key === key)?.name ?? key}`;
}

const NO_CREDENTIALS =
  'Gib niemals Passwörter, Session-Tokens, 2FA-Codes oder Zahlungsdaten in Discord ein – auch nicht in Tickets. Der Bot fragt niemals danach und speichert solche Daten nicht.';

export const ticketOpenId = (kind: 'warzone' | 'multiplayer' | 'support') => cid('tk', 'open', kind);
export const RULES_ACCEPT_ID = cid('cm', 'rules');
export const roleToggleId = (k: 'warzone' | 'multiplayer') => cid('cm', 'role', k);

function rankLine(ranks: string[], season: string): string {
  const parts: string[] = [];
  if (season) parts.push(`Aktuelle Saison: **${season}**`);
  if (ranks.length) parts.push(`Ränge laut Team-Konfiguration: ${ranks.join(', ')}`);
  return parts.length ? `\n\n${parts.join('\n')}` : '';
}

export const PANELS: readonly PanelDefinition[] = [
  {
    key: 'welcome',
    channel: 'willkommen',
    title: 'Willkommen',
    render: (ctx) => ({
      embeds: [
        embed({
          title: `Willkommen bei ${BRAND}`,
          logoUrl: ctx.logoUrl,
          description: [
            `Schön, dass du da bist. ${BRAND} bietet manuelles Ranked-Boosting für **${GAME_LABEL.warzone}** und **${GAME_LABEL.multiplayer}**.`,
            '',
            '**So geht es los**',
            ctx.settings.requireRulesAcceptance
              ? `1. Lies die Regeln in ${ch(ctx, 'regeln')} und bestätige sie. Danach werden die übrigen Bereiche sichtbar.`
              : `1. Lies die Regeln in ${ch(ctx, 'regeln')}.`,
            `2. Wähle in ${ch(ctx, 'rollen')} deine Interessen.`,
            `3. Den Ablauf findest du in ${ch(ctx, 'ablauf')}, häufige Fragen in ${ch(ctx, 'faq')}.`,
            `4. Für eine Anfrage öffnest du ein Ticket in ${ch(ctx, 'ticket_erstellen')}.`,
            '',
            `Discord-Serverboosts sind ein eigener Bereich (${ch(ctx, 'server_boosten')}) und haben nichts mit unseren Ranked-Aufträgen zu tun.`,
          ].join('\n'),
        }),
      ],
    }),
  },
  {
    key: 'rules',
    channel: 'regeln',
    title: 'Regeln',
    render: (ctx) => ({
      embeds: [
        embed({
          title: 'Serverregeln',
          description: [
            '**1. Respekt.** Keine Beleidigungen, Diskriminierung, Drohungen oder Belästigung.',
            '**2. Kein Spam.** Keine Werbung und keine Einladungslinks zu anderen Servern ohne Erlaubnis des Teams.',
            '**3. Keine Cheats.** Kein Angebot und keine Nachfrage nach Cheats, Hacks, Exploits, Matchmanipulation oder Anti-Cheat-Umgehung. So etwas bieten wir nicht an.',
            `**4. Keine Zugangsdaten.** ${NO_CREDENTIALS}`,
            '**5. Aufträge nur per Ticket.** Anfragen, Angebote und Absprachen laufen ausschließlich über Tickets – nicht über Direktnachrichten. Das Team erkennst du an den Rollen KSA Founder, KSA Admin, KSA Support und KSA Operator.',
            '**6. Datenschutz.** Keine Screenshots oder Daten anderer Personen (z. B. E-Mail-Adressen, private Chats) teilen.',
            `**7. Discord-Regeln.** Es gelten die [Nutzungsbedingungen](${DISCORD_TERMS_URL}) und [Community-Richtlinien](${DISCORD_GUIDELINES_URL}) von Discord.`,
            '**8. Team-Anweisungen.** Verstöße können zu Verwarnung, Timeout oder Ausschluss führen.',
            '',
            ctx.settings.requireRulesAcceptance
              ? 'Mit **Regeln akzeptieren** bestätigst du die Regeln und schaltest die übrigen Bereiche frei.'
              : 'Mit deiner Teilnahme am Server akzeptierst du diese Regeln.',
          ].join('\n'),
        }),
      ],
      components: ctx.settings.requireRulesAcceptance
        ? [row(button(RULES_ACCEPT_ID, 'Regeln akzeptieren', ButtonStyle.Success))]
        : [],
    }),
  },
  {
    key: 'roles',
    channel: 'rollen',
    title: 'Interessenrollen',
    render: () => ({
      embeds: [
        embed({
          title: 'Interessenrollen',
          description: [
            'Wähle aus, wofür du dich interessierst. Ein erneuter Klick entfernt die Rolle wieder.',
            '',
            '**Warzone** – Interesse an Warzone Ranked',
            '**Multiplayer** – Interesse an Multiplayer Ranked',
            '',
            'Diese Rollen dienen nur der Orientierung und geben keine besonderen Rechte.',
          ].join('\n'),
        }),
      ],
      components: [
        row(
          button(roleToggleId('warzone'), 'Warzone', ButtonStyle.Secondary),
          button(roleToggleId('multiplayer'), 'Multiplayer', ButtonStyle.Secondary),
        ),
      ],
    }),
  },
  {
    key: 'faq',
    channel: 'faq',
    title: 'FAQ',
    render: (ctx) => ({
      embeds: [
        embed({
          title: 'Häufige Fragen',
          fields: [
            {
              name: 'Was bietet KSA Boosting an?',
              value: `Manuelles Ranked-Boosting für ${GAME_LABEL.warzone} und ${GAME_LABEL.multiplayer}. Jeder Auftrag wird individuell im Ticket besprochen. Wir bieten keine Cheats, keine Matchmanipulation und keine Anti-Cheat-Umgehung an.`,
            },
            {
              name: 'Was kostet ein Auftrag?',
              value: 'Preise auf Anfrage. Nach deiner Anfrage erhältst du im Ticket ein konkretes Angebot mit Umfang, Preis, geschätztem Zeitraum und Abbruchbedingungen.',
            },
            {
              name: 'Wie lange dauert ein Auftrag?',
              value: 'Das hängt vom Ausgangs- und Zielrang ab. Der geschätzte Zeitraum steht im Angebot. Eine feste Zusage über Dauer oder Ergebnis können wir nicht geben.',
            },
            {
              name: 'Wie wird bezahlt?',
              value: 'Die Zahlung wird im Ticket mit dem Team abgestimmt. Der Bot wickelt keine Zahlungen ab und speichert keine Zahlungsdaten.',
            },
            {
              name: 'Ist Boosting erlaubt? Welche Risiken gibt es?',
              value: `Ehrlich: Nach unserem Kenntnisstand führt die Sicherheits- und Durchsetzungsrichtlinie von Activision für Call of Duty Boosting als Verstoß auf. Der Accountinhaber ist demnach für Verstöße auf seinem Account verantwortlich – unabhängig davon, wer gespielt hat. Sanktionen bis hin zur Sperre sind möglich. Wir können dieses Risiko nicht ausschließen und geben keine Garantie. Lies die aktuelle Richtlinie selbst: ${ACTIVISION_POLICY_URL}`,
            },
            {
              name: 'Muss ich Zugangsdaten angeben?',
              value: NO_CREDENTIALS,
            },
            {
              name: 'Werden meine Daten veröffentlicht?',
              value: 'Nicht ohne deine ausdrückliche Zustimmung. Proofs und Bewertungen erscheinen nur nach deiner Freigabe genau der gezeigten Inhalte – standardmäßig anonym und ohne Erwähnung.',
            },
            {
              name: 'Wer kann mein Ticket sehen?',
              value: 'Du, der Support, Admins, Founder und der dir zugewiesene Operator. Hinweis: Der Serverbesitzer und Mitglieder mit Discord-Administratorrechten können technisch bedingt alle Kanäle einsehen.',
            },
            {
              name: 'Was sind Discord-Serverboosts?',
              value: `Eine Discord-Funktion, mit der Mitglieder den Server unterstützen. Sie haben nichts mit unseren Ranked-Aufträgen zu tun. Mehr in ${ch(ctx, 'server_boosten')}.`,
            },
          ],
        }),
      ],
    }),
  },
  {
    key: 'process',
    channel: 'ablauf',
    title: 'Ablauf',
    render: (ctx) => ({
      embeds: [
        embed({
          title: 'Ablauf eines Auftrags',
          description: [
            `**1. Anfrage** – Öffne in ${ch(ctx, 'ticket_erstellen')} ein Ticket für Warzone oder Multiplayer und fülle das kurze Formular aus.`,
            '**2. Angebot** – Das Team prüft deine Anfrage und schickt dir im Ticket ein konkretes Angebot: Leistungsumfang, Preis, geschätzter Zeitraum und Abbruchbedingungen.',
            '**3. Annahme** – Erst wenn du ein Angebot annimmst, entsteht ein Auftrag. Ändert sich etwas, bekommst du eine neue Angebotsversion zur erneuten Zustimmung.',
            '**4. Bearbeitung** – Ein Operator bearbeitet deinen Auftrag manuell. Status und Fortschritt siehst du im Ticket.',
            '**5. Abschluss** – Danach kannst du freiwillig eine Bewertung abgeben.',
            '**6. Proof (optional)** – Ergebnisbilder veröffentlichen wir nur mit deiner ausdrücklichen Zustimmung, standardmäßig anonym.',
            '',
            'Die Zahlung stimmt das Team mit dir im Ticket ab. Der Bot wickelt keine Zahlungen ab.',
            NO_CREDENTIALS,
          ].join('\n'),
        }),
      ],
    }),
  },
  ...(['warzone', 'multiplayer'] as const).map(
    (game): PanelDefinition => ({
      key: game === 'warzone' ? 'offer_warzone' : 'offer_multiplayer',
      channel: game,
      title: game === 'warzone' ? 'Angebot Warzone' : 'Angebot Multiplayer',
      render: (ctx) => ({
        embeds: [
          embed({
            title: GAME_LABEL[game],
            description: [
              `Manuelles Ranked-Boosting für **${GAME_LABEL[game]}**.`,
              '',
              '• Anfrage mit aktuellem Rang (optional SR), Zielrang, Plattform und Wunschzeitraum',
              '• Konkretes Angebot vor jedem Auftrag – erst nach deiner Annahme geht es los',
              '• Status und Fortschritt jederzeit im privaten Ticket',
              '',
              '**Preis auf Anfrage.**',
              rankLine(game === 'warzone' ? ctx.settings.warzoneRanks : ctx.settings.multiplayerRanks, ctx.settings.season).trim(),
              '',
              `Keine Cheats, keine Garantie auf Ergebnis oder Accountsicherheit. Hinweise zu Risiken in ${ch(ctx, 'faq')}.`,
            ]
              .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
              .join('\n'),
          }),
        ],
        components: [row(button(ticketOpenId(game), game === 'warzone' ? 'Warzone-Anfrage starten' : 'Multiplayer-Anfrage starten', ButtonStyle.Primary))],
      }),
    }),
  ),
  {
    key: 'pricing',
    channel: 'preise',
    title: 'Preise und Anfragen',
    render: (ctx) => ({
      embeds: [
        embed({
          title: 'Preise und Anfragen',
          description: [
            'Der Preis hängt von Ausgangs- und Zielrang, Plattform und Zeitraum ab. Deshalb gilt: **Preis auf Anfrage.**',
            '',
            'Du erhältst im Ticket ein individuelles Angebot, bevor ein Auftrag entsteht. Darin stehen:',
            '• Leistungsumfang',
            '• Preis und Währung',
            '• geschätzter Zeitraum',
            '• vereinbarte Abbruchbedingungen',
            '',
            '**Für ein Angebot brauchen wir:** aktuellen Rang (optional SR), Zielrang, Plattform und deinen Wunschzeitraum.',
            '',
            `Starte direkt hier oder in ${ch(ctx, 'ticket_erstellen')}. Zahlungsdaten werden nicht über den Bot erfasst.`,
          ].join('\n'),
        }),
      ],
      components: [
        row(
          button(ticketOpenId('warzone'), 'Warzone-Anfrage', ButtonStyle.Primary),
          button(ticketOpenId('multiplayer'), 'Multiplayer-Anfrage', ButtonStyle.Primary),
        ),
      ],
    }),
  },
  {
    key: 'ticket',
    channel: 'ticket_erstellen',
    title: 'Ticket erstellen',
    render: (ctx) => ({
      embeds: [
        embed({
          title: 'Ticket erstellen',
          description: [
            'Wähle dein Anliegen. Nach einem kurzen Formular erstellt der Bot einen privaten Kanal für dich und das zuständige Team.',
            '',
            '**Warzone Ranked** – Anfrage für Warzone',
            '**Multiplayer Ranked** – Anfrage für Multiplayer',
            '**Allgemeiner Support** – Fragen, Probleme und Sonstiges',
            '',
            `Pro Person sind höchstens ${ctx.settings.maxOpenTickets} offene Tickets möglich.`,
            NO_CREDENTIALS,
            '',
            '-# Der Serverbesitzer und Mitglieder mit Discord-Administratorrechten können technisch bedingt alle Kanäle einsehen.',
          ].join('\n'),
        }),
      ],
      components: [
        row(
          button(ticketOpenId('warzone'), 'Warzone Ranked', ButtonStyle.Primary),
          button(ticketOpenId('multiplayer'), 'Multiplayer Ranked', ButtonStyle.Primary),
          button(ticketOpenId('support'), 'Allgemeiner Support', ButtonStyle.Secondary),
        ),
      ],
    }),
  },
  {
    key: 'boost_info',
    channel: 'server_boosten',
    title: 'Serverboost-Informationen',
    render: (ctx) => {
      const perks: string[] = [];
      if (ctx.booster.roleId) {
        perks.push(
          ctx.booster.hoist
            ? `• Rolle <@&${ctx.booster.roleId}>, die in der Mitgliederliste separat angezeigt wird`
            : `• Rolle <@&${ctx.booster.roleId}>`,
        );
      }
      perks.push(`• Eine Danksagung in ${ch(ctx, 'boost_danke')}`);
      for (const p of ctx.settings.extraBoostPerks) perks.push(`• ${p}`);
      return {
        embeds: [
          embed({
            title: 'Discord-Serverboosts',
            color: COLORS.booster,
            description: [
              '**Was ist ein Serverboost?**',
              'Ein Serverboost ist eine Funktion von Discord. Mitglieder mit Nitro oder separat erworbenen Boosts können einen Server boosten und damit Discord-Serverstufen freischalten, etwa mehr Emoji-Plätze oder bessere Audioqualität. Bedingungen und Preise legt ausschließlich Discord fest.',
              '',
              '**So boostest du KSA Boosting**',
              'Am PC: oben links auf den Servernamen **KSA Boosting** klicken und **Server boosten** wählen.',
              'Am Handy: Servernamen antippen und **Boost** wählen.',
              `Details und aktuelle Bedingungen: ${DISCORD_BOOST_HELP_URL}`,
              '',
              '**Was bei uns tatsächlich eingerichtet ist**',
              ...perks,
              '',
              '**Wichtig:** Serverboosts sind freiwillig und vollständig getrennt von unseren Ranked-Aufträgen. Sie sind keine Zahlung für Aufträge und führen nicht automatisch zu Rabatten. Teile niemals Nitro-, Konto- oder Zahlungsdaten.',
            ].join('\n'),
          }),
        ],
      };
    },
  },
  {
    key: 'proofs_info',
    channel: 'proofs',
    title: 'Proof-Erklärung',
    render: () => ({
      embeds: [
        embed({
          title: 'Proofs',
          description: [
            'Hier zeigen wir Ergebnisse abgeschlossener Aufträge.',
            '',
            '• Jeder Proof gehört zu einem abgeschlossenen Auftrag.',
            '• Veröffentlicht wird nur, wenn der Kunde genau diese Bilder und Angaben freigegeben hat – standardmäßig anonym.',
            '• Das Team prüft die Bilder vorher auf persönliche Daten; technische Bild-Metadaten werden entfernt.',
            '• Preise, Ticket-Links und interne Notizen werden nie veröffentlicht.',
            '• Kunden können ihre Freigabe widerrufen; der Beitrag wird dann entfernt. Bereits von Dritten gespeicherte Kopien können wir nicht löschen.',
          ].join('\n'),
        }),
      ],
    }),
  },
  {
    key: 'reviews_info',
    channel: 'bewertungen',
    title: 'Bewertungen',
    render: () => ({
      embeds: [
        embed({
          title: 'Bewertungen',
          description: [
            'Bewertungen stammen ausschließlich von Kunden mit verifiziertem, abgeschlossenem Auftrag – eine Bewertung pro Auftrag.',
            '',
            '• 1 bis 5 Sterne, optional mit Text',
            '• Veröffentlichung nur mit ausdrücklicher Zustimmung – anonym oder mit Anzeigenamen',
            '• Die Moderation kann problematische Texte ausblenden, ändert aber keine Sterne',
          ].join('\n'),
        }),
      ],
    }),
  },
  {
    key: 'orders_overview',
    channel: 'auftraege',
    title: 'Auftragsübersicht',
    live: true,
    render: () => ({
      embeds: [embed({ title: 'Auftragsübersicht', description: 'Noch keine aktiven Aufträge.', color: COLORS.neutral })],
    }),
  },
];

export function panelDefinition(key: PanelKey): PanelDefinition {
  const p = PANELS.find((x) => x.key === key);
  if (!p) throw new Error(`Unbekanntes Panel ${key}`);
  return p;
}
