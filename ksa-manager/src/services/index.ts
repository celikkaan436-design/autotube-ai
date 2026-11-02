import { SetupService } from '../setup/service.js';
import { BoostService } from './boosts.js';
import { CommunityService } from './community.js';
import type { AppContext } from './context.js';
import { ExportService } from './exports.js';
import { OfferService } from './offers.js';
import { OrderService } from './orders.js';
import { OverviewService } from './overview.js';
import { ProofService } from './proofs.js';
import { RetentionService } from './retention.js';
import { ReviewService } from './reviews.js';
import { TicketService } from './tickets.js';

export interface Services {
  setup: SetupService;
  tickets: TicketService;
  offers: OfferService;
  orders: OrderService;
  overview: OverviewService;
  proofs: ProofService;
  reviews: ReviewService;
  boosts: BoostService;
  exports: ExportService;
  retention: RetentionService;
  community: CommunityService;
}

export interface ServiceOptions {
  setupPaceMs?: number;
  overviewDebounceMs?: number;
}

export function createServices(ctx: AppContext, opts: ServiceOptions = {}): Services {
  const s = {} as Services;
  s.setup = new SetupService(ctx, opts.setupPaceMs ?? 350);
  s.tickets = new TicketService(ctx);
  s.offers = new OfferService(ctx, s);
  s.orders = new OrderService(ctx, s);
  s.overview = new OverviewService(ctx, opts.overviewDebounceMs ?? 4000);
  s.proofs = new ProofService(ctx, s);
  s.reviews = new ReviewService(ctx);
  s.boosts = new BoostService(ctx);
  s.exports = new ExportService(ctx, s);
  s.retention = new RetentionService(ctx, s);
  s.community = new CommunityService(ctx);
  return s;
}
