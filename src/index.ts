import { config, validateConfig } from './config';
import { startWhatsApp } from './whatsapp/client';
import { registerMessageHandler } from './whatsapp/handler';
import fs from 'fs';

async function main(): Promise<void> {
  console.log('========================================');
  console.log('  GreytHR Claims Bot');
  console.log('========================================');
  console.log(`AI Provider: ${config.ai.provider} (${config.ai.model})`);
  console.log(`GreytHR URL: ${config.greythr.url}`);
  console.log(`WhatsApp Group: ${config.whatsapp.groupName}`);
  console.log('========================================\n');

  // Validate configuration
  validateConfig();

  // Ensure data directories exist
  fs.mkdirSync(config.paths.data, { recursive: true });
  fs.mkdirSync(config.paths.auth, { recursive: true });

  // Start WhatsApp and register message handler
  await startWhatsApp((sock) => {
    registerMessageHandler(sock);
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
