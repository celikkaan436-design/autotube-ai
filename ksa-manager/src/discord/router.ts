import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Interaction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  UserSelectMenuInteraction,
} from 'discord.js';
import { parseCid, type ParsedId } from '../domain/customId.js';
import { UserError } from '../util/errors.js';
import { PROOF_CONTEXT_MENU } from './commands.js';
import * as admin from './handlers/admin.js';
import * as misc from './handlers/misc.js';
import * as offers from './handlers/offers.js';
import * as proofs from './handlers/proofs.js';
import * as tickets from './handlers/tickets.js';
import { handleError, respond, type HandlerDeps } from './interactions.js';

type Btn = (i: ButtonInteraction, p: ParsedId, d: HandlerDeps) => Promise<void>;
type Sel = (i: StringSelectMenuInteraction, p: ParsedId, d: HandlerDeps) => Promise<void>;
type USel = (i: UserSelectMenuInteraction, p: ParsedId, d: HandlerDeps) => Promise<void>;
type Mdl = (i: ModalSubmitInteraction, p: ParsedId, d: HandlerDeps) => Promise<void>;
type Cmd = (i: ChatInputCommandInteraction, d: HandlerDeps) => Promise<void>;

const BUTTONS: Record<string, Btn> = {
  'su:ok': admin.setupConfirm,
  'su:no': admin.setupCancel,
  'tk:open': tickets.openTicketButton,
  'tk:claim': tickets.claimButton,
  'tk:assign': tickets.assignButton,
  'tk:status': tickets.statusButton,
  'tk:close': tickets.closeButton,
  'tk:closeok': tickets.closeConfirm,
  'tk:closeno': (i) => tickets.closeCancel(i),
  'of:new': offers.newOfferButton,
  'of:m2open': offers.offerModal2Open,
  'of:send': offers.offerSend,
  'of:discard': offers.offerDiscard,
  'of:accept': offers.offerAcceptButton,
  'of:acceptok': offers.offerAcceptConfirm,
  'of:decline': offers.offerDecline,
  'pf:start': proofs.proofStartButton,
  'pf:cok': (i, p, d) => proofs.customerDecisionButton(i, p, d, 'approved'),
  'pf:cno': (i, p, d) => proofs.customerDecisionButton(i, p, d, 'declined'),
  'pf:cname': proofs.customerNameButton,
  'pf:tok': proofs.teamApproveButton,
  'pf:tokc': proofs.teamApproveConfirm,
  'pf:text': proofs.editTextButton,
  'pf:op': proofs.toggleOperatorButton,
  'pf:rm': proofs.removeImageButton,
  'pf:del': (i, p) => proofs.discardButton(i, p),
  'pf:delok': proofs.discardConfirm,
  'rv:start': misc.reviewStartButton,
  'rv:text': misc.reviewTextButton,
  'rv:send': misc.reviewSendButton,
  'cm:rules': misc.rulesAccept,
  'cm:role': misc.roleToggle,
};

const SELECTS: Record<string, Sel> = {
  'od:statussel': tickets.statusSelect,
  'pf:sel': proofs.proofSelect,
  'pf:msg': proofs.proofMessageSelect,
  'pf:rmsel': proofs.removeImageSelect,
  'rv:stars': misc.reviewStars,
  'rv:pub': misc.reviewPublication,
};

const USER_SELECTS: Record<string, USel> = {
  'tk:assignsel': tickets.assignSelect,
};

const MODALS: Record<string, Mdl> = {
  'tk:req': tickets.submitTicketModal,
  'of:m1': offers.offerModal1,
  'of:m2': offers.offerModal2,
  'pf:textm': proofs.editTextModal,
  'rv:modal': misc.reviewModal,
};

const COMMANDS: Record<string, Cmd> = {
  setup: (i, d) => (i.options.getSubcommand() === 'diagnose' ? admin.setupDiagnose(i, d) : admin.setupStart(i, d)),
  health: admin.health,
  help: admin.help,
  panel: admin.panelRefresh,
  config: admin.config,
  ticket: tickets.ticketCommand,
  angebot: offers.offerCommand,
  auftrag: offers.orderCommand,
  proof: proofs.proofCommand,
  bewertung: misc.reviewCommand,
  serverboost: misc.serverboostCommand,
};

/** Modals öffnende Buttons dürfen nicht vorab deferiert werden. */
const DOUBLE_CLICK_MS = 1500;

export class InteractionRouter {
  private readonly recentClicks = new Map<string, number>();
  private readonly inFlight = new Set<Promise<void>>();
  accepting = true;

  constructor(private readonly deps: HandlerDeps) {}

  handle(i: Interaction): void {
    const task = this.dispatch(i).catch((err: unknown) => handleError(i, err, this.deps));
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  async drain(timeoutMs: number): Promise<void> {
    await Promise.race([Promise.allSettled([...this.inFlight]), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  private isDoubleClick(userId: string, customId: string): boolean {
    const key = `${userId}:${customId}`;
    const now = Date.now();
    const last = this.recentClicks.get(key);
    this.recentClicks.set(key, now);
    if (this.recentClicks.size > 2000) {
      for (const [k, t] of this.recentClicks) if (now - t > DOUBLE_CLICK_MS) this.recentClicks.delete(k);
    }
    return last !== undefined && now - last < DOUBLE_CLICK_MS;
  }

  private async dispatch(i: Interaction): Promise<void> {
    const d = this.deps;
    // Ausschließlich der konfigurierte Zielserver.
    if (!i.inGuild() || i.guildId !== d.ctx.config.guildId) {
      if (i.isRepliable()) await respond(i, 'Dieser Bot arbeitet ausschließlich auf dem Server KSA Boosting.');
      return;
    }
    if (!this.accepting) {
      if (i.isRepliable()) await respond(i, 'Der Bot startet gerade neu. Bitte in einer Minute erneut versuchen.');
      return;
    }
    if (i.isChatInputCommand()) {
      const h = COMMANDS[i.commandName];
      if (!h) throw new UserError('Unbekannter Befehl.');
      await h(i, d);
      return;
    }
    if (i.isMessageContextMenuCommand()) {
      if (i.commandName !== PROOF_CONTEXT_MENU) throw new UserError('Unbekannter Befehl.');
      await proofs.proofContextMenu(i, d);
      return;
    }
    if (i.isButton() || i.isStringSelectMenu() || i.isUserSelectMenu() || i.isModalSubmit()) {
      const parsed = parseCid(i.customId);
      if (!parsed) throw new UserError('Diese Schaltfläche ist veraltet oder ungültig.');
      const key = `${parsed.ns}:${parsed.action}`;
      if (!i.isModalSubmit() && this.isDoubleClick(i.user.id, i.customId)) {
        await respond(i, 'Bitte nicht doppelt klicken – die Aktion wird bereits bearbeitet.');
        return;
      }
      if (i.isButton() && BUTTONS[key]) return BUTTONS[key](i, parsed, d);
      if (i.isStringSelectMenu() && SELECTS[key]) return SELECTS[key](i, parsed, d);
      if (i.isUserSelectMenu() && USER_SELECTS[key]) return USER_SELECTS[key](i, parsed, d);
      if (i.isModalSubmit() && MODALS[key]) return MODALS[key](i, parsed, d);
      throw new UserError('Diese Schaltfläche ist veraltet oder ungültig.');
    }
  }
}
