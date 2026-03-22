import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config';
import { LineItem } from '../claims/store';

export interface CorrectionResult {
  itemIndex?: number; // 0-based index of the item to correct; undefined = last item
  field: string; // amount, description, invoiceNumber, date, currency, category, overallDescription
  value: string; // the new value
}

function buildPrompt(userMessage: string, lineItems: LineItem[], overallDescription: string): string {
  const itemsList = lineItems.length > 0
    ? lineItems
        .map(
          (item, i) =>
            `${i + 1}. [${item.expenseCategory}] ${item.description} | ${item.currency} ${item.amount} | ${item.date} | Invoice: ${item.invoiceNumber}`
        )
        .join('\n')
    : '(no items yet)';

  return `You are a correction parser for an expense claim system.

The claim has an overall description and individual line items:

Overall description: "${overallDescription || '(not set)'}"

Line items:
${itemsList}

User message: "${userMessage}"

Determine what the user wants to change:

- If they want to change the OVERALL claim description (e.g., "change description to Mumbai trip", "overall description should be Stackconnect Gurugram", "rename the claim to ..."), set field to "overallDescription" and itemNumber to null.
- If they want to change a SPECIFIC line item, determine:
  1. itemNumber (1-based). If they say "3rd", "#3", "item 3", that's item 3. If not specified, use null (meaning the last item).
  2. field: "amount", "description", "invoiceNumber", "date", "currency", or "category"
  3. value: the new value. For amounts, extract just the number. For category, use "Food" or "Conveyance". For dates, use YYYY-MM-DD.

IMPORTANT: If the user says "change description to X" WITHOUT mentioning a specific item number, they mean the OVERALL claim description, NOT an individual item.
If they say "change #2 description to X" or "change 2nd item description", they mean item #2's description.

Respond ONLY with valid JSON, no markdown fences:
{"itemNumber": null, "field": "overallDescription", "value": "Stackconnect Gurugram"}
or
{"itemNumber": 3, "field": "amount", "value": "650"}`;
}

function parseResponse(text: string): CorrectionResult | null {
  try {
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);

    if (!parsed.field || parsed.value === undefined) return null;

    return {
      itemIndex: parsed.itemNumber ? parsed.itemNumber - 1 : undefined,
      field: parsed.field,
      value: String(parsed.value),
    };
  } catch {
    return null;
  }
}

async function interpretWithAnthropic(prompt: string): Promise<string> {
  const client = new Anthropic({ apiKey: config.ai.anthropicKey });
  const response = await client.messages.create({
    model: config.ai.model,
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  });
  return response.content[0].type === 'text' ? response.content[0].text : '';
}

async function interpretWithOpenAI(prompt: string): Promise<string> {
  const client = new OpenAI({ apiKey: config.ai.openaiKey });
  const response = await client.chat.completions.create({
    model: config.ai.model,
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  });
  return response.choices[0]?.message?.content || '';
}

async function interpretWithGemini(prompt: string): Promise<string> {
  const genAI = new GoogleGenerativeAI(config.ai.geminiKey);
  const model = genAI.getGenerativeModel({ model: config.ai.model });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

export async function interpretCorrection(
  userMessage: string,
  lineItems: LineItem[],
  overallDescription: string
): Promise<CorrectionResult | null> {
  // First try simple regex patterns (no API call needed)
  const simple = trySimplePatterns(userMessage, lineItems.length);
  if (simple) return simple;

  // Fall back to AI interpretation
  const prompt = buildPrompt(userMessage, lineItems, overallDescription);

  try {
    let responseText: string;

    switch (config.ai.provider) {
      case 'anthropic':
        responseText = await interpretWithAnthropic(prompt);
        break;
      case 'openai':
        responseText = await interpretWithOpenAI(prompt);
        break;
      case 'gemini':
        responseText = await interpretWithGemini(prompt);
        break;
      default:
        return null;
    }

    return parseResponse(responseText);
  } catch (error: any) {
    console.error('Error interpreting correction:', error.message);
    return null;
  }
}

/** Try common patterns without calling the AI API */
function trySimplePatterns(text: string, itemCount: number): CorrectionResult | null {
  // Check for overall description change (no item number mentioned)
  // "change description to X", "overall description should be X", "rename claim to X"
  const overallMatch = text.match(
    /(?:overall\s+)?description\s+(?:is|should be|to|=|:)\s*(.+)/i
  );
  if (overallMatch) {
    // Only treat as overall if no item number is mentioned
    const hasItemRef = /(?:#\d+|\d+(?:st|nd|rd|th)|item\s+\d+)/i.test(text);
    if (!hasItemRef) {
      return { field: 'overallDescription', value: overallMatch[1].trim() };
    }
  }

  // Extract item number: "correct #3", "3rd item", "item 3", "correct the 3rd"
  let itemIndex: number | undefined;
  const itemMatch = text.match(
    /(?:#(\d+)|(\d+)(?:st|nd|rd|th)|item\s+(\d+)|number\s+(\d+))/i
  );
  if (itemMatch) {
    const num = parseInt(itemMatch[1] || itemMatch[2] || itemMatch[3] || itemMatch[4]);
    if (num >= 1 && num <= itemCount) {
      itemIndex = num - 1;
    }
  }

  // Simple field + value patterns for line items
  const patterns: { field: string; regex: RegExp }[] = [
    { field: 'amount', regex: /(?:amount|rs|inr|price|cost)\s*(?:is|should be|to|=|:)?\s*(?:rs\.?|inr|₹)?\s*(\d[\d,.]*)/i },
    { field: 'description', regex: /(?:item\s+)?description\s+(?:is|should be|to|=|:)\s*(.+)/i },
    { field: 'invoiceNumber', regex: /invoice\s*(?:no|number|#)\s*(?:is|should be|to|=|:)\s*(.+)/i },
    { field: 'date', regex: /date\s+(?:is|should be|to|=|:)\s*(.+)/i },
    { field: 'currency', regex: /currency\s+(?:is|should be|to|=|:)\s*(.+)/i },
    { field: 'category', regex: /category\s+(?:is|should be|to|=|:)\s*(.+)/i },
  ];

  for (const { field, regex } of patterns) {
    const match = text.match(regex);
    if (match) {
      // If item index found, this is a line-item description change
      if (field === 'description' && itemIndex !== undefined) {
        return { itemIndex, field, value: match[1].trim() };
      }
      return { itemIndex, field, value: match[1].trim() };
    }
  }

  return null;
}
