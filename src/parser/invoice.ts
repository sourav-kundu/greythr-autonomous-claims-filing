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
  amountBeforeTax?: number;
  taxAmount?: number;
}

const SYSTEM_PROMPT = `You are an invoice parser. Extract the following from the invoice image/document:

1. **description**: A short description of what the invoice is for (e.g., "Uber ride from airport to office", "Lunch at restaurant", "Hotel stay").
2. **amount**: The total amount as a number (no currency symbol). Use the final/total/grand-total amount the customer paid.
3. **currency**: The currency code (e.g., "INR", "USD", "EUR"). Default to "INR" if not clearly specified.
4. **invoiceNumber**: The invoice/receipt/bill number. If not found, use "N/A".
5. **date**: The invoice date in YYYY-MM-DD format.
6. **expenseCategory**: Classify as either "Conveyance" or "Food".
   - "Conveyance" for: taxi, Uber, Ola, cab, auto-rickshaw, bus, train, metro, flight, any transport/travel.
   - "Food" for: restaurant, lunch, dinner, breakfast, snacks, beverages, cafe, any food/drink.
   - Default to "Conveyance" if unclear.
7. **amountBeforeTax** (FOOD BILLS ONLY — omit for transport): The pre-tax / sub-total / net amount before GST/VAT/service tax is added. Look for labels like "Sub Total", "Subtotal", "Net Amount", "Amount Before Tax", "Taxable Value". Number only, no symbol.
8. **taxAmount** (FOOD BILLS ONLY — omit for transport): The total tax on the bill — sum of GST/CGST/SGST/IGST/VAT/service-tax components. If the bill shows CGST + SGST separately, add them. Number only.

Rules for fields 7 & 8:
- Include them ONLY for "Food" expenses where the bill clearly breaks out tax. If the food bill has no tax breakdown, omit both fields entirely.
- NEVER include them for "Conveyance" — taxi/Uber bills do not need tax bifurcation in this system.
- amount must equal amountBeforeTax + taxAmount (within rounding). If they don't add up, omit both rather than guessing.

Respond ONLY with valid JSON, no markdown fences.

Example for a taxi bill:
{"description": "Uber ride to airport", "amount": 450, "currency": "INR", "invoiceNumber": "UB123", "date": "2026-05-20", "expenseCategory": "Conveyance"}

Example for a restaurant bill with tax breakdown:
{"description": "Dinner at Mainland China", "amount": 1180, "currency": "INR", "invoiceNumber": "INV987", "date": "2026-05-20", "expenseCategory": "Food", "amountBeforeTax": 1000, "taxAmount": 180}`;

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

  // Tax bifurcation: only honor for Food, and only if both fields are present
  // and sum to ~the total (within 1 unit of currency to allow rounding).
  let amountBeforeTax: number | undefined;
  let taxAmount: number | undefined;
  if (category === 'Food'
      && parsed.amountBeforeTax !== undefined && parsed.amountBeforeTax !== null
      && parsed.taxAmount !== undefined && parsed.taxAmount !== null) {
    const before = Number(parsed.amountBeforeTax);
    const tax = Number(parsed.taxAmount);
    const total = Number(parsed.amount) || 0;
    if (!isNaN(before) && !isNaN(tax) && Math.abs(before + tax - total) <= 1) {
      amountBeforeTax = before;
      taxAmount = tax;
    }
  }

  return {
    description: parsed.description || 'Unknown',
    amount: Number(parsed.amount) || 0,
    currency: parsed.currency || 'INR',
    invoiceNumber: parsed.invoiceNumber || 'N/A',
    date: parsed.date || new Date().toISOString().slice(0, 10),
    expenseCategory: category,
    amountBeforeTax,
    taxAmount,
  };
}
