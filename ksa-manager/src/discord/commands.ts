import {
  ApplicationCommandType,
  ApplicationIntegrationType,
  ContextMenuCommandBuilder,
  InteractionContextType,
  SlashCommandBuilder,
  type RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js';
import { SETTING_KEYS } from '../config/settings.js';
import { PANELS } from '../content/panels.js';
import { CURRENCIES, ORDER_STATUSES, PAYMENT_STATUS_LABEL, PAYMENT_STATUSES, PROCESS_STATUS_LABEL } from '../domain/constants.js';

export const PROOF_CONTEXT_MENU = 'Als Proof einreichen';

function base(name: string, description: string): SlashCommandBuilder {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);
}

/**
 * Alle Befehle werden nur auf dem Zielserver registriert. Sichtbarkeit ist KEINE
 * Berechtigung – jede Ausführung wird serverseitig autorisiert.
 */
export function commandDefinitions(): RESTPostAPIApplicationCommandsJSONBody[] {
  const setup = base('setup', 'Server automatisch einrichten (nur Founder)')
    .addSubcommand((s) =>
      s
        .setName('start')
        .setDescription('Vorschau aller geplanten Änderungen anzeigen und bestätigen')
        .addBooleanOption((o) => o.setName('korrigieren').setDescription('Verschobene/umbenannte Kanäle und abweichende Rechte bot-eigener Ressourcen korrigieren'))
        .addBooleanOption((o) => o.setName('fremde_uebernehmen').setDescription('Gleichnamige, nicht vom Bot erstellte Rollen/Kanäle nach Bestätigung übernehmen')),
    )
    .addSubcommand((s) => s.setName('diagnose').setDescription('Fehlende Rechte sowie gelöschte oder verschobene Ressourcen prüfen'));

  const health = base('health', 'Zustand des Bots anzeigen (Team)');
  const help = base('help', 'Verfügbare Befehle anzeigen');

  const panel = base('panel', 'Panels verwalten (Admin)').addSubcommand((s) =>
    s
      .setName('aktualisieren')
      .setDescription('Panel neu rendern oder neu posten')
      .addStringOption((o) =>
        o
          .setName('panel')
          .setDescription('Welches Panel')
          .setRequired(true)
          .addChoices({ name: 'alle', value: 'alle' }, ...PANELS.map((p) => ({ name: p.title, value: p.key }))),
      ),
  );

  const keyChoices = SETTING_KEYS.map((k) => ({ name: k, value: k }));
  const config = base('config', 'Einstellungen (Founder)')
    .addSubcommand((s) => s.setName('anzeigen').setDescription('Alle Einstellungen anzeigen'))
    .addSubcommand((s) =>
      s
        .setName('setzen')
        .setDescription('Einstellung ändern')
        .addStringOption((o) => o.setName('schluessel').setDescription('Einstellung').setRequired(true).addChoices(...keyChoices))
        .addStringOption((o) => o.setName('wert').setDescription('Neuer Wert (Listen kommagetrennt, „-“ = leer)').setRequired(true).setMaxLength(1000)),
    )
    .addSubcommand((s) =>
      s
        .setName('zuruecksetzen')
        .setDescription('Einstellung auf Standard zurücksetzen')
        .addStringOption((o) => o.setName('schluessel').setDescription('Einstellung').setRequired(true).addChoices(...keyChoices)),
    );

  const ticket = base('ticket', 'Tickets verwalten')
    .addSubcommand((s) => s.setName('info').setDescription('Ticketinformationen anzeigen').addIntegerOption((o) => o.setName('nummer').setDescription('Ticketnummer (sonst aktuelles Ticket)').setMinValue(1)))
    .addSubcommand((s) => s.setName('uebernehmen').setDescription('Aktuelles Ticket übernehmen (Support)'))
    .addSubcommand((s) =>
      s.setName('zuweisen').setDescription('Operator zuweisen (Support)').addUserOption((o) => o.setName('operator').setDescription('Mitglied mit Rolle KSA Operator').setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName('schliessen').setDescription('Aktuelles Ticket schließen').addStringOption((o) => o.setName('grund').setDescription('Optionaler Grund').setMaxLength(300)),
    )
    .addSubcommand((s) =>
      s
        .setName('wiedereroeffnen')
        .setDescription('Geschlossenes Ticket wiedereröffnen (Support)')
        .addIntegerOption((o) => o.setName('nummer').setDescription('Ticketnummer').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName('export')
        .setDescription('Privaten Ticket-Export erhalten')
        .addIntegerOption((o) => o.setName('nummer').setDescription('Ticketnummer (sonst aktuelles Ticket)').setMinValue(1))
        .addStringOption((o) =>
          o.setName('art').setDescription('Kundenexport oder interner Export (Team)').addChoices({ name: 'Kunde', value: 'customer' }, { name: 'Intern (Team)', value: 'internal' }),
        ),
    )
    .addSubcommand((s) => s.setName('liste').setDescription('Offene Tickets anzeigen (Support) bzw. eigene Tickets'));

  const angebot = base('angebot', 'Angebote')
    .addSubcommand((s) =>
      s
        .setName('erstellen')
        .setDescription('Angebot im aktuellen Ticket erstellen und senden (Support)')
        .addStringOption((o) => o.setName('ausgangsrang').setDescription('Ausgangsrang').setRequired(true).setMaxLength(100))
        .addStringOption((o) => o.setName('ziel').setDescription('Zielrang / Ziel').setRequired(true).setMaxLength(100))
        .addStringOption((o) => o.setName('umfang').setDescription('Leistungsumfang').setRequired(true).setMaxLength(1000))
        .addStringOption((o) => o.setName('preis').setDescription('Preis, z. B. 49,99').setRequired(true).setMaxLength(20))
        .addStringOption((o) => o.setName('zeitraum').setDescription('Geschätzter Zeitraum').setRequired(true).setMaxLength(100))
        .addStringOption((o) => o.setName('abbruchbedingungen').setDescription('Vereinbarte Abbruchbedingungen').setRequired(true).setMaxLength(1000))
        .addStringOption((o) => o.setName('waehrung').setDescription('Währung').addChoices(...CURRENCIES.map((c) => ({ name: c, value: c })))),
    )
    .addSubcommand((s) => s.setName('ansehen').setDescription('Angebotsversionen dieses Tickets anzeigen'))
    .addSubcommand((s) => s.setName('zurueckziehen').setDescription('Offenes Angebot zurückziehen (Support)'));

  const idOpt = (o: import('discord.js').SlashCommandIntegerOption) => o.setName('id').setDescription('Auftrags-ID (sonst Auftrag dieses Tickets)').setMinValue(1);
  const auftrag = base('auftrag', 'Aufträge')
    .addSubcommand((s) => s.setName('ansehen').setDescription('Auftrag anzeigen').addIntegerOption(idOpt))
    .addSubcommand((s) =>
      s
        .setName('status')
        .setDescription('Status ändern')
        .addStringOption((o) =>
          o.setName('status').setDescription('Neuer Status').setRequired(true).addChoices(...ORDER_STATUSES.filter((x) => x !== 'angebot_angenommen').map((x) => ({ name: PROCESS_STATUS_LABEL[x], value: x }))),
        )
        .addIntegerOption(idOpt),
    )
    .addSubcommand((s) =>
      s
        .setName('fortschritt')
        .setDescription('Fortschritt melden (für den Kunden sichtbar)')
        .addIntegerOption((o) => o.setName('prozent').setDescription('0–100').setRequired(true).setMinValue(0).setMaxValue(100))
        .addStringOption((o) => o.setName('text').setDescription('Kurze Meldung für den Kunden').setMaxLength(500))
        .addIntegerOption(idOpt),
    )
    .addSubcommand((s) =>
      s
        .setName('zahlung')
        .setDescription('Zahlungsstatus manuell setzen (Admin) – keine Zahlungsdaten eingeben')
        .addStringOption((o) => o.setName('status').setDescription('Zahlungsstatus').setRequired(true).addChoices(...PAYMENT_STATUSES.map((p) => ({ name: PAYMENT_STATUS_LABEL[p], value: p }))))
        .addIntegerOption(idOpt),
    )
    .addSubcommand((s) =>
      s
        .setName('notiz')
        .setDescription('Interne Notiz hinzufügen (nie für Kunden sichtbar)')
        .addStringOption((o) => o.setName('text').setDescription('Notiz').setRequired(true).setMaxLength(1500))
        .addIntegerOption(idOpt),
    )
    .addSubcommand((s) => s.setName('liste').setDescription('Aktive Aufträge anzeigen'));

  const pid = (o: import('discord.js').SlashCommandIntegerOption) => o.setName('id').setDescription('Proof-ID').setRequired(true).setMinValue(1);
  const proof = base('proof', 'Proofs')
    .addSubcommand((s) =>
      s
        .setName('einreichen')
        .setDescription('Ticketnachricht mit Bildern als Proof einreichen (Link oder ID)')
        .addStringOption((o) => o.setName('nachricht').setDescription('Nachrichtenlink oder -ID aus diesem Ticket').setRequired(true).setMaxLength(200)),
    )
    .addSubcommand((s) => s.setName('pruefen').setDescription('Status eines Proofs anzeigen').addIntegerOption(pid))
    .addSubcommand((s) => s.setName('freigeben').setDescription('Team-Freigabe der aktuellen Version (Support)').addIntegerOption(pid))
    .addSubcommand((s) => s.setName('veroeffentlichen').setDescription('Veröffentlichung erneut anstoßen, falls alle Freigaben vorliegen').addIntegerOption(pid))
    .addSubcommand((s) =>
      s
        .setName('zuruecknehmen')
        .setDescription('Veröffentlichten Proof entfernen (Admin)')
        .addIntegerOption(pid)
        .addStringOption((o) => o.setName('grund').setDescription('Grund (Audit)').setRequired(true).setMaxLength(300)),
    )
    .addSubcommand((s) => s.setName('widerrufen').setDescription('Eigene Freigabe widerrufen (Kunde)').addIntegerOption(pid));

  const bewertung = base('bewertung', 'Bewertungen')
    .addSubcommand((s) =>
      s.setName('abgeben').setDescription('Abgeschlossenen Auftrag bewerten').addIntegerOption((o) => o.setName('auftrag').setDescription('Auftrags-ID').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName('ausblenden')
        .setDescription('Text einer Bewertung ausblenden (Moderation, Sterne bleiben)')
        .addIntegerOption((o) => o.setName('id').setDescription('Bewertungs-ID').setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName('grund').setDescription('Grund (Audit)').setRequired(true).setMaxLength(300)),
    )
    .addSubcommand((s) =>
      s.setName('einblenden').setDescription('Ausgeblendeten Text wieder anzeigen').addIntegerOption((o) => o.setName('id').setDescription('Bewertungs-ID').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s.setName('zurueckziehen').setDescription('Eigene veröffentlichte Bewertung entfernen').addIntegerOption((o) => o.setName('id').setDescription('Bewertungs-ID').setRequired(true).setMinValue(1)),
    );

  const serverboost = base('serverboost', 'Discord-Serverboosts (getrennt von Ranked-Aufträgen)')
    .addSubcommand((s) => s.setName('status').setDescription('Boost-Erkennung und Rollen diagnostizieren (Admin)'))
    .addSubcommand((s) => s.setName('sync').setDescription('Eigene Booster-Rolle mit dem Boost-Status abgleichen (Admin)'))
    .addSubcommand((s) =>
      s
        .setName('rollenmodus')
        .setDescription('Verwaltete Discord-Rolle oder eigene Rolle verwenden (Founder)')
        .addStringOption((o) => o.setName('modus').setDescription('Modus').setRequired(true).addChoices({ name: 'verwaltet (Discord-Rolle)', value: 'managed' }, { name: 'eigene Rolle', value: 'custom' })),
    );

  const contextMenu = new ContextMenuCommandBuilder()
    .setName(PROOF_CONTEXT_MENU)
    .setType(ApplicationCommandType.Message)
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

  return [setup, health, help, panel, config, ticket, angebot, auftrag, proof, bewertung, serverboost].map((c) => c.toJSON() as RESTPostAPIApplicationCommandsJSONBody).concat([contextMenu.toJSON()]);
}
