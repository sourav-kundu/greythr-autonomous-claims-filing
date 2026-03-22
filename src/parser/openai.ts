import OpenAI from 'openai';
import { config } from '../config';
import { ParsedInvoice, parseJsonResponse } from './invoice';

export async function parseWithOpenAI(
  fileBuffer: Buffer,
  mimeType: string,
  systemPrompt: string,
  model: string
): Promise<ParsedInvoice> {
  const client = new OpenAI({ apiKey: config.ai.openaiKey });

  const base64 = fileBuffer.toString('base64');
  const dataUrl = `data:${mimeType};base64,${base64}`;

  const response = await client.chat.completions.create({
    model,
    max_tokens: 1024,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: 'Parse this invoice.' },
        ],
      },
    ],
  });

  const text = response.choices[0]?.message?.content || '';
  return parseJsonResponse(text);
}
