import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { APIEmbed } from 'discord.js';
import type { AttachmentInfo, FileData, MessageInfo, MessagePayload } from '../discord/port.js';
import { isUnknownResource } from '../discord/port.js';
import { button, ButtonStyle, embed, row } from '../discord/ui.js';
import { BRAND, COLORS, GAME_LABEL, PROOF_STATUS_LABEL } from '../domain/constants.js';
import { cid } from '../domain/customId.js';
import { assertAllowed, atLeast, resolveLevel, type Actor } from '../domain/permissions.js';
import { errInfo } from '../logging/logger.js';
import { UserError } from '../util/errors.js';
import { hashObject, randomToken, sha256Hex } from '../util/hash.js';
import { sanitizeUserText, truncate } from '../util/text.js';
import { formatDate, MINUTE, DAY } from '../util/time.js';
import { authConfig, type AppContext } from './context.js';
import { ImageError, mimeToType, sanitizeImage } from './images.js';
import type { Services } from './index.js';
import { ticketLabel, type OrderRow, type ProofImageRow, type ProofRow, type TicketRow } from './repo.js';

export const PROOF_CHECK_NOTICE =
  'Prüfhinweis: Die Bilder dürfen keine E-Mail-Adressen, Zugangsdaten, Account-IDs, privaten Chats oder sonstigen unerwünschten personenbezogenen Daten zeigen. Sind solche Daten sichtbar, zuerst eine geschwärzte Version ins Ticket hochladen und diese einreichen. Der Bot entfernt technische Metadaten, erkennt aber keine sichtbaren Daten im Bild.';

/** Discord-Limit: max. 10 Anhänge; Anfrage max. 25 MiB – wir bleiben darunter. */
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const DISCORD_ATTACHMENT_LIMIT = 10;
const CANDIDATE_TTL_MS = 15 * MINUTE;
const ALLOWED_CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

interface CandidateRow {
  token: string;
  guild_id: string;
  ticket_id: number;
  message_id: string;
  user_id: string;
  attachments_json: string;
  created_at: number;
  expires_at: number;
}

interface DecisionRow {
  id: number;
  proof_id: number;
  version: number;
  version_hash: string;
  kind: 'customer' | 'team';
  decision: 'approved' | 'declined' | 'revoked';
  user_id: string;
  created_at: number;
}

export interface Readiness {
  ready: boolean;
  missing: string[];
}

