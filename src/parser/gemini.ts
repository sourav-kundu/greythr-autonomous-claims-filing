import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config';
import { ParsedInvoice, parseJsonResponse } from './invoice';

export async function parseWithGemini(
  fileBuffer: Buffer,
  mimeType: string,
  systemPrompt: string,
  model: string
): Promise<ParsedInvoice> {
  const genAI = new GoogleGenerativeAI(config.ai.geminiKey);
  const genModel = genAI.getGenerativeModel({
    model,
    systemInstruction: systemPrompt,
  });

  const base64 = fileBuffer.toString('base64');

  const result = await genModel.generateContent([
    {
      inlineData: {
        mimeType,
        data: base64,
      },
    },
    { text: 'Parse this invoice.' },
  ]);

  const text = result.response.text();
  return parseJsonResponse(text);
}
