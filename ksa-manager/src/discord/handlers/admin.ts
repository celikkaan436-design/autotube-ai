import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';
import { formatSettingValue, isSettingKey, parseSettingInput, type SettingKey } from '../../config/settings.js';
import { PANEL_KEYS, type PanelKey } from '../../content/panels.js';
import { schemaVersion } from '../../db/database.js';
import { COLORS } from '../../domain/constants.js';
import { argStr, cid, type ParsedId } from '../../domain/customId.js';
import { assertAllowed, LEVEL_LABEL, resolveLevel, atLeast } from '../../domain/permissions.js';
import { authConfig } from '../../services/context.js';
import { describePlanItem, type PlanItem } from '../../setup/planner.js';
import { UserError } from '../../util/errors.js';
import { truncate } from '../../util/text.js';
import { discordTimestamp } from '../../util/time.js';
import { actorOf, deferEphemeral, respond, updateMessage, type HandlerDeps } from '../interactions.js';
import { button, ButtonStyle, embed, row } from '../ui.js';

const OP_GROUP: Record<PlanItem['op'], string> = {
  create_role: 'Rollen erstellen',
  adopt_role: 'Rollen übernehmen',
  link_managed_booster: 'Booster-Rolle verknüpfen',
  reorder_roles: 'Rollenreihenfolge',
  create_category: 'Kategorien erstellen',
  adopt_category: 'Kategorien übernehmen',
  create_channel: 'Kanäle erstellen',
  adopt_channel: 'Kanäle übernehmen',
  fix_channel: 'Korrekturen',
  assign_founder_role: 'Founder-Rolle',
  post_panel: 'Panels posten',
  update_panel: 'Panels aktualisieren',
  create_automod: 'AutoMod',
  adopt_automod: 'AutoMod übernehmen',
  set_afk: 'AFK-Kanal',
};

export async function setupStart(i: ChatInputCommandInteraction, d: HandlerDeps): Promise<void> {
  await deferEphemeral(i);
  const options = { correct: i.options.getBoolean('korrigieren') ?? false, adoptForeign: i.options.getBoolean('fremde_uebernehmen') ?? false };
  const { planId, plan, expiresAt } = await d.s.setup.preview(actorOf(i), i.guildId!, options);
  const groups = new Map<string, string[]>();
  for (const item of plan.items) {
    const g = OP_GROUP[item.op];
    groups.set(g, [...(groups.get(g) ?? []), describePlanItem(item)]);
  }
  const fields = [...groups.entries()].map(([name, lines]) => ({
    name: `${name} (${lines.length})`,
    value: truncate(lines.map((l) => `• ${l}`).join('\n'), 1000),
  }));
  const blocked = plan.blockers.length > 0;
  const nothing = plan.items.length === 0;
  const embeds = [
    embed({
      title: 'Setup-Vorschau – KSA Boosting',
      description: [
        nothing ? 'Alles ist eingerichtet – es sind keine Änderungen nötig.' : `Geplante Änderungen: **${plan.items.length}**. Bestehende Inhalte werden nicht gelöscht.`,
        `Diese Vorschau gilt nur für dich und läuft ${discordTimestamp(expiresAt, 'R')} ab.`,
        `Optionen: Korrigieren ${options.correct ? 'ja' : 'nein'} · Fremde übernehmen ${options.adoptForeign ? 'ja' : 'nein'}`,
      ].join('\n'),
      fields: fields.slice(0, 20),
    }),
  ];
  if (plan.blockers.length) embeds.push(embed({ title: 'Blockiert – zuerst beheben', description: truncate(plan.blockers.map((b) => `• ${b}`).join('\n'), 4000), color: COLORS.accentDark }));
  if (plan.warnings.length) embeds.push(embed({ title: 'Hinweise', description: truncate(plan.warnings.map((w) => `• ${w}`).join('\n'), 4000), color: COLORS.warning }));
  await respond(i, {
    embeds,
    components: [
      row(
        button(cid('su', 'ok', planId, plan.hash.slice(0, 16)), 'Bestätigen und ausführen', ButtonStyle.Danger, blocked || nothing),
        button(cid('su', 'no', planId), 'Abbrechen', ButtonStyle.Secondary),
      ),
    ],
  });
}

