import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export type AIProvider = 'anthropic' | 'openai' | 'gemini';

export const config = {
  ai: {
    provider: (process.env.AI_PROVIDER || 'anthropic') as AIProvider,
    model: process.env.AI_MODEL || 'claude-sonnet-4-20250514',
    anthropicKey: process.env.ANTHROPIC_API_KEY || '',
    openaiKey: process.env.OPENAI_API_KEY || '',
    geminiKey: process.env.GEMINI_API_KEY || '',
  },
  greythr: {
    url: process.env.GREYTHR_URL || 'https://browserstack.greythr.com',
    claimsPath: '/v2/employee/claims/advance',
  },
  whatsapp: {
    groupName: process.env.WHATSAPP_GROUP_NAME || 'GreytHr Travel Reimbursement',
    batchWindowSeconds: parseInt(process.env.BATCH_WINDOW_SECONDS || '5', 10),
  },
  paths: {
    data: path.resolve(process.cwd(), 'data'),
    auth: path.resolve(process.cwd(), 'auth'),
    browserData: path.resolve(process.cwd(), 'browser-data'),
  },
};

export function validateConfig(): void {
  const { provider, anthropicKey, openaiKey, geminiKey } = config.ai;

  const keyMap: Record<AIProvider, string> = {
    anthropic: anthropicKey,
    openai: openaiKey,
    gemini: geminiKey,
  };

  if (!keyMap[provider]) {
    console.error(
      `ERROR: AI_PROVIDER is set to "${provider}" but the corresponding API key is missing.`
    );
    console.error(`Please set the appropriate key in your .env file.`);
    process.exit(1);
  }
}
