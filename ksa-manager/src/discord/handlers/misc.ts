import type { ButtonInteraction, ChatInputCommandInteraction, ModalSubmitInteraction, StringSelectMenuInteraction } from 'discord.js';
import { COLORS } from '../../domain/constants.js';
import { argInt, argStr, cid, type ParsedId } from '../../domain/customId.js';
import type { ReviewPublication } from '../../services/reviews.js';
import { UserError } from '../../util/errors.js';
import { truncate } from '../../util/text.js';
import { actorOf, deferEphemeral, respond, updateMessage, type HandlerDeps } from '../interactions.js';
import { button, ButtonStyle, embed, modal, row, stringSelect } from '../ui.js';

// ------------------------------------------------------------------ Bewertungen
// Der Zwischenstand (Sterne, Veröffentlichung) steckt in den Custom-IDs – dadurch
// funktioniert der Ablauf auch nach einem Neustart.

const PUB_CODES: Record<string, ReviewPublication> = { none: 'none', anon: 'anonymous', name: 'display_name' };

function starsPayload(orderId: number) {
  return {
    embeds: [embed({ title: `Bewertung für Auftrag #${orderId}`, description: 'Schritt 1 von 2: Wie viele Sterne vergibst du?' })],
    components: [
      row(
        stringSelect(
          cid('rv', 'stars', orderId),
          'Sterne wählen',
          [5, 4, 3, 2, 1].map((n) => ({ label: `${'★'.repeat(n)}${'☆'.repeat(5 - n)}  ${n} von 5`, value: String(n) })),
        ),
      ),
    ],
  };
}

export async function reviewStart(i: ButtonInteraction | ChatInputCommandInteraction, orderId: number, d: HandlerDeps): Promise<void> {
  d.s.reviews.assertCanReview(actorOf(i), orderId);
  await respond(i, starsPayload(orderId));
}

export async function reviewStartButton(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const orderId = argInt(p, 0);
  if (!orderId) throw new UserError('Ungültiger Auftrag.');
  await reviewStart(i, orderId, d);
}

export async function reviewStars(i: StringSelectMenuInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const orderId = argInt(p, 0);
  const stars = Number(i.values[0]);
  if (!orderId || !Number.isInteger(stars) || stars < 1 || stars > 5) throw new UserError('Ungültige Auswahl.');
  d.s.reviews.assertCanReview(actorOf(i), orderId);
  await updateMessage(i, {
    embeds: [
      embed({
        title: `Bewertung für Auftrag #${orderId} – ${stars}/5 Sterne`,
        description: 'Schritt 2 von 2: Darf deine Bewertung in ⭐・bewertungen veröffentlicht werden? Ohne Zustimmung bleibt sie privat beim Team.',
      }),
    ],
    components: [
      row(
        stringSelect(cid('rv', 'pub', orderId, stars), 'Veröffentlichung wählen', [
          { label: 'Nicht veröffentlichen', value: 'none' },
          { label: 'Anonym veröffentlichen', value: 'anon', description: 'als „Verifizierter Kunde“' },
          { label: 'Mit meinem Anzeigenamen veröffentlichen', value: 'name' },
        ]),
      ),
    ],
  });
}

export async function reviewPublication(i: StringSelectMenuInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const orderId = argInt(p, 0);
  const stars = argInt(p, 1);
  const pub = i.values[0];
  if (!orderId || !stars || !pub || !(pub in PUB_CODES)) throw new UserError('Ungültige Auswahl.');
  d.s.reviews.assertCanReview(actorOf(i), orderId);
  const label = pub === 'none' ? 'nicht veröffentlichen' : pub === 'anon' ? 'anonym veröffentlichen' : 'mit Anzeigenamen veröffentlichen';
  await updateMessage(i, {
    embeds: [embed({ title: `Bewertung für Auftrag #${orderId}`, description: `**${stars}/5 Sterne** · ${label}.\nMöchtest du einen kurzen Text hinzufügen?` })],
    components: [
      row(
        button(cid('rv', 'text', orderId, stars, pub), 'Text hinzufügen', ButtonStyle.Primary),
        button(cid('rv', 'send', orderId, stars, pub), 'Ohne Text absenden', ButtonStyle.Success),
      ),
    ],
  });
}

export async function reviewTextButton(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const orderId = argInt(p, 0);
  const stars = argInt(p, 1);
  const pub = argStr(p, 2);
  if (!orderId || !stars || !pub || !(pub in PUB_CODES)) throw new UserError('Ungültige Auswahl.');
  d.s.reviews.assertCanReview(actorOf(i), orderId);
  await i.showModal(
    modal(cid('rv', 'modal', orderId, stars, pub), `Bewertung – ${stars}/5 Sterne`, [
      { id: 'text', label: 'Dein Text (optional)', style: 'paragraph', required: false, maxLength: 1000, description: 'Bitte keine persönlichen Daten oder Zugangsdaten.' },
    ]),
  );
}

