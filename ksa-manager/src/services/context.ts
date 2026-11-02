import type { AppConfig } from '../config/env.js';
import type { SettingsService } from '../config/settings.js';
import type { Db } from '../db/database.js';
import type { DiscordPort } from '../discord/port.js';
import type { Actor, AuthConfig } from '../domain/permissions.js';
import type { Logger } from '../logging/logger.js';
import type { Clock } from '../util/time.js';
import type { KeyedMutex } from '../util/mutex.js';
import type { AuditService } from './audit.js';
import type { ResourceRegistry } from './registry.js';
import type { Repo } from './repo.js';

export type ContextConfig = Pick<
  AppConfig,
  'guildId' | 'ownerIds' | 'timezone' | 'logoUrl' | 'proofStorageDir' | 'enableMessageContent'
>;

/** Gemeinsame Abhängigkeiten aller Services (Dependency Injection, testbar). */
export interface AppContext {
  config: ContextConfig;
  db: Db;
  log: Logger;
  port: DiscordPort;
  clock: Clock;
  settings: SettingsService;
  registry: ResourceRegistry;
  locks: KeyedMutex;
  audit: AuditService;
  repo: Repo;
}

export function authConfig(ctx: AppContext): AuthConfig {
  return { ownerIds: ctx.config.ownerIds, roles: ctx.registry.roleDirectory() };
}

export type { Actor };
