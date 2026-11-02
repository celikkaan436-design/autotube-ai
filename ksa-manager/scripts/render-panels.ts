import { writeFileSync } from 'node:fs';
import type { APIEmbed } from 'discord.js';
import { PANELS, type PanelContext } from '../src/content/panels.js';
import { CHANNELS } from '../src/setup/blueprint.js';

/**
 * Erzeugt docs/PANELS.md direkt aus dem Code, der die Panels beim Setup postet.
 * Kanal-/Rollen-Erwähnungen werden durch ihre Namen ersetzt. Keine Kundendaten.
 */
const ctx: PanelContext = {
  guildId: '0',
  channels: {},
  roles: {},
  booster: { roleId: 'BOOSTER', hoist: true, managed: false },
  settings: { maxOpenTickets: 2, requireRulesAcceptance: true, warzoneRanks: [], multiplayerRanks: [], season: '', extraBoostPerks: [] },
};

function md(e: APIEmbed): string {
  const out: string[] = [];
  if (e.title) out.push(`**${e.title}**`, '');
  if (e.description) out.push(e.description.replace(/<@&BOOSTER>/g, '@Server Booster'), '');
  for (const f of e.fields ?? []) out.push(`**${f.name}**`, f.value, '');
  if (e.footer?.text) out.push(`_${e.footer.text}_`);
  return out
    .join('\n')
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n');
}

const parts: string[] = [
  '# Panel-Ansichten (automatisch erzeugt)',
  '',
  'Diese Datei wird mit `npm run panels:render` aus dem echten Panel-Code erzeugt. Sie zeigt die Texte so, wie das Setup sie postet (Standard-Einstellungen, Regelbestätigung aktiv). Kanal-Erwähnungen erscheinen in Discord als klickbare Links.',
  '',
];
for (const p of PANELS) {
  const channel = CHANNELS.find((c) => c.key === p.channel)?.name ?? p.channel;
  const payload = p.render(ctx);
  parts.push(`## ${p.title} – \`${channel}\``, '');
  for (const e of payload.embeds ?? []) parts.push(md(e), '');
  const buttons = (payload.components ?? []).flatMap((r) => r.components).map((c) => ('label' in c && c.label ? `[${c.label}]` : '')).filter(Boolean);
  if (buttons.length) parts.push(`Buttons: ${buttons.join(' ')}`, '');
  if (p.live) parts.push('_Live-Panel: wird vom Bot laufend aktualisiert._', '');
}
writeFileSync('docs/PANELS.md', parts.join('\n'));
console.log('docs/PANELS.md geschrieben');