export function isDiscordCdnUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && ALLOWED_CDN_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export class ProofService {
  constructor(
    private readonly ctx: AppContext,
    private readonly s: Services,
  ) {}

  private get repo() {
    return this.ctx.repo;
  }

  private maxImageBytes(): number {
    return Math.min(this.ctx.settings.get('proofs.maxImageMb'), 20) * 1024 * 1024;
  }

  private maxImages(): number {
    return Math.min(this.ctx.settings.get('proofs.maxImages'), DISCORD_ATTACHMENT_LIMIT);
  }

  // ------------------------------------------------------------------ Einreichung

  /** Unterstützte Bildanhänge einer Nachricht (nur Discord-CDN, erlaubte Typen und Größe). */
  supportedAttachments(message: MessageInfo): AttachmentInfo[] {
    const max = this.maxImageBytes();
    return message.attachments.filter(
      (a) => mimeToType(a.contentType) !== null && a.size > 0 && a.size <= max && isDiscordCdnUrl(a.url),
    );
  }

  /**
   * Startet die Einreichung für eine Ticketnachricht. Prüft Ticket-Zugehörigkeit,
   * Auftrag, Berechtigung, Autor (nur Team) und unterstützte Bilder.
   */
  async beginSubmission(actor: Actor, interactionChannelId: string | null, message: MessageInfo): Promise<{ token: string; attachments: AttachmentInfo[]; ticket: TicketRow; order: OrderRow }> {
    const ticket = this.s.tickets.requireTicketByChannel(interactionChannelId);
    if (message.channelId !== ticket.channel_id) throw new UserError('Die Nachricht gehört nicht zu diesem Ticket.');
    if (ticket.status !== 'open') throw new UserError('Das Ticket ist geschlossen. Für die Kundenfreigabe bitte zuerst wiedereröffnen.');
    const order = this.repo.orderByTicket(ticket.id);
    if (!order) throw new UserError('Dieses Ticket ist mit keinem Auftrag verknüpft.');
    assertAllowed(actor, authConfig(this.ctx), 'proof.submit', this.repo.scopeOfOrder(order));
    if (order.status === 'storniert') throw new UserError('Der Auftrag ist storniert.');
    if (message.authorIsBot) throw new UserError('Nachrichten des Bots können nicht als Proof eingereicht werden.');
    const author = await this.ctx.port.fetchMember(message.authorId);
    const authorLevel = author ? resolveLevel({ userId: author.userId, roleIds: author.roleIds }, authConfig(this.ctx)) : 'member';
    if (!atLeast(authorLevel, 'operator')) {
      throw new UserError('Proofs können nur aus Nachrichten des Teams eingereicht werden (nicht aus Kundennachrichten).');
    }
    if (message.attachments.length === 0) throw new UserError('Diese Nachricht enthält keine Anhänge.');
    const supported = this.supportedAttachments(message);
    if (supported.length === 0) {
      throw new UserError(`Keine unterstützten Bilder gefunden (PNG, JPEG, WebP, max. ${this.ctx.settings.get('proofs.maxImageMb')} MB je Bild).`);
    }
    const token = randomToken(9);
    const now = this.ctx.clock.now();
    this.ctx.db.prepare('DELETE FROM proof_candidates WHERE expires_at < ?').run(now);
    this.ctx.db
      .prepare(
        'INSERT INTO proof_candidates (token, guild_id, ticket_id, message_id, user_id, attachments_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(token, this.ctx.config.guildId, ticket.id, message.id, actor.userId, JSON.stringify(supported), now, now + CANDIDATE_TTL_MS);
    return { token, attachments: supported, ticket, order };
  }

  /** Übernimmt die ausgewählten Bilder: Download, Prüfung, Bereinigung, neue Proof-Version. */
  async selectImages(actor: Actor, token: string, interactionChannelId: string | null, attachmentIds: string[]): Promise<ProofRow> {
    const cand = this.ctx.db.prepare<[string], CandidateRow>('SELECT * FROM proof_candidates WHERE token = ?').get(token);
    const now = this.ctx.clock.now();
    if (!cand || cand.guild_id !== this.ctx.config.guildId) throw new UserError('Diese Auswahl ist abgelaufen. Bitte erneut einreichen.');
    if (cand.user_id !== actor.userId) throw new UserError('Diese Auswahl gehört nicht dir.');
    if (cand.expires_at < now) throw new UserError('Diese Auswahl ist abgelaufen. Bitte erneut einreichen.');
    const ticket = this.s.tickets.requireTicketByChannel(interactionChannelId);
    if (ticket.id !== cand.ticket_id) throw new UserError('Diese Auswahl gehört zu einem anderen Ticket.');
    const order = this.repo.orderByTicket(ticket.id);
    if (!order) throw new UserError('Dieses Ticket ist mit keinem Auftrag verknüpft.');
    assertAllowed(actor, authConfig(this.ctx), 'proof.submit', this.repo.scopeOfOrder(order));
    const all = JSON.parse(cand.attachments_json) as AttachmentInfo[];
    const chosen = all.filter((a) => attachmentIds.includes(a.id));
    if (chosen.length === 0 || chosen.length !== new Set(attachmentIds).size) throw new UserError('Ungültige Bildauswahl.');
    this.ctx.db.prepare('DELETE FROM proof_candidates WHERE token = ?').run(token);

    return this.ctx.locks.run(`proof-order:${order.id}`, async () => {
      const existing = this.repo.activeProofOfOrder(order.id);
      if (existing?.status === 'publishing') throw new UserError('Dieser Proof wird gerade veröffentlicht.');
      const existingImages = existing ? this.repo.proofImages(existing.id) : [];
      if (existingImages.length + chosen.length > this.maxImages()) {
        throw new UserError(`Zu viele Bilder: höchstens ${this.maxImages()} je Proof.`);
      }
      const prepared: { att: AttachmentInfo; data: Buffer; sha: string; contentType: string; ext: string }[] = [];
      let total = existingImages.reduce((n, i) => n + i.size_bytes, 0);
      for (const att of chosen) {
        if (!isDiscordCdnUrl(att.url)) throw new UserError('Nur Discord-Anhänge sind erlaubt.');
        let raw: Buffer;
        try {
          raw = await this.ctx.port.download(att.url, this.maxImageBytes());
        } catch (err) {
          this.ctx.log.warn({ err: errInfo(err) }, 'Proof-Bild konnte nicht geladen werden');
          throw new UserError(`„${truncate(att.name, 60)}“ konnte nicht geladen werden (abgelaufen oder zu groß). Bitte erneut einreichen.`);
        }
        let clean;
        try {
          clean = sanitizeImage(raw, att.contentType);
        } catch (err) {
          throw new UserError(`„${truncate(att.name, 60)}“: ${err instanceof ImageError ? err.message : 'ungültiges Bild'}.`);
        }
        const sha = sha256Hex(clean.data);
        if (existingImages.some((i) => i.sha256 === sha) || prepared.some((p) => p.sha === sha)) continue;
        if (this.isPublishedElsewhere(sha, existing?.id ?? -1)) {
          throw new UserError(`„${truncate(att.name, 60)}“ wurde bereits in einem veröffentlichten Proof verwendet.`);
        }
        total += clean.data.length;
        if (total > MAX_TOTAL_BYTES) throw new UserError('Die Bilder sind zusammen zu groß (max. 24 MB je Proof).');
        prepared.push({ att, data: clean.data, sha, contentType: clean.contentType, ext: clean.ext });
      }
      if (prepared.length === 0) throw new UserError('Diese Bilder sind bereits im Proof enthalten.');

      const proofId = this.ctx.db.transaction((): number => {
        let id = existing?.id;
        if (!id) {
          const info = this.ctx.db
            .prepare(
              `INSERT INTO proofs (guild_id, order_id, ticket_id, status, version, version_hash, public_text, show_operator, customer_display, created_by, created_at, updated_at)
               VALUES (?, ?, ?, 'pending', 0, '', ?, 0, 'anonymous', ?, ?, ?)`,
            )
            .run(this.ctx.config.guildId, order.id, ticket.id, 'Ein weiterer Auftrag wurde erfolgreich abgeschlossen.', actor.userId, now, now);
          id = Number(info.lastInsertRowid);
        }
        let position = existingImages.length;
        for (const p of prepared) {
          this.ctx.db
            .prepare(
              `INSERT INTO proof_images (proof_id, position, source_message_id, source_attachment_id, original_name, content_type, ext, size_bytes, sha256, storage_path, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
            )
            .run(id, position++, cand.message_id, p.att.id, truncate(p.att.name, 100), p.contentType, p.ext, p.data.length, p.sha, now);
        }
        return id;
      })();
      // Dateien erst nach erfolgreicher Transaktion schreiben (Pfad = Proof-ID + Hash).
      const dir = this.proofDir(proofId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const p of prepared) {
        const file = path.join(dir, `${p.sha}.${p.ext}`);
        writeFileSync(file, p.data, { mode: 0o600 });
        this.ctx.db.prepare('UPDATE proof_images SET storage_path = ? WHERE proof_id = ? AND sha256 = ?').run(file, proofId, p.sha);
      }
      const proof = await this.newVersion(proofId, actor.userId, 'Bilder hinzugefügt');
      this.ctx.audit.record(actor.userId, 'proof.images_added', { type: 'proof', id: proofId }, { count: prepared.length, version: proof.version });
      return proof;
    });
  }

  private isPublishedElsewhere(sha: string, proofId: number): boolean {
    return Boolean(
      this.ctx.db
        .prepare(
          "SELECT 1 FROM proof_images i JOIN proofs p ON p.id = i.proof_id WHERE i.sha256 = ? AND p.status = 'published' AND p.id != ? AND p.guild_id = ?",
        )
        .get(sha, proofId, this.ctx.config.guildId),
    );
  }

  proofDir(proofId: number): string {
    return path.join(this.ctx.config.proofStorageDir, String(proofId));
  }

  // ------------------------------------------------------------------ Versionen

  computeHash(proof: ProofRow, images: ProofImageRow[], order: OrderRow): string {
    return hashObject({
      proof: proof.id,
      version: proof.version,
      images: images.map((i) => i.sha256),
      text: proof.public_text,
      operator: proof.show_operator ? proof.operator_display_name : null,
      customer: proof.customer_display === 'display_name' ? proof.customer_display_name : null,
      game: order.game,
      start: order.start_rank,
      target: order.target,
    });
  }

  /** Neue Version: alle bisherigen Freigaben verlieren ihre Gültigkeit. */
  private async newVersion(proofId: number, actorId: string, reason: string): Promise<ProofRow> {
    const before = this.repo.proof(proofId)!;
    const order = this.repo.order(before.order_id)!;
    const images = this.repo.proofImages(proofId);
    const now = this.ctx.clock.now();
    const nextVersion = before.version + 1;
    const draft = { ...before, version: nextVersion };
    const hash = this.computeHash(draft, images, order);
    this.ctx.db
      .prepare("UPDATE proofs SET version = ?, version_hash = ?, status = 'pending', updated_at = ? WHERE id = ? AND status IN ('pending','declined')")
      .run(nextVersion, hash, now, proofId);
    const proof = this.repo.proof(proofId)!;
    this.ctx.log.info({ proofId, version: proof.version, reason, actorId }, 'Neue Proof-Version');
    await this.postPreview(proof, before.preview_message_id);
    await this.postReviewNote(this.repo.proof(proofId)!);
    return this.repo.proof(proofId)!;
  }

  private loadEditable(proofId: number, channelId: string | null, version?: number): { proof: ProofRow; order: OrderRow; ticket: TicketRow } {
    const proof = this.repo.proof(proofId);
    if (!proof) throw new UserError('Dieser Proof existiert nicht.');
    const ticket = this.repo.ticket(proof.ticket_id)!;
    if (channelId !== null && ticket.channel_id !== channelId) throw new UserError('Dieser Proof gehört nicht zu diesem Kanal.');
    const order = this.repo.order(proof.order_id)!;
    if (proof.status !== 'pending' && proof.status !== 'declined') throw new UserError(`Der Proof kann nicht mehr geändert werden (${PROOF_STATUS_LABEL[proof.status]}).`);
    if (version !== undefined && version !== proof.version) throw new UserError('Diese Vorschau ist veraltet. Bitte die aktuelle Version verwenden.');
    return { proof, order, ticket };
  }

  async editText(actor: Actor, proofId: number, channelId: string | null, version: number, text: string): Promise<ProofRow> {
    const { proof, order } = this.loadEditable(proofId, channelId, version);
    assertAllowed(actor, authConfig(this.ctx), 'proof.edit', this.repo.scopeOfOrder(order));
    const clean = sanitizeUserText(text, 500);
    if (!clean) throw new UserError('Der Text darf nicht leer sein.');
    return this.ctx.locks.run(`proof:${proof.id}`, async () => {
      this.ctx.db.prepare('UPDATE proofs SET public_text = ? WHERE id = ?').run(clean, proof.id);
      this.ctx.audit.record(actor.userId, 'proof.text_changed', { type: 'proof', id: proof.id });
      return this.newVersion(proof.id, actor.userId, 'Text geändert');
    });
  }

  async toggleOperator(actor: Actor, proofId: number, channelId: string | null, version: number): Promise<ProofRow> {
    const { proof, order } = this.loadEditable(proofId, channelId, version);
    assertAllowed(actor, authConfig(this.ctx), 'proof.edit', this.repo.scopeOfOrder(order));
    let name: string | null = null;
    if (!proof.show_operator) {
      if (!order.operator_id) throw new UserError('Dem Auftrag ist kein Operator zugewiesen.');
      const m = await this.ctx.port.fetchMember(order.operator_id);
      if (!m) throw new UserError('Der Operator ist nicht mehr auf dem Server.');
      name = sanitizeUserText(m.displayName, 80);
    }
    return this.ctx.locks.run(`proof:${proof.id}`, async () => {
      this.ctx.db.prepare('UPDATE proofs SET show_operator = ?, operator_display_name = ? WHERE id = ?').run(proof.show_operator ? 0 : 1, name, proof.id);
      return this.newVersion(proof.id, actor.userId, 'Bearbeiter-Anzeige geändert');
    });
  }

  /** Nur der Kunde darf seinen Anzeigenamen sichtbar machen; das Team darf nur auf anonym zurückstellen. */
  async toggleCustomerDisplay(actor: Actor, proofId: number, channelId: string | null, version: number): Promise<ProofRow> {
    const { proof, order } = this.loadEditable(proofId, channelId, version);
    const toNamed = proof.customer_display === 'anonymous';
    if (toNamed) {
      assertAllowed(actor, authConfig(this.ctx), 'proof.customerConsent', this.repo.scopeOfOrder(order));
    } else if (actor.userId !== order.customer_id) {
      assertAllowed(actor, authConfig(this.ctx), 'proof.edit', this.repo.scopeOfOrder(order));
    }
    let name: string | null = null;
    if (toNamed) {
      const m = await this.ctx.port.fetchMember(order.customer_id);
      if (!m) throw new UserError('Kunde nicht gefunden.');
      name = sanitizeUserText(m.displayName, 80);
    }
    return this.ctx.locks.run(`proof:${proof.id}`, async () => {
      this.ctx.db
        .prepare('UPDATE proofs SET customer_display = ?, customer_display_name = ? WHERE id = ?')
        .run(toNamed ? 'display_name' : 'anonymous', name, proof.id);
      return this.newVersion(proof.id, actor.userId, 'Kundenanzeige geändert');
    });
  }

  async removeImage(actor: Actor, proofId: number, channelId: string | null, version: number, imageId: number): Promise<ProofRow> {
    const { proof, order } = this.loadEditable(proofId, channelId, version);
    assertAllowed(actor, authConfig(this.ctx), 'proof.edit', this.repo.scopeOfOrder(order));
    return this.ctx.locks.run(`proof:${proof.id}`, async () => {
      const images = this.repo.proofImages(proof.id);
      const img = images.find((i) => i.id === imageId);
      if (!img) throw new UserError('Bild nicht gefunden.');
      if (images.length === 1) throw new UserError('Das letzte Bild kann nicht entfernt werden – verwirf stattdessen den Proof.');
      this.ctx.db.prepare('DELETE FROM proof_images WHERE id = ? AND proof_id = ?').run(img.id, proof.id);
      if (img.storage_path) rmSync(img.storage_path, { force: true });
      this.ctx.audit.record(actor.userId, 'proof.image_removed', { type: 'proof', id: proof.id });
      return this.newVersion(proof.id, actor.userId, 'Bild entfernt');
    });
  }

  async cancel(actor: Actor, proofId: number, channelId: string | null): Promise<ProofRow> {
    const { proof, order } = this.loadEditable(proofId, channelId);
    assertAllowed(actor, authConfig(this.ctx), 'proof.edit', this.repo.scopeOfOrder(order));
    return this.ctx.locks.run(`proof:${proof.id}`, async () => {
      const changed = this.ctx.db
        .prepare("UPDATE proofs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('pending','declined')")
        .run(this.ctx.clock.now(), proof.id).changes;
      if (!changed) throw new UserError('Der Proof kann nicht mehr verworfen werden.');
      this.deleteFiles(proof.id);
      await this.disablePreview(this.repo.proof(proof.id)!, 'Dieser Proof wurde verworfen.');
      this.ctx.audit.record(actor.userId, 'proof.cancelled', { type: 'proof', id: proof.id });
      return this.repo.proof(proof.id)!;
    });
  }

  /** Auftragsdaten (z. B. Ziel nach Angebotsänderung) geändert → neue Version, erneute Zustimmung nötig. */
  async onOrderDataChanged(orderId: number): Promise<void> {
    const proof = this.repo.activeProofOfOrder(orderId);
    if (!proof || (proof.status !== 'pending' && proof.status !== 'declined')) return;
    await this.ctx.locks.run(`proof:${proof.id}`, () => this.newVersion(proof.id, 'system', 'Auftragsdaten geändert'));
  }

  async cancelForOrder(orderId: number, actorId: string, reason: string): Promise<void> {
    const proof = this.repo.activeProofOfOrder(orderId);
    if (!proof || proof.status === 'publishing') return;
    this.ctx.db.prepare("UPDATE proofs SET status = 'cancelled', last_error = ?, updated_at = ? WHERE id = ?").run(reason, this.ctx.clock.now(), proof.id);
    this.deleteFiles(proof.id);
    await this.disablePreview(this.repo.proof(proof.id)!, `Proof verworfen: ${reason}.`);
    this.ctx.audit.record(actorId, 'proof.cancelled', { type: 'proof', id: proof.id }, { reason });
  }

  // ------------------------------------------------------------------ Freigaben

  private currentDecision(proofId: number, version: number, kind: 'customer' | 'team'): DecisionRow | undefined {
    return this.ctx.db
      .prepare<[number, number, string], DecisionRow>(
        'SELECT * FROM proof_decisions WHERE proof_id = ? AND version = ? AND kind = ? ORDER BY id DESC LIMIT 1',
      )
      .get(proofId, version, kind);
  }

  private validateDecision(proof: ProofRow, version: number, hashPrefix: string): void {
    if (proof.status !== 'pending' && proof.status !== 'declined') throw new UserError(`Keine Freigabe möglich (${PROOF_STATUS_LABEL[proof.status]}).`);
    if (version !== proof.version || hashPrefix.length < 16 || !proof.version_hash.startsWith(hashPrefix)) {
      throw new UserError('Diese Vorschau ist veraltet – bitte die aktuelle Vorschau im Ticket prüfen.');
    }
  }

  /** Ausdrückliche Zustimmung (oder Ablehnung) des Kunden zu genau dieser Version. */
  async customerDecision(actor: Actor, proofId: number, version: number, hashPrefix: string, channelId: string | null, decision: 'approved' | 'declined'): Promise<ProofRow> {
    const proof = this.repo.proof(proofId);
    if (!proof) throw new UserError('Dieser Proof existiert nicht.');
    const ticket = this.repo.ticket(proof.ticket_id)!;
    if (channelId !== null && ticket.channel_id !== channelId) throw new UserError('Dieser Proof gehört nicht zu diesem Kanal.');
    const order = this.repo.order(proof.order_id)!;
    assertAllowed(actor, authConfig(this.ctx), 'proof.customerConsent', this.repo.scopeOfOrder(order));
    return this.ctx.locks.run(`proof:${proof.id}`, async () => {
      const current = this.repo.proof(proof.id)!;
      this.validateDecision(current, version, hashPrefix);
      const existing = this.currentDecision(current.id, current.version, 'customer');
      if (existing?.decision === decision) throw new UserError(decision === 'approved' ? 'Du hast bereits zugestimmt.' : 'Du hast bereits abgelehnt.');
      const now = this.ctx.clock.now();
      this.ctx.db.transaction(() => {
        if (decision === 'declined') {
          this.ctx.db
            .prepare("UPDATE proof_decisions SET decision = 'revoked' WHERE proof_id = ? AND version = ? AND kind = 'customer' AND decision = 'approved'")
            .run(current.id, current.version);
        }
        this.ctx.db
          .prepare('INSERT INTO proof_decisions (proof_id, version, version_hash, kind, decision, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(current.id, current.version, current.version_hash, 'customer', decision, actor.userId, now);
        this.ctx.db
          .prepare('UPDATE proofs SET status = ?, updated_at = ? WHERE id = ?')
          .run(decision === 'approved' ? 'pending' : 'declined', now, current.id);
      })();
      this.ctx.audit.record(actor.userId, decision === 'approved' ? 'proof.customer_approved' : 'proof.customer_declined', { type: 'proof', id: current.id }, { version: current.version });
      await this.refreshPreview(this.repo.proof(current.id)!);
      if (decision === 'approved') await this.tryPublish(current.id);
      return this.repo.proof(current.id)!;
    });
  }

  /** Team-Freigabe nach bestätigter Prüfung genau dieser Version. */
  async teamApprove(actor: Actor, proofId: number, version: number, hashPrefix: string): Promise<ProofRow> {
    const proof = this.repo.proof(proofId);
    if (!proof) throw new UserError('Dieser Proof existiert nicht.');
    const order = this.repo.order(proof.order_id)!;
    assertAllowed(actor, authConfig(this.ctx), 'proof.teamApprove', this.repo.scopeOfOrder(order));
    return this.ctx.locks.run(`proof:${proof.id}`, async () => {
      const current = this.repo.proof(proof.id)!;
      this.validateDecision(current, version, hashPrefix);
      if (this.currentDecision(current.id, current.version, 'team')?.decision === 'approved') throw new UserError('Diese Version ist bereits vom Team freigegeben.');
      this.ctx.db
        .prepare('INSERT INTO proof_decisions (proof_id, version, version_hash, kind, decision, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(current.id, current.version, current.version_hash, 'team', 'approved', actor.userId, this.ctx.clock.now());
      this.ctx.audit.record(actor.userId, 'proof.team_approved', { type: 'proof', id: current.id }, { version: current.version });
      await this.refreshPreview(this.repo.proof(current.id)!);
      await this.postReviewNote(this.repo.proof(current.id)!);
      await this.tryPublish(current.id);
      return this.repo.proof(current.id)!;
    });
  }

  readiness(proof: ProofRow): Readiness {
    const missing: string[] = [];
    const order = this.repo.order(proof.order_id);
    if (proof.status !== 'pending' && proof.status !== 'publishing') missing.push(`Status: ${PROOF_STATUS_LABEL[proof.status]}`);
    if (!order || order.status !== 'abgeschlossen') missing.push('Auftrag ist noch nicht abgeschlossen');
    const c = this.currentDecision(proof.id, proof.version, 'customer');
    if (!c || c.decision !== 'approved' || c.version_hash !== proof.version_hash) missing.push('Zustimmung des Kunden zu dieser Version');
    const t = this.currentDecision(proof.id, proof.version, 'team');
    if (!t || t.decision !== 'approved' || t.version_hash !== proof.version_hash) missing.push('Team-Freigabe dieser Version');
    const images = this.repo.proofImages(proof.id);
    if (images.length === 0) missing.push('Bilder');
    if (images.some((i) => !i.storage_path || !existsSync(i.storage_path))) missing.push('Bilddateien (bitte neu einreichen)');
    if (order && this.computeHash(proof, images, order) !== proof.version_hash) missing.push('Konsistente Version (Daten haben sich geändert)');
    return { ready: missing.length === 0, missing };
  }

  // ------------------------------------------------------------------ Veröffentlichung

  async onOrderCompleted(orderId: number): Promise<void> {
    const proof = this.repo.activeProofOfOrder(orderId);
    if (!proof) return;
    await this.refreshPreview(proof);
    await this.tryPublish(proof.id);
  }

  /**
   * Veröffentlicht, sobald alle Bedingungen erfüllt sind. Idempotent:
   * Sperre + Statusübergang + Discord-Nonce (enforce_nonce) + Wiederaufnahme-Suche
   * nach Footer-Markierung verhindern doppelte Posts auch nach Abstürzen.
   */
  async tryPublish(proofId: number): Promise<{ published: boolean; missing: string[] }> {
    return this.ctx.locks.run(`publish:${proofId}`, async () => {
      const proof = this.repo.proof(proofId);
      if (!proof) return { published: false, missing: ['Proof fehlt'] };
      if (proof.status === 'published') return { published: true, missing: [] };
      const readiness = this.readiness(proof);
      if (!readiness.ready) return { published: false, missing: readiness.missing };
      const channelId = this.ctx.registry.channelId('proofs');
      if (!channelId) return { published: false, missing: ['Kanal 📸・proofs ist nicht eingerichtet'] };
      const images = this.repo.proofImages(proof.id);
      for (const img of images) {
        if (this.isPublishedElsewhere(img.sha256, proof.id)) {
          this.ctx.db.prepare("UPDATE proofs SET last_error = ? WHERE id = ?").run('Bild bereits in anderem Proof veröffentlicht', proof.id);
          return { published: false, missing: ['Ein Bild wurde bereits in einem anderen Proof veröffentlicht'] };
        }
      }
      const now = this.ctx.clock.now();
      const nonce = proof.publish_nonce ?? `p${proof.id}-${randomToken(6)}`.slice(0, 25);
      const claimed = this.ctx.db
        .prepare(
          "UPDATE proofs SET status = 'publishing', publish_nonce = ?, publish_attempts = publish_attempts + 1, publish_started_at = ?, updated_at = ? WHERE id = ? AND status IN ('pending','publishing')",
        )
        .run(nonce, now, now, proof.id).changes;
      if (claimed !== 1) return { published: false, missing: ['Status hat sich geändert'] };
      const attempt = this.repo.proof(proof.id)!;

      let messageId: string | null = null;
      try {
        if (attempt.publish_attempts > 1) messageId = await this.findExistingPublicPost(channelId, proof.id);
        if (!messageId) {
          messageId = await this.ctx.port.sendMessage(channelId, {
            ...this.publicPayload(attempt, images),
            nonce,
            enforceNonce: true,
          });
        }
      } catch (err) {
        this.ctx.log.error({ err: errInfo(err), proofId: proof.id }, 'Proof-Veröffentlichung fehlgeschlagen');
        this.ctx.db
          .prepare("UPDATE proofs SET status = 'pending', last_error = ?, updated_at = ? WHERE id = ? AND status = 'publishing'")
          .run(String(errInfo(err).message ?? 'Fehler').slice(0, 300), this.ctx.clock.now(), proof.id);
        return { published: false, missing: ['Discord-Fehler beim Posten – wird automatisch erneut versucht'] };
      }
      const publishedAt = this.ctx.clock.now();
      this.ctx.db
        .prepare(
          "UPDATE proofs SET status = 'published', public_channel_id = ?, public_message_id = ?, published_at = ?, last_error = NULL, updated_at = ? WHERE id = ? AND status = 'publishing'",
        )
        .run(channelId, messageId, publishedAt, publishedAt, proof.id);
      const published = this.repo.proof(proof.id)!;
      this.deleteFiles(proof.id);
      const link = `https://discord.com/channels/${this.ctx.config.guildId}/${channelId}/${messageId}`;
      const ticket = this.repo.ticket(published.ticket_id)!;
      await this.disablePreview(published, `Veröffentlicht: ${link}`);
      await this.s.tickets.notify(ticket, `Proof #${published.id} wurde veröffentlicht: ${link}\nDu kannst deine Freigabe jederzeit mit \`/proof widerrufen proof:${published.id}\` zurückziehen; der Beitrag wird dann entfernt.`);
      this.ctx.audit.record('system', 'proof.published', { type: 'proof', id: published.id }, { messageId, version: published.version });
      await this.ctx.audit.teamLog('Proof veröffentlicht', [`Proof #${published.id} (Auftrag #${published.order_id}, ${ticketLabel(ticket)}): ${link}`], COLORS.success);
      await this.postReviewNote(published);
      return { published: true, missing: [] };
    });
  }

  private async findExistingPublicPost(channelId: string, proofId: number): Promise<string | null> {
    const botId = this.ctx.port.botUserId();
    const marker = `Proof #${proofId}`;
    const msgs = await this.ctx.port.fetchMessages(channelId, { limit: 50 });
    const hit = msgs.find((m) => m.authorId === botId && m.embeds.some((e) => (e.footer ?? '').endsWith(marker)));
    return hit?.id ?? null;
  }

  publicEmbed(proof: ProofRow, order: OrderRow, preview = false): APIEmbed {
    const fields = [
      { name: 'Spiel', value: GAME_LABEL[order.game] },
      { name: 'Ergebnis', value: `${sanitizeUserText(order.start_rank, 200)} → ${sanitizeUserText(order.target, 200)}` },
      { name: 'Datum', value: order.completed_at ? formatDate(order.completed_at, this.ctx.config.timezone) : 'Datum des Abschlusses', inline: true },
    ];
    if (proof.show_operator && proof.operator_display_name) fields.push({ name: 'Bearbeiter', value: proof.operator_display_name, inline: true });
    if (proof.customer_display === 'display_name' && proof.customer_display_name) fields.push({ name: 'Kunde', value: proof.customer_display_name, inline: true });
    return embed({
      title: preview ? 'Vorschau: Auftrag abgeschlossen' : 'Auftrag abgeschlossen',
      description: proof.public_text,
      fields,
      footer: `${BRAND} · Proof #${proof.id}`,
    });
  }

  private files(proof: ProofRow, images: ProofImageRow[]): FileData[] {
    return images.map((img, i) => ({
      name: `proof-${proof.id}-${i + 1}.${img.ext}`,
      data: readFileSync(img.storage_path!),
      description: `Proof ${proof.id}, Bild ${i + 1}`,
    }));
  }

  publicPayload(proof: ProofRow, images: ProofImageRow[]): MessagePayload {
    const order = this.repo.order(proof.order_id)!;
    return { embeds: [this.publicEmbed(proof, order)], files: this.files(proof, images), allowedMentions: {} };
  }

  private statusLines(proof: ProofRow): string[] {
    const r = this.readiness(proof);
    const c = this.currentDecision(proof.id, proof.version, 'customer');
    const t = this.currentDecision(proof.id, proof.version, 'team');
    return [
      `Kunde: ${c?.decision === 'approved' ? 'zugestimmt' : c?.decision === 'declined' ? 'abgelehnt' : 'ausstehend'}`,
      `Team: ${t?.decision === 'approved' ? `freigegeben von <@${t.user_id}>` : 'ausstehend'}`,
      r.ready ? 'Bereit zur Veröffentlichung.' : `Noch offen: ${r.missing.join(', ')}`,
    ];
  }

  private previewPayload(proof: ProofRow): MessagePayload {
    const order = this.repo.order(proof.order_id)!;
    const images = this.repo.proofImages(proof.id);
    const h = proof.version_hash.slice(0, 16);
    const v = proof.version;
    const info = embed({
      title: `Proof #${proof.id} – Version ${v}`,
      color: COLORS.warning,
      description: [
        `<@${order.customer_id}>, bitte prüfe genau diese ${images.length} Bild(er) und die Angaben oben.`,
        'Mit **Veröffentlichung zustimmen** erlaubst du, dass genau diese Inhalte in 📸・proofs erscheinen – standardmäßig anonym, ohne Erwähnung und ohne Account-ID. Jede Änderung erfordert deine erneute Zustimmung.',
        'Veröffentlicht wird erst, wenn der Auftrag abgeschlossen ist und das Team freigegeben hat.',
        '',
        PROOF_CHECK_NOTICE,
        '',
        ...this.statusLines(proof),
      ].join('\n'),
      footer: `${BRAND} · Vorschau-Version ${v}`,
    });
    return {
      content: `<@${order.customer_id}> Proof-Vorschau zur Freigabe.`,
      embeds: [this.publicEmbed(proof, order, true), info],
      files: this.files(proof, images),
      components: [
        row(
          button(cid('pf', 'cok', proof.id, v, h), 'Veröffentlichung zustimmen', ButtonStyle.Success),
          button(cid('pf', 'cno', proof.id, v, h), 'Ablehnen', ButtonStyle.Secondary),
          button(cid('pf', 'cname', proof.id, v), proof.customer_display === 'anonymous' ? 'Mit meinem Namen' : 'Anonym anzeigen', ButtonStyle.Secondary),
        ),
        row(
          button(cid('pf', 'tok', proof.id, v, h), 'Team-Freigabe', ButtonStyle.Primary),
          button(cid('pf', 'text', proof.id, v), 'Text bearbeiten', ButtonStyle.Secondary),
          button(cid('pf', 'op', proof.id, v), proof.show_operator ? 'Bearbeiter ausblenden' : 'Bearbeiter zeigen', ButtonStyle.Secondary),
          button(cid('pf', 'rm', proof.id, v), 'Bild entfernen', ButtonStyle.Secondary),
          button(cid('pf', 'del', proof.id), 'Verwerfen', ButtonStyle.Danger),
        ),
      ],
      allowedMentions: { users: [order.customer_id] },
    };
  }

  private async postPreview(proof: ProofRow, oldMessageId: string | null): Promise<void> {
    const ticket = this.repo.ticket(proof.ticket_id)!;
    if (!ticket.channel_id) return;
    if (oldMessageId) {
      await this.ctx.port
        .editMessage(ticket.channel_id, oldMessageId, {
          content: `Diese Vorschau ist veraltet (ersetzt durch Version ${proof.version}).`,
          components: [],
          allowedMentions: {},
        })
        .catch(() => undefined);
    }
    try {
      const id = await this.ctx.port.sendMessage(ticket.channel_id, this.previewPayload(proof));
      this.ctx.db.prepare('UPDATE proofs SET preview_message_id = ? WHERE id = ?').run(id, proof.id);
    } catch (err) {
      if (isUnknownResource(err)) this.s.tickets.markChannelDeleted(ticket.channel_id);
      throw err;
    }
  }

  /** Aktualisiert nur Text/Status der bestehenden Vorschau (Bilder bleiben gleich). */
  private async refreshPreview(proof: ProofRow): Promise<void> {
    const ticket = this.repo.ticket(proof.ticket_id)!;
    if (!ticket.channel_id || !proof.preview_message_id) return;
    const payload = this.previewPayload(proof);
    delete payload.files;
    await this.ctx.port.editMessage(ticket.channel_id, proof.preview_message_id, payload).catch((err: unknown) => {
      this.ctx.log.debug({ err: errInfo(err) }, 'Vorschau nicht aktualisiert');
    });
  }

  private async disablePreview(proof: ProofRow, note: string): Promise<void> {
    const ticket = this.repo.ticket(proof.ticket_id)!;
    if (!ticket.channel_id || !proof.preview_message_id) return;
    await this.ctx.port
      .editMessage(ticket.channel_id, proof.preview_message_id, { content: note, components: [], allowedMentions: {} })
      .catch(() => undefined);
  }

  /** Hinweis in 🔍・proof-prüfung für die Team-Freigabe. */
  private async postReviewNote(proof: ProofRow): Promise<void> {
    const channelId = this.ctx.registry.channelId('proofpruefung');
    if (!channelId) return;
    const ticket = this.repo.ticket(proof.ticket_id)!;
    const link = ticket.channel_id && proof.preview_message_id ? `https://discord.com/channels/${this.ctx.config.guildId}/${ticket.channel_id}/${proof.preview_message_id}` : null;
    const teamApproved = this.currentDecision(proof.id, proof.version, 'team')?.decision === 'approved';
    const done = proof.status !== 'pending' && proof.status !== 'declined';
    const payload: MessagePayload = {
      embeds: [
        embed({
          title: `Proof #${proof.id} – ${PROOF_STATUS_LABEL[proof.status]}`,
          color: done ? COLORS.muted : COLORS.warning,
          description: [
            `Auftrag #${proof.order_id} · ${ticketLabel(ticket)} · Version ${proof.version}`,
            link ? `Vorschau: ${link}` : 'Vorschau im Ticket nicht verfügbar.',
            '',
            ...this.statusLines(proof),
            '',
            PROOF_CHECK_NOTICE,
          ].join('\n'),
        }),
      ],
      components:
        done || teamApproved
          ? []
          : [row(button(cid('pf', 'tok', proof.id, proof.version, proof.version_hash.slice(0, 16)), 'Prüfen & freigeben', ButtonStyle.Primary))],
      allowedMentions: {},
    };
    try {
      if (proof.review_message_id) {
        await this.ctx.port.editMessage(channelId, proof.review_message_id, payload);
        return;
      }
    } catch (err) {
      if (!isUnknownResource(err)) {
        this.ctx.log.warn({ err: errInfo(err) }, 'Prüfhinweis nicht aktualisiert');
        return;
      }
    }
    const id = await this.ctx.port.sendMessage(channelId, payload).catch(() => null);
    if (id) this.ctx.db.prepare('UPDATE proofs SET review_message_id = ? WHERE id = ?').run(id, proof.id);
  }

  // ------------------------------------------------------------------ Rücknahme

  /** Administrative Rücknahme eines veröffentlichten Proofs (mit Audit-Eintrag). */
  async withdraw(actor: Actor, proofId: number, reason: string): Promise<ProofRow> {
    const proof = this.repo.proof(proofId);
    if (!proof) throw new UserError('Dieser Proof existiert nicht.');
    const order = this.repo.order(proof.order_id)!;
    assertAllowed(actor, authConfig(this.ctx), 'proof.withdraw', this.repo.scopeOfOrder(order));
    return this.removePublished(proof, actor.userId, sanitizeUserText(reason, 300) || 'ohne Angabe');
  }

  /** Kunde widerruft seine Freigabe – vor oder nach der Veröffentlichung. */
  async customerRevoke(actor: Actor, proofId: number): Promise<ProofRow> {
    const proof = this.repo.proof(proofId);
    if (!proof) throw new UserError('Dieser Proof existiert nicht.');
    const order = this.repo.order(proof.order_id)!;
    assertAllowed(actor, authConfig(this.ctx), 'proof.customerRevoke', this.repo.scopeOfOrder(order));
    if (proof.status === 'published') return this.removePublished(proof, actor.userId, 'Freigabe vom Kunden widerrufen');
    if (proof.status === 'pending' || proof.status === 'declined') {
      return this.ctx.locks.run(`proof:${proof.id}`, async () => {
        const now = this.ctx.clock.now();
        this.ctx.db.transaction(() => {
          this.ctx.db
            .prepare("UPDATE proof_decisions SET decision = 'revoked' WHERE proof_id = ? AND kind = 'customer' AND decision = 'approved'")
            .run(proof.id);
          this.ctx.db
            .prepare('INSERT INTO proof_decisions (proof_id, version, version_hash, kind, decision, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(proof.id, proof.version, proof.version_hash, 'customer', 'revoked', actor.userId, now);
          this.ctx.db.prepare("UPDATE proofs SET status = 'declined', updated_at = ? WHERE id = ?").run(now, proof.id);
        })();
        this.ctx.audit.record(actor.userId, 'proof.customer_revoked', { type: 'proof', id: proof.id });
        await this.refreshPreview(this.repo.proof(proof.id)!);
        return this.repo.proof(proof.id)!;
      });
    }
    throw new UserError(`Nichts zu widerrufen (${PROOF_STATUS_LABEL[proof.status]}).`);
  }

  private async removePublished(proof: ProofRow, actorId: string, reason: string): Promise<ProofRow> {
    return this.ctx.locks.run(`publish:${proof.id}`, async () => {
      const current = this.repo.proof(proof.id)!;
      if (current.status !== 'published') throw new UserError('Dieser Proof ist nicht veröffentlicht.');
      if (current.public_channel_id && current.public_message_id) {
        try {
          await this.ctx.port.deleteMessage(current.public_channel_id, current.public_message_id);
        } catch (err) {
          if (!isUnknownResource(err)) throw new UserError('Der Beitrag konnte nicht gelöscht werden. Bitte später erneut versuchen.');
        }
      }
      const now = this.ctx.clock.now();
      this.ctx.db
        .prepare("UPDATE proofs SET status = 'withdrawn', withdrawn_at = ?, withdrawn_by = ?, withdraw_reason = ?, updated_at = ? WHERE id = ? AND status = 'published'")
        .run(now, actorId, reason, now, current.id);
      this.ctx.audit.record(actorId, 'proof.withdrawn', { type: 'proof', id: current.id }, { reason });
      await this.ctx.audit.teamLog('Proof zurückgenommen', [`Proof #${current.id}: ${reason} (durch <@${actorId}>)`], COLORS.warning);
      const ticket = this.repo.ticket(current.ticket_id)!;
      await this.s.tickets.notify(ticket, `Proof #${current.id} wurde aus 📸・proofs entfernt (${reason}). Hinweis: Bereits von Dritten gespeicherte Kopien können wir nicht löschen.`);
      await this.postReviewNote(this.repo.proof(current.id)!);
      return this.repo.proof(current.id)!;
    });
  }

  // ------------------------------------------------------------------ Betrieb

  /** Nach Neustart: unterbrochene und bereite Veröffentlichungen fortsetzen. */
  async resumePending(): Promise<number> {
    const rows = this.ctx.db
      .prepare<[string], ProofRow>("SELECT * FROM proofs WHERE guild_id = ? AND status IN ('pending','publishing')")
      .all(this.ctx.config.guildId);
    let published = 0;
    for (const p of rows) {
      const r = await this.tryPublish(p.id).catch(() => ({ published: false }));
      if (r.published) published++;
    }
    return published;
  }

  deleteFiles(proofId: number): void {
    rmSync(this.proofDir(proofId), { recursive: true, force: true });
    this.ctx.db.prepare('UPDATE proof_images SET storage_path = NULL WHERE proof_id = ?').run(proofId);
  }

  /** Aufbewahrung: unveröffentlichte Proof-Dateien nach X Tagen löschen. */
  purgeStale(days: number): number {
    const cutoff = this.ctx.clock.now() - days * DAY;
    const stale = this.ctx.db
      .prepare<[string, number], ProofRow>("SELECT * FROM proofs WHERE guild_id = ? AND status IN ('pending','declined') AND updated_at < ?")
      .all(this.ctx.config.guildId, cutoff);
    for (const p of stale) {
      this.ctx.db.prepare("UPDATE proofs SET status = 'cancelled', last_error = 'Aufbewahrungsfrist abgelaufen', updated_at = ? WHERE id = ?").run(this.ctx.clock.now(), p.id);
      this.deleteFiles(p.id);
    }
    return stale.length;
  }

  describe(actor: Actor, proofId: number): MessagePayload {
    const proof = this.repo.proof(proofId);
    if (!proof) throw new UserError('Dieser Proof existiert nicht.');
    const order = this.repo.order(proof.order_id)!;
    assertAllowed(actor, authConfig(this.ctx), 'proof.view', this.repo.scopeOfOrder(order));
    const images = this.repo.proofImages(proof.id);
    const lines = [
      `Status: **${PROOF_STATUS_LABEL[proof.status]}** · Version ${proof.version} · ${images.length} Bild(er)`,
      ...((proof.status === 'pending' || proof.status === 'declined') ? this.statusLines(proof) : []),
      ...(proof.public_message_id ? [`Beitrag: https://discord.com/channels/${this.ctx.config.guildId}/${proof.public_channel_id}/${proof.public_message_id}`] : []),
      ...(proof.withdraw_reason ? [`Zurückgenommen: ${proof.withdraw_reason}`] : []),
      ...(proof.last_error && proof.status !== 'published' ? [`Letzter Fehler: ${proof.last_error}`] : []),
    ];
    return { embeds: [this.publicEmbed(proof, order, true), embed({ title: `Proof #${proof.id}`, description: lines.join('\n'), color: COLORS.neutral })], allowedMentions: {} };
  }
}
