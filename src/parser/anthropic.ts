import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { ParsedInvoice, parseJsonResponse } from './invoice';

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export async function parseWithAnthropic(
  fileBuffer: Buffer,
  mimeType: string,
  systemPrompt: string,
  model: string
): Promise<ParsedInvoice> {
  const client = new Anthropic({ apiKey: config.ai.anthropicKey });

  const base64 = fileBuffer.toString('base64');

  const isPdf = mimeType === 'application/pdf';

  const content: Anthropic.MessageCreateParams['messages'][0]['content'] = isPdf
    ? [
        {
          type: 'document' as const,
          source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: base64 },
        },
        { type: 'text' as const, text: 'Parse this invoice.' },
      ]
    : [
        {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: mimeType as ImageMediaType,
            data: base64,
          },
        },
        { type: 'text' as const, text: 'Parse this invoice.' },
      ];

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content }],
  });

  const text =
    response.content[0].type === 'text' ? response.content[0].text : '';
  return parseJsonResponse(text);
}
