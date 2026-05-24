import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';

export type ExpenseCategory = 'Conveyance' | 'Food';

export interface LineItem {
  id: string;
  description: string;
  amount: number;
  currency: string;
  invoiceNumber: string;
  date: string; // YYYY-MM-DD
  expenseCategory: ExpenseCategory;
  filePath: string; // path to the saved invoice file
  fileName: string;
  // Tax bifurcation — only used for Cadence claims with Food items.
  // GreytHR's Cadence form has separate "Amount Before Tax" and "Tax Amount"
  // fields for Other-expenses (food). For Travel Expense (taxi) the form
  // accepts 0.00 for both, so we leave these undefined.
  amountBeforeTax?: number;
  taxAmount?: number;
}

export type ClaimType = 'non-cadence' | 'cadence';

export type ClaimStatus =
  | 'collecting' // user is uploading invoices
  | 'awaiting_claim_type' // summary shown, waiting for claim type selection
  | 'awaiting_confirmation' // claim type selected, waiting for "confirm"
  | 'filling_greythr' // Playwright is filling entries on GreytHR (not yet submitted)
  | 'awaiting_greythr_action' // filled on GreytHR, waiting for user to choose submit or save
  | 'filing' // Playwright is submitting on GreytHR
  | 'filed' // successfully filed
  | 'draft_saved' // filed failed, saved as draft
  | 'failed'; // completely failed

export interface Claim {
  id: string;
  createdAt: string;
  submittedAt?: string;
  status: ClaimStatus;
  claimType?: ClaimType;
  overallDescription: string;
  lineItems: LineItem[];
  greythrUrl?: string;
}

function claimDir(claimId: string): string {
  return path.join(config.paths.data, 'claims', claimId);
}

function claimFile(claimId: string): string {
  return path.join(claimDir(claimId), 'claim.json');
}

export function createClaim(): Claim {
  const id = `claim-${new Date().toISOString().slice(0, 10)}-${uuidv4().slice(0, 6)}`;
  const claim: Claim = {
    id,
    createdAt: new Date().toISOString(),
    status: 'collecting',
    overallDescription: '',
    lineItems: [],
  };

  const dir = claimDir(id);
  fs.mkdirSync(dir, { recursive: true });
  saveClaim(claim);
  return claim;
}

export function saveClaim(claim: Claim): void {
  const dir = claimDir(claim.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(claimFile(claim.id), JSON.stringify(claim, null, 2));
}

export function loadClaim(claimId: string): Claim | null {
  const file = claimFile(claimId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

export function addLineItem(claim: Claim, item: Omit<LineItem, 'id'>): LineItem {
  const lineItem: LineItem = { id: uuidv4().slice(0, 8), ...item };
  claim.lineItems.push(lineItem);
  saveClaim(claim);
  return lineItem;
}

export function updateLineItem(
  claim: Claim,
  lineItemId: string,
  updates: Partial<Omit<LineItem, 'id' | 'filePath' | 'fileName'>>
): void {
  const item = claim.lineItems.find((li) => li.id === lineItemId);
  if (item) {
    Object.assign(item, updates);
    saveClaim(claim);
  }
}

export function saveInvoiceFile(claimId: string, fileName: string, buffer: Buffer): string {
  const dir = claimDir(claimId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

export function formatClaimSummary(claim: Claim): string {
  if (claim.lineItems.length === 0) {
    return 'No invoices added yet.';
  }

  const lines = claim.lineItems.map((item, i) => {
    return `${i + 1}. [${item.expenseCategory}] ${item.description} | ${item.currency} ${item.amount} | ${item.date} | ${item.invoiceNumber}`;
  });

  const totals = claim.lineItems.reduce<Record<string, number>>((acc, item) => {
    acc[item.currency] = (acc[item.currency] || 0) + item.amount;
    return acc;
  }, {});

  const totalStr = Object.entries(totals)
    .map(([currency, amount]) => `${currency} ${amount.toFixed(2)}`)
    .join(', ');

  const desc = claim.overallDescription || '(auto-generated on submission)';

  return [
    `Claim Summary (${claim.lineItems.length} items):`,
    '',
    ...lines,
    '',
    `Total: ${totalStr}`,
    `Description: "${desc}"`,
  ].join('\n');
}