export async function setupConfirm(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const planId = argStr(p, 0);
  const hash = argStr(p, 1);
  if (!planId || !hash) throw new UserError('Ungültige Bestätigung.');
  await updateMessage(i, { embeds: [embed({ title: 'Setup läuft …', description: 'Rollen, Kanäle und Panels werden angelegt. Das kann eine Minute dauern.', color: COLORS.warning })] });
  const { result } = await d.s.setup.confirm(actorOf(i), i.guildId!, planId, hash);
  const lines = [
    `Erledigt: **${result.done.length}** · Fehler: **${result.failed.length}** · Übersprungen: **${result.skipped.length}**`,
    result.failed.length ? 'Fehlgeschlagene Schritte kannst du nach Behebung der Ursache mit `/setup start` fortsetzen – bereits erstellte Ressourcen werden wiederverwendet.' : '',
  ].filter(Boolean);
  const embeds = [embed({ title: result.failed.length ? 'Setup mit Fehlern beendet' : 'Setup abgeschlossen', description: lines.join('\n'), color: result.failed.length ? COLORS.warning : COLORS.success })];
  if (result.failed.length) embeds.push(embed({ title: 'Fehler', description: truncate(result.failed.map((f) => `• ${f.item}: ${f.error}`).join('\n'), 4000), color: COLORS.accentDark }));
  if (result.skipped.length) embeds.push(embed({ title: 'Übersprungen', description: truncate(result.skipped.map((s) => `• ${s}`).join('\n'), 4000), color: COLORS.muted }));
  await i.editReply({ embeds, components: [] });
  await d.ctx.audit.botStatus('Setup ausgeführt', [`Durch <@${i.user.id}>: ${result.done.length} erledigt, ${result.failed.length} Fehler, ${result.skipped.length} übersprungen.`]);
}

export async function setupCancel(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const planId = argStr(p, 0);
  if (!planId) throw new UserError('Ungültige Vorschau.');
  d.s.setup.cancel(actorOf(i), planId);
  await updateMessage(i, { embeds: [embed({ description: 'Setup abgebrochen. Es wurde nichts verändert.', color: COLORS.muted })] });
}

export async function setupDiagnose(i: ChatInputCommandInteraction, d: HandlerDeps): Promise<void> {
  await deferEphemeral(i);
  const r = await d.s.setup.diagnose(actorOf(i), i.guildId!);
  const embeds = [embed({ title: 'Diagnose', description: r.ok.map((l) => `✓ ${l}`).join('\n') || '–', color: r.problems.length ? COLORS.warning : COLORS.success })];
  if (r.problems.length) embeds.push(embed({ title: `Probleme (${r.problems.length})`, description: truncate(r.problems.map((l) => `• ${l}`).join('\n'), 4000), color: COLORS.accentDark }));
  if (r.hints.length) embeds.push(embed({ title: 'Hinweise', description: truncate(r.hints.map((l) => `• ${l}`).join('\n'), 4000), color: COLORS.muted }));
  await respond(i, { embeds });
}

export async function health(i: ChatInputCommandInteraction, d: HandlerDeps): Promise<void> {
  assertAllowed(actorOf(i), authConfig(d.ctx), 'health.view');
  const db = d.ctx.db;
  const count = (sql: string) => (db.prepare<[string], { n: number }>(sql).get(d.ctx.config.guildId)?.n ?? 0);
  const quick = db.prepare<[], { quick_check: string }>('PRAGMA quick_check').get()?.quick_check ?? 'unbekannt';
  const resources = d.ctx.registry.all();
  const lines = [
    `**Version:** KSA Manager ${d.versions.app} · Node ${d.versions.node} · discord.js ${d.versions.discordJs}`,
    `**Online seit:** ${discordTimestamp(d.startedAt, 'R')} · Gateway-Ping: ${d.gatewayPing()} ms`,
    `**Datenbank:** Schema v${schemaVersion(db)} · Integrität: ${quick}`,
    `**Setup:** ${resources.filter((r) => r.status === 'done').length} Ressourcen eingerichtet, ${resources.filter((r) => r.status === 'failed').length} fehlerhaft`,
    `**Intents:** Server Members ${d.intents.guildMembers ? 'an' : 'aus'} · Guild Messages ${d.intents.guildMessages ? 'an' : 'aus'} · Message Content ${d.intents.messageContent ? 'an' : 'aus'}`,
    `**Offene Tickets:** ${count("SELECT COUNT(*) AS n FROM tickets WHERE guild_id = ? AND status = 'open'")} · **Aktive Aufträge:** ${count("SELECT COUNT(*) AS n FROM orders WHERE guild_id = ? AND status NOT IN ('abgeschlossen','storniert')")}`,
    `**Proofs wartend:** ${count("SELECT COUNT(*) AS n FROM proofs WHERE guild_id = ? AND status IN ('pending','declined','publishing')")} · **Boost-Ereignisse ausstehend:** ${count("SELECT COUNT(*) AS n FROM boost_events WHERE guild_id = ? AND status = 'pending'")}`,
  ];
  await respond(i, { embeds: [embed({ title: 'Bot-Status', description: lines.join('\n'), color: quick === 'ok' ? COLORS.success : COLORS.warning })] });
}

