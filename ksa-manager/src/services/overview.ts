import { embed } from '../discord/ui.js';
import { isUnknownResource } from '../discord/port.js';
import { COLORS, GAME_SHORT, PAYMENT_STATUS_LABEL, PROCESS_STATUS_LABEL } from '../domain/constants.js';
import { errInfo } from '../logging/logger.js';
import { truncate } from '../util/text.js';
import type { AppContext } from './context.js';
import { panelResKey } from './registry.js';
import { ticketLabel, type OrderRow, type TicketRow } from './repo.js';

/**
 * Live-Panel 📋・auftragsübersicht: aktive Aufträge ohne Kundendaten,
 * ohne Preise und ohne interne Notizen. Änderungen werden gebündelt (Debounce).
 */
export class OverviewService {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly debounceMs = 4000,
  ) {}

  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.refresh().finally(() => {
        this.running = null;
      });
    }, this.debounceMs);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      await this.refresh();
    }
    if (this.running) await this.running;
  }

  render(): { embeds: ReturnType<typeof embed>[] } {
    const rows = this.ctx.db
      .prepare<[string], OrderRow & { number: number }>(
        `SELECT o.*, t.number AS number FROM orders o JOIN tickets t ON t.id = o.ticket_id
         WHERE o.guild_id = ? AND o.status NOT IN ('abgeschlossen','storniert') ORDER BY o.id`,
      )
      .all(this.ctx.config.guildId);
    const lines = rows.map(
      (o) =>
        `**#${o.id}** · ${ticketLabel({ number: o.number } as TicketRow)} · ${GAME_SHORT[o.game]} · ${PROCESS_STATUS_LABEL[o.status]} · ${o.progress_percent} % · ${
          o.operator_id ? `<@${o.operator_id}>` : 'ohne Operator'
        } · Zahlung: ${PAYMENT_STATUS_LABEL[o.payment_status]}`,
    );
    let description = lines.length ? '' : 'Keine aktiven Aufträge.';
    let shown = 0;
    for (const l of lines) {
      if (description.length + l.length + 40 > 3900) break;
      description += `${l}\n`;
      shown++;
    }
    if (shown < lines.length) description += `… und ${lines.length - shown} weitere (\`/auftrag liste\`).`;
    return {
      embeds: [
        embed({
          title: `Auftragsübersicht (${rows.length} aktiv)`,
          description: truncate(description, 4000),
          color: COLORS.neutral,
          footer: 'Automatisch aktualisiert · ohne Kundendaten',
          timestamp: this.ctx.clock.now(),
        }),
      ],
    };
  }

  async refresh(): Promise<void> {
    const row = this.ctx.registry.get(panelResKey('orders_overview'));
    if (!row || row.status !== 'done' || !row.discord_id || !row.channel_id) return;
    try {
      await this.ctx.port.editMessage(row.channel_id, row.discord_id, { ...this.render(), allowedMentions: {} });
    } catch (err) {
      if (isUnknownResource(err)) {
        this.ctx.log.warn('Auftragsübersicht fehlt – /panel aktualisieren oder /setup ausführen');
      } else {
        this.ctx.log.warn({ err: errInfo(err) }, 'Auftragsübersicht konnte nicht aktualisiert werden');
      }
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
