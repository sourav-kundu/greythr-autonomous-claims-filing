import { config, AIProvider } from '../config';
import { parseWithAnthropic } from './anthropic';
import { parseWithOpenAI } from './openai';
import { parseWithGemini } from './gemini';
import { ExpenseCategory } from '../claims/store';

export interface ParsedInvoice {
  description: string;
  amount: number;
  currency: string;
  invoiceNumber: string;
  date: string; // YYYY-MM-DD
  expenseCategory: ExpenseCategory;
}

const SYSTEM_PROMPT = `You are an invoice parser. Extract the following from the invoice image/document:

1. **description**: A short description of what the invoice is for (e.g., "Uber ride from airport to office", "Lunch at restaurant", "Hotel stay").
2. **amount**: The total amount as a number (no currency symbol). Use the final/total amount.
3. **currency**: The currency code (e.g., "INR", "USD", "EUR"). Default to "INR" if not clearly specified.
4. **invoiceNumber**: The invoice/receipt/bill number. If not found, use "N/A".
5. **date**: The invoice date in YYYY-MM-DD format.
6. **expenseCategory**: Classify as either "Conveyance" or "Food".
   - "Conveyance" for: taxi, Uber, Ola, cab, auto-rickshaw, bus, train, metro, flight, any transport/travel.
   - "Food" for: restaurant, lunch, dinner, breakfast, snacks, beverages, cafe, any food/drink.
   - Default to "Conveyance" if unclear.

Respond ONLY with valid JSON, no markdown fences:
{"description": "...", "amount": 123.45, "currency": "INR", "invoiceNumber": "...", "date": "YYYY-MM-DD", "expenseCategory": "Conveyance"}`;

export async function parseInvoice(
  fileBuffer: Buffer,
  mimeType: string
): Promise<ParsedInvoice> {
  const parsers: Record<AIProvider, typeof parseWithAnthropic> = {
    anthropic: parseWithAnthropic,
    openai: parseWithOpenAI,
    gemini: parseWithGemini,
  };

  const parser = parsers[config.ai.provider];
  return parser(fileBuffer, mimeType, SYSTEM_PROMPT, config.ai.model);
}

export function parseJsonResponse(text: string): ParsedInvoice {
  // Strip markdown fences if present
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const parsed = JSON.parse(cleaned);

  const category = parsed.expenseCategory === 'Food' ? 'Food' : 'Conveyance';

  return {
    description: parsed.description || 'Unknown',
    amount: Number(parsed.amount) || 0,
    currency: parsed.currency || 'INR',
    invoiceNumber: parsed.invoiceNumber || 'N/A',
    date: parsed.date || new Date().toISOString().slice(0, 10),
    expenseCategory: category,
  };
}
