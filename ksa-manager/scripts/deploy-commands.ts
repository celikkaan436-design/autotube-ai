import { REST, Routes } from 'discord.js';
import { loadEnvFile, parseEnv } from '../src/config/env.js';
import { commandDefinitions } from '../src/discord/commands.js';

/** Registriert alle Slash-Befehle ausschließlich auf dem Zielserver (sofort wirksam). */
async function main(): Promise<void> {
  loadEnvFile();
  const config = parseEnv(process.env);
  const rest = new REST({ version: '10' }).setToken(config.token);
  const body = commandDefinitions();
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body });
  console.log(`${body.length} Befehle auf Server ${config.guildId} registriert.`);
}

main().catch((err: unknown) => {
  console.error('Registrierung fehlgeschlagen:', err instanceof Error ? err.message : err);
  process.exit(1);
});
