import { errInfo } from '../logging/logger.js';
import { DAY } from '../util/time.js';
import type { AppContext } from './context.js';
import type { Services } from './index.js';
import type { TicketRow } from './repo.js';

export interface RetentionReport {
  archivedChannelsDeleted: number;
  proofsExpired: number;
  ordersAnonymized: number;
  auditDeleted: number;
}

/**
 * Konfigurierbare Aufbewahrung (Standard: nichts wird automatisch gelöscht, außer
 * unveröffentlichten Proof-Dateien nach 30 Tagen). Es werden bewusst KEINE
 * gesetzlichen Fristen vorgegeben – diese müsst ihr selbst festlegen.
 */
export class RetentionService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly s: Services,
  ) {}

  start(intervalMs = 6 * 60 * 60 * 1000): void {
    this.timer = setInterval(() => {
      void this.run().catch((err: unknown) => this.ctx.log.warn({ err: errInfo(err) }, 'Aufbewahrungslauf fehlgeschlagen'));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async run(): Promise<RetentionReport> {
    const now = this.ctx.clock.now();
    const st = this.ctx.settings;
    const report: RetentionReport = { archivedChannelsDeleted: 0, proofsExpired: 0, ordersAnonymized: 0, auditDeleted: 0 };
    const g = this.ctx.config.guildId;

    const archDays = st.get('retention.archivedTicketDays');
    if (archDays > 0) {
      const old = this.ctx.db
        .prepare<[string, number], TicketRow>("SELECT * FROM tickets WHERE guild_id = ? AND status = 'closed' AND closed_at < ? AND channel_id IS NOT NULL")
        .all(g, now - archDays * DAY);
      for (const t of old) {
        try {
          await this.ctx.port.deleteChannel(t.channel_id!, `Aufbewahrung: ${archDays} Tage nach Schließung`);
          this.ctx.db.prepare("UPDATE tickets SET status = 'channel_deleted', updated_at = ? WHERE id = ?").run(now, t.id);
          report.archivedChannelsDeleted++;
        } catch (err) {
          this.ctx.log.warn({ err: errInfo(err), ticketId: t.id }, 'Archivkanal nicht gelöscht');
        }
      }
    }

    report.proofsExpired = this.s.proofs.purgeStale(st.get('retention.proofStagingDays'));

    const orderDays = st.get('retention.closedOrderDays');
    if (orderDays > 0) {
      const cutoff = now - orderDays * DAY;
      const orders = this.ctx.db
        .prepare<[string, number], { id: number; ticket_id: number }>(
          `SELECT o.id, o.ticket_id FROM orders o WHERE o.guild_id = ? AND o.status IN ('abgeschlossen','storniert')
           AND COALESCE(o.completed_at, o.cancelled_at) < ? AND o.customer_id != '0'
           AND NOT EXISTS (SELECT 1 FROM proofs p WHERE p.order_id = o.id AND p.status IN ('pending','publishing'))`,
        )
        .all(g, cutoff);
      for (const o of orders) {
        this.ctx.db.transaction(() => {
          this.ctx.db.prepare('DELETE FROM order_notes WHERE order_id = ?').run(o.id);
          this.ctx.db.prepare('UPDATE order_events SET details = NULL WHERE order_id = ?').run(o.id);
          this.ctx.db.prepare("UPDATE orders SET customer_id = '0', progress_note = NULL WHERE id = ?").run(o.id);
          this.ctx.db
            .prepare("UPDATE tickets SET customer_id = '0', details = NULL, subject = NULL, current_rank = NULL, current_sr = NULL, target_rank = NULL, platform = NULL, timeframe = NULL, close_reason = NULL WHERE id = ?")
            .run(o.ticket_id);
          this.ctx.db.prepare("UPDATE reviews SET customer_id = '0', display_name = CASE WHEN public_message_id IS NULL THEN NULL ELSE display_name END WHERE order_id = ?").run(o.id);
          this.ctx.repo.addOrderEvent(o.id, 'system', 'anonymized', null, null, null, now);
        })();
        report.ordersAnonymized++;
      }
    }

    const auditDays = st.get('retention.auditDays');
    if (auditDays > 0) {
      report.auditDeleted = this.ctx.db.prepare('DELETE FROM audit_log WHERE guild_id = ? AND created_at < ?').run(g, now - auditDays * DAY).changes;
    }

    this.ctx.db.prepare('DELETE FROM cooldowns WHERE until < ?').run(now);
    this.ctx.db.prepare('DELETE FROM proof_candidates WHERE expires_at < ?').run(now);
    this.ctx.db.prepare("DELETE FROM setup_plans WHERE status != 'running' AND created_at < ?").run(now - 30 * DAY);
    if (report.archivedChannelsDeleted || report.proofsExpired || report.ordersAnonymized || report.auditDeleted) {
      this.ctx.audit.record('system', 'retention.run', undefined, { ...report });
    }
    return report;
  }
}