async function submitReview(i: ButtonInteraction | ModalSubmitInteraction, p: ParsedId, d: HandlerDeps, text: string | null): Promise<void> {
  const orderId = argInt(p, 0);
  const stars = argInt(p, 1);
  const pub = argStr(p, 2);
  if (!orderId || !stars || !pub || !(pub in PUB_CODES)) throw new UserError('Ungültige Auswahl.');
  const review = await d.s.reviews.submit(actorOf(i), orderId, { stars, text, publication: PUB_CODES[pub]! });
  await updateMessage(i, {
    embeds: [
      embed({
        title: 'Danke für deine Bewertung',
        description: review.public_message_id
          ? `Deine Bewertung (#${review.id}) wurde veröffentlicht. Entfernen kannst du sie jederzeit mit \`/bewertung zurueckziehen id:${review.id}\`.`
          : `Deine Bewertung (#${review.id}) wurde gespeichert und nicht veröffentlicht.`,
        color: COLORS.success,
      }),
    ],
  });
}

export async function reviewSendButton(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  await i.deferUpdate();
  await submitReview(i, p, d, null);
}

export async function reviewModal(i: ModalSubmitInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const text = i.fields.getTextInputValue('text')?.trim() || null;
  if (i.isFromMessage()) await i.deferUpdate();
  else await deferEphemeral(i);
  await submitReview(i, p, d, text);
}

export async function reviewCommand(i: ChatInputCommandInteraction, d: HandlerDeps): Promise<void> {
  const sub = i.options.getSubcommand();
  const actor = actorOf(i);
  if (sub === 'abgeben') {
    await reviewStart(i, i.options.getInteger('auftrag', true), d);
    return;
  }
  await deferEphemeral(i);
  if (sub === 'ausblenden' || sub === 'einblenden') {
    const r = await d.s.reviews.setTextHidden(actor, i.options.getInteger('id', true), sub === 'ausblenden', i.options.getString('grund'));
    await respond(i, `Bewertung #${r.id}: Text ${r.text_hidden ? 'ausgeblendet' : 'wieder sichtbar'}. Sterne unverändert (${r.stars}/5). Aktion protokolliert.`);
    return;
  }
  if (sub === 'zurueckziehen') {
    const r = await d.s.reviews.withdrawOwn(actor, i.options.getInteger('id', true));
    await respond(i, `Bewertung #${r.id} wurde aus ⭐・bewertungen entfernt.`);
    return;
  }
  throw new UserError('Unbekannter Unterbefehl.');
}

// ------------------------------------------------------------------ Serverboosts

export async function serverboostCommand(i: ChatInputCommandInteraction, d: HandlerDeps): Promise<void> {
  const sub = i.options.getSubcommand();
  const actor = actorOf(i);
  await deferEphemeral(i);
  if (sub === 'status') {
    const lines = await d.s.boosts.diagnose(actor, { guildMembers: d.intents.guildMembers, guildMessages: d.intents.guildMessages });
    await respond(i, { embeds: [embed({ title: 'Discord-Serverboosts – Diagnose', description: truncate(lines.join('\n'), 4000), color: COLORS.booster })] });
    return;
  }
  if (sub === 'sync') {
    const r = await d.s.boosts.syncRoles(actor);
    await respond(
      i,
      r.mode === 'managed'
        ? 'Rollenmodus „verwaltet“: Discord vergibt die Booster-Rolle selbst – es wurde nichts verändert.'
        : `Rollenabgleich abgeschlossen: ${r.checked} Mitglieder geprüft, ${r.added} Rolle(n) vergeben, ${r.removed} entfernt (nur bei bestätigtem Boost-Ende).`,
    );
    return;
  }
  if (sub === 'rollenmodus') {
    const msg = await d.s.boosts.setRoleMode(actor, i.options.getString('modus', true) as 'managed' | 'custom');
    await d.s.setup.refreshPanels(actor, ['boost_info']).catch(() => []);
    await respond(i, msg);
    return;
  }
  throw new UserError('Unbekannter Unterbefehl.');
}

// ------------------------------------------------------------------ Community

export async function rulesAccept(i: ButtonInteraction, _p: ParsedId, d: HandlerDeps): Promise<void> {
  await deferEphemeral(i);
  const r = await d.s.community.acceptRules(i.user.id);
  await respond(i, r === 'added' ? 'Danke! Du hast die Regeln akzeptiert – die übrigen Bereiche sind jetzt sichtbar.' : 'Du hast die Regeln bereits akzeptiert.');
}

export async function roleToggle(i: ButtonInteraction, p: ParsedId, d: HandlerDeps): Promise<void> {
  const key = argStr(p, 0);
  if (key !== 'warzone' && key !== 'multiplayer') throw new UserError('Unbekannte Rolle.');
  await deferEphemeral(i);
  const r = await d.s.community.toggleInterest(i.user.id, key);
  await respond(i, `Interessenrolle **${key === 'warzone' ? 'Warzone' : 'Multiplayer'}** ${r === 'added' ? 'hinzugefügt' : 'entfernt'}.`);
}