const HELP: { min: 'member' | 'operator' | 'support' | 'admin' | 'founder'; lines: string[] }[] = [
  {
    min: 'member',
    lines: [
      '`/help` – diese Übersicht',
      '`/ticket liste` · `/ticket info` · `/ticket schliessen` · `/ticket export` – eigene Tickets',
      '`/angebot ansehen` – Angebotsversionen im eigenen Ticket',
      '`/auftrag ansehen` · `/auftrag liste` – eigene Aufträge',
      '`/bewertung abgeben` · `/bewertung zurueckziehen` – Bewertungen',
      '`/proof widerrufen` – Freigabe eines Proofs widerrufen',
    ],
  },
  {
    min: 'operator',
    lines: [
      '`/auftrag status` · `/auftrag fortschritt` · `/auftrag notiz` – nur zugewiesene Aufträge',
      'Kontextmenü **Apps → Als Proof einreichen** oder `/proof einreichen` – nur im zugewiesenen Ticket',
    ],
  },
  {
    min: 'support',
    lines: [
      '`/ticket uebernehmen` · `/ticket zuweisen` · `/ticket wiedereroeffnen` · `/ticket export art:Intern`',
      '`/angebot erstellen` · `/angebot zurueckziehen`',
      '`/proof pruefen` · `/proof freigeben` · `/proof veroeffentlichen`',
      '`/bewertung ausblenden` · `/bewertung einblenden` · `/health`',
    ],
  },
  { min: 'admin', lines: ['`/auftrag zahlung` – manuelle Zahlungsbestätigung', '`/proof zuruecknehmen` · `/panel aktualisieren` · `/setup diagnose`', '`/serverboost status` · `/serverboost sync` · `/config anzeigen`'] },
  { min: 'founder', lines: ['`/setup start` – Servereinrichtung mit Vorschau', '`/config setzen` · `/config zuruecksetzen` · `/serverboost rollenmodus`'] },
];

export async function help(i: ChatInputCommandInteraction, d: HandlerDeps): Promise<void> {
  const level = resolveLevel(actorOf(i), authConfig(d.ctx));
  const fields = HELP.filter((h) => atLeast(level, h.min)).map((h) => ({ name: h.min === 'member' ? 'Für alle' : `Ab ${LEVEL_LABEL[h.min]}`, value: h.lines.join('\n') }));
  await respond(i, {
    embeds: [
      embed({
        title: 'KSA Manager – Hilfe',
        description: `Deine Stufe im Bot: **${LEVEL_LABEL[level]}**. Jede Aktion wird serverseitig geprüft.\nAnfragen startest du über die Buttons in 🎫・ticket-erstellen.`,
        fields,
      }),
    ],
  });
}

export async function panelRefresh(i: ChatInputCommandInteraction, d: HandlerDeps): Promise<void> {
  await deferEphemeral(i);
  const choice = i.options.getString('panel', true);
  const keys: PanelKey[] | 'all' = choice === 'alle' ? 'all' : (PANEL_KEYS as readonly string[]).includes(choice) ? [choice as PanelKey] : [];
  if (keys !== 'all' && keys.length === 0) throw new UserError('Unbekanntes Panel.');
  const lines = await d.s.setup.refreshPanels(actorOf(i), keys);
  await respond(i, { embeds: [embed({ title: 'Panels', description: truncate(lines.join('\n'), 4000) })] });
}

const PANEL_AFFECTING: SettingKey[] = [
  'tickets.maxOpenPerUser',
  'games.warzone.ranks',
  'games.multiplayer.ranks',
  'games.season',
  'boost.extraPerks',
  'community.requireRulesAcceptance',
];

export async function config(i: ChatInputCommandInteraction, d: HandlerDeps): Promise<void> {
  const sub = i.options.getSubcommand();
  const actor = actorOf(i);
  if (sub === 'anzeigen') {
    assertAllowed(actor, authConfig(d.ctx), 'config.read');
    const rows = d.ctx.settings.all();
    const text = rows.map((r) => `\`${r.key}\` = **${truncate(formatSettingValue(r.value), 120)}**${r.isDefault ? ' (Standard)' : ''}\n-# ${r.label}`).join('\n');
    await respond(i, { embeds: [embed({ title: 'Einstellungen', description: truncate(text, 4000) })] });
    return;
  }
  assertAllowed(actor, authConfig(d.ctx), 'config.write');
  const key = i.options.getString('schluessel', true);
  if (!isSettingKey(key)) throw new UserError('Unbekannte Einstellung.');
  if (sub === 'setzen') {
    const value = parseSettingInput(key, i.options.getString('wert', true));
    d.ctx.settings.set(key, value as never, actor.userId);
    d.ctx.audit.record(actor.userId, 'config.set', { type: 'setting', id: key });
  } else {
    d.ctx.settings.reset(key);
    d.ctx.audit.record(actor.userId, 'config.reset', { type: 'setting', id: key });
  }
  const hint = PANEL_AFFECTING.includes(key)
    ? key === 'community.requireRulesAcceptance'
      ? '\nDamit die Kanalrechte angepasst werden: `/setup start korrigieren:true`, danach `/panel aktualisieren panel:alle`.'
      : '\nPanels mit `/panel aktualisieren panel:alle` neu rendern.'
    : '';
  await respond(i, { embeds: [embed({ description: `\`${key}\` ist jetzt **${formatSettingValue(d.ctx.settings.get(key))}**.${hint}`, color: COLORS.success })] });
}
