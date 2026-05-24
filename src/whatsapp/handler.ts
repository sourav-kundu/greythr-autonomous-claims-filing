import { WASocket, WAMessage, proto, downloadMediaMessage } from '@whiskeysockets/baileys';
import path from 'path';
import { config } from '../config';
import {
  Claim,
  ClaimType,
  createClaim,
  saveClaim,
  addLineItem,
  saveInvoiceFile,
  formatClaimSummary,
  LineItem,
} from '../claims/store';
import { parseInvoice, ParsedInvoice } from '../parser/invoice';
import { fillClaimOnGreytHR, completeClaimAction, closeBrowserSession, hasActiveSession } from '../greythr/filer';
import { interpretCorrection } from './correction';

// Active claim per group (only one claim at a time per group)
let activeClaim: Claim | null = null;
// Track the last line item added for corrections
let lastLineItemId: string | null = null;

function getMimeType(msg: proto.IMessage): string | null {
  if (msg.imageMessage) return msg.imageMessage.mimetype || 'image/jpeg';
  if (msg.documentMessage) return msg.documentMessage.mimetype || 'application/pdf';
  return null;
}

function getFileName(msg: proto.IMessage): string {
  if (msg.documentMessage?.fileName) return msg.documentMessage.fileName;
  const ext = msg.imageMessage ? '.jpg' : '.pdf';
  return `invoice-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`;
}

function hasMedia(msg: proto.IMessage): boolean {
  return !!(msg.imageMessage || msg.documentMessage);
}

function getTextBody(msg: proto.IMessage): string {
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.documentMessage?.caption ||
    ''
  ).trim();
}

function isClaimFromPreviousDay(): boolean {
  if (!activeClaim) return false;
  const claimDate = new Date(activeClaim.createdAt).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  return claimDate !== today;
}

async function ensureActiveClaim(sock: WASocket, jid: string): Promise<void> {
  if (activeClaim && isClaimFromPreviousDay()) {
    const oldId = activeClaim.id;
    if (['collecting', 'awaiting_claim_type', 'awaiting_confirmation'].includes(activeClaim.status)) {
      activeClaim.status = 'failed';
      saveClaim(activeClaim);
      console.log(`[${new Date().toLocaleTimeString()}] Auto-closed stale claim ${oldId} from previous day`);
    }
    activeClaim = null;
    lastLineItemId = null;
  }

  if (!activeClaim) {
    activeClaim = createClaim();
    lastLineItemId = null;
    await sendMessage(
      sock,
      jid,
      `Auto-started new claim *${activeClaim.id}*.\n\nSend your invoices (images or PDFs). When done, type *submit*.`
    );
  }
}

async function sendMessage(sock: WASocket, jid: string, text: string): Promise<void> {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`[${timestamp}] Bot reply: ${text.split('\n')[0]}${text.includes('\n') ? '...' : ''}`);
  await sock.sendMessage(jid, { text });
}

async function handleStartClaim(sock: WASocket, jid: string): Promise<void> {
  if (activeClaim) {
    if (['collecting', 'awaiting_claim_type', 'awaiting_confirmation'].includes(activeClaim.status)) {
      activeClaim.status = 'failed';
      saveClaim(activeClaim);
    }
  }

  activeClaim = createClaim();
  lastLineItemId = null;
  await sendMessage(
    sock,
    jid,
    `Started new claim *${activeClaim.id}*.\n\nSend your invoices (images or PDFs) now. You can add a caption/description with each.\n\nWhen done, type *submit*.`
  );
}

interface ProcessedInvoice {
  success: boolean;
  lineItem?: LineItem;
  parsed?: ParsedInvoice;
  error?: string;
}

/** Process a single invoice and return the result (does NOT send a message) */
async function processSingleInvoice(rawMsg: WAMessage): Promise<ProcessedInvoice> {
  const msg = rawMsg.message!;
  const caption = getTextBody(msg);

  try {
    const buffer = (await downloadMediaMessage(rawMsg, 'buffer', {})) as Buffer;
    const mimeType = getMimeType(msg) || 'image/jpeg';
    const fileName = getFileName(msg);

    const filePath = saveInvoiceFile(activeClaim!.id, fileName, buffer);
    const parsed = await parseInvoice(buffer, mimeType);

    if (caption) {
      parsed.description = caption;
    }

    const lineItem = addLineItem(activeClaim!, {
      description: parsed.description,
      amount: parsed.amount,
      currency: parsed.currency,
      invoiceNumber: parsed.invoiceNumber,
      date: parsed.date,
      expenseCategory: parsed.expenseCategory,
      filePath,
      fileName,
      amountBeforeTax: parsed.amountBeforeTax,
      taxAmount: parsed.taxAmount,
    });

    lastLineItemId = lineItem.id;

    return { success: true, lineItem, parsed };
  } catch (error: any) {
    console.error('Error processing invoice:', error);
    return { success: false, error: error.message };
  }
}

/** Format batch results into a single summary message */
function formatBatchSummary(results: ProcessedInvoice[]): string {
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  const lines: string[] = [];

  if (successful.length > 0) {
    lines.push(`Parsed ${successful.length} invoice${successful.length > 1 ? 's' : ''}:\n`);
    successful.forEach((r, i) => {
      const p = r.parsed!;
      const num = i + 1;
      lines.push(
        `*${num}.* [${p.expenseCategory}] ${p.description}\n` +
        `    ${p.currency} ${p.amount} | ${p.date} | ${p.invoiceNumber}`
      );
    });
  }

  if (failed.length > 0) {
    lines.push(`\n${failed.length} invoice${failed.length > 1 ? 's' : ''} failed to process.`);
    failed.forEach((r) => {
      lines.push(`  Error: ${r.error}`);
    });
  }

  lines.push('\nReply with corrections (e.g., "correct #2 amount to 750") or send more invoices.\nType *submit* when done.');

  return lines.join('\n');
}

async function handleCorrection(sock: WASocket, jid: string, text: string): Promise<void> {
  if (!activeClaim) {
    await sendMessage(sock, jid, 'No active claim. Send invoices to start one automatically.');
    return;
  }

  // Use AI to interpret the natural language correction
  const correction = await interpretCorrection(text, activeClaim.lineItems, activeClaim.overallDescription);

  if (!correction) {
    return;
  }

  const { itemIndex, field, value } = correction;

  // Handle overall claim-level fields
  if (field === 'overallDescription') {
    activeClaim.overallDescription = value;
    saveClaim(activeClaim);

    await sendMessage(sock, jid, `Updated overall description to: *${value}*\n\nMake any other changes or type *submit* to proceed.`);
    return;
  }

  // Handle line-item corrections
  if (activeClaim.lineItems.length === 0) {
    await sendMessage(sock, jid, 'No invoices to correct. Send some invoices first.');
    return;
  }

  let item: LineItem | undefined;
  if (itemIndex !== undefined && itemIndex >= 0 && itemIndex < activeClaim.lineItems.length) {
    item = activeClaim.lineItems[itemIndex];
  } else if (lastLineItemId) {
    item = activeClaim.lineItems.find((li) => li.id === lastLineItemId);
  } else {
    item = activeClaim.lineItems[activeClaim.lineItems.length - 1];
  }

  if (!item) {
    await sendMessage(sock, jid, 'Could not find the invoice to correct. Please specify which one (e.g., "correct #2 amount to 750").');
    return;
  }

  switch (field) {
    case 'amount':
      const numVal = parseFloat(value.replace(/[^\d.]/g, ''));
      if (!isNaN(numVal)) item.amount = numVal;
      break;
    case 'description':
      item.description = value;
      break;
    case 'invoiceNumber':
      item.invoiceNumber = value;
      break;
    case 'date':
      item.date = value;
      break;
    case 'currency':
      item.currency = value.toUpperCase();
      break;
    case 'category':
      item.expenseCategory = value.toLowerCase().includes('food') ? 'Food' : 'Conveyance';
      break;
    default:
      await sendMessage(sock, jid, `Could not understand what to change. Try: "change #2 amount to 750" or "change description to Mumbai trip".`);
      return;
  }

  saveClaim(activeClaim);

  const itemNum = activeClaim.lineItems.indexOf(item) + 1;
  await sendMessage(
    sock,
    jid,
    `Updated item #${itemNum} — *${field}* changed to: *${value}*\n\nMake any other changes or type *submit* to proceed.`
  );
}

async function handleSubmit(sock: WASocket, jid: string, text: string): Promise<void> {
  if (!activeClaim) {
    await sendMessage(sock, jid, 'No active claim. Send invoices to start one automatically.');
    return;
  }

  if (activeClaim.lineItems.length === 0) {
    await sendMessage(sock, jid, 'No invoices added yet. Send some invoices first.');
    return;
  }

  const descMatch = text.replace(/^(submit|done)\s*/i, '').trim();
  if (descMatch) {
    activeClaim.overallDescription = descMatch;
  }

  if (!activeClaim.overallDescription) {
    const dates = activeClaim.lineItems.map((li) => li.date).sort();
    const firstDate = dates[0];
    const lastDate = dates[dates.length - 1];
    activeClaim.overallDescription =
      firstDate === lastDate
        ? `Travel Reimbursement - ${firstDate}`
        : `Travel Reimbursement - ${firstDate} to ${lastDate}`;
  }

  activeClaim.status = 'awaiting_claim_type';
  saveClaim(activeClaim);

  await sendMessage(
    sock,
    jid,
    `Which claim type?\n\nReply *1* for: Travel Expenses - Others than cadence\nReply *2* for: Travel Expenses - Cadence`
  );
}

async function handleClaimTypeSelection(sock: WASocket, jid: string, choice: string): Promise<void> {
  if (!activeClaim || activeClaim.status !== 'awaiting_claim_type') {
    return;
  }

  const claimType: ClaimType = choice === '2' ? 'cadence' : 'non-cadence';
  const label = claimType === 'cadence' ? 'Travel Expenses - Cadence' : 'Travel Expenses - Others than cadence';

  activeClaim.claimType = claimType;
  activeClaim.status = 'awaiting_confirmation';
  saveClaim(activeClaim);

  const summary = formatClaimSummary(activeClaim);
  await sendMessage(
    sock,
    jid,
    `Claim type: *${label}*\n\n${summary}\n\nProceed with creating this claim on GreytHR?\nReply *yes* to continue or *cancel* to abort.`
  );
}

/** Phase 1: User confirmed — fill the claim on GreytHR (don't submit yet) */
async function handleConfirm(sock: WASocket, jid: string): Promise<void> {
  if (!activeClaim || activeClaim.status !== 'awaiting_confirmation') {
    await sendMessage(sock, jid, 'No claim awaiting confirmation. Type *submit* first to review.');
    return;
  }

  activeClaim.status = 'filling_greythr';
  saveClaim(activeClaim);

  await sendMessage(sock, jid, 'Filling claim on GreytHR... This may take a minute.');

  try {
    const result = await fillClaimOnGreytHR(activeClaim, () => {
      // Called if 5-min timeout expires with no user action
      if (activeClaim && activeClaim.status === 'awaiting_greythr_action') {
        activeClaim.status = 'failed';
        saveClaim(activeClaim);
        sendMessage(sock, jid,
          'No response received in 5 minutes. Browser session closed.\n' +
          'Your invoices are saved locally. Type *submit* to try again.'
        );
        activeClaim = null;
        lastLineItemId = null;
      }
    });

    if (result.filled) {
      // Claim filled successfully — ask user what to do
      activeClaim.status = 'awaiting_greythr_action';
      saveClaim(activeClaim);

      const totalInfo = result.totalAmount ? `\nTotal: *${result.totalAmount}*` : '';
      await sendMessage(
        sock,
        jid,
        `Claim has been filled on GreytHR!${totalInfo}\n\n` +
        `What would you like to do?\n\n` +
        `Reply *1* — Submit for Approval\n` +
        `Reply *2* — Save & Submit Later (you can review and submit yourself)\n\n` +
        `_You have 5 minutes to respond before the session expires._`
      );
    } else if (result.savedAsDraft) {
      activeClaim.status = 'draft_saved';
      activeClaim.submittedAt = new Date().toISOString();
      activeClaim.greythrUrl = result.url;
      saveClaim(activeClaim);
      await sendMessage(
        sock,
        jid,
        `Could not fully fill the claim. It has been saved as a *draft* on GreytHR.\n\n` +
        `Error: ${result.error}\n\nComplete it manually here:\n${result.url}`
      );
      activeClaim = null;
      lastLineItemId = null;
    } else {
      activeClaim.status = 'failed';
      saveClaim(activeClaim);
      await sendMessage(
        sock,
        jid,
        `Failed to fill claim on GreytHR.\n\nError: ${result.error}\n\n` +
        `Your invoices are saved locally. You can try again with *submit* or file manually.`
      );
      activeClaim = null;
      lastLineItemId = null;
    }
  } catch (error: any) {
    if (activeClaim) {
      activeClaim.status = 'failed';
      saveClaim(activeClaim);
    }
    await closeBrowserSession();
    await sendMessage(
      sock,
      jid,
      `Unexpected error: ${error.message}\n\nYour invoices are saved locally. File manually at:\n${config.greythr.url}${config.greythr.claimsPath}`
    );
    activeClaim = null;
    lastLineItemId = null;
  }
}

/** Phase 2: User chose to submit or save as draft */
async function handleGreytHRAction(sock: WASocket, jid: string, choice: string): Promise<void> {
  if (!activeClaim || activeClaim.status !== 'awaiting_greythr_action') {
    return;
  }

  const action = choice === '1' ? 'submit' : 'save_draft';
  const actionLabel = action === 'submit' ? 'Submitting for approval' : 'Saving as draft';

  await sendMessage(sock, jid, `${actionLabel}...`);

  activeClaim.status = 'filing';
  saveClaim(activeClaim);

  try {
    const result = await completeClaimAction(action);

    if (action === 'submit' && result.success) {
      activeClaim.status = 'filed';
      activeClaim.submittedAt = new Date().toISOString();
      activeClaim.greythrUrl = result.url;
      saveClaim(activeClaim);
      await sendMessage(
        sock,
        jid,
        `Claim submitted for approval!\n\nView your claim here:\n${result.url}`
      );
    } else if (action === 'save_draft' || result.savedAsDraft) {
      activeClaim.status = 'draft_saved';
      activeClaim.submittedAt = new Date().toISOString();
      activeClaim.greythrUrl = result.url;
      saveClaim(activeClaim);
      await sendMessage(
        sock,
        jid,
        `Claim saved as draft on GreytHR.\n\nYou can review and submit it manually here:\n${result.url}`
      );
    } else {
      activeClaim.status = 'failed';
      saveClaim(activeClaim);
      await sendMessage(
        sock,
        jid,
        `Failed to complete action.\n\nError: ${result.error}\n\nFile manually at:\n${config.greythr.url}${config.greythr.claimsPath}`
      );
    }
  } catch (error: any) {
    activeClaim.status = 'failed';
    saveClaim(activeClaim);
    await sendMessage(
      sock,
      jid,
      `Unexpected error: ${error.message}\n\nFile manually at:\n${config.greythr.url}${config.greythr.claimsPath}`
    );
  }

  activeClaim = null;
  lastLineItemId = null;
}

async function handleCancel(sock: WASocket, jid: string): Promise<void> {
  if (hasActiveSession()) {
    await closeBrowserSession();
  }
  if (activeClaim) {
    const id = activeClaim.id;
    activeClaim.status = 'failed';
    saveClaim(activeClaim);
    activeClaim = null;
    lastLineItemId = null;
    await sendMessage(sock, jid, `Claim *${id}* cancelled. Type *start new claim* to begin again.`);
  } else {
    await sendMessage(sock, jid, 'No active claim to cancel.');
  }
}

async function handleStatus(sock: WASocket, jid: string): Promise<void> {
  if (!activeClaim) {
    await sendMessage(sock, jid, 'No active claim. Send an invoice to start one automatically.');
    return;
  }

  const summary = formatClaimSummary(activeClaim);
  await sendMessage(sock, jid, `Current claim: *${activeClaim.id}*\nStatus: ${activeClaim.status}\n\n${summary}`);
}

// Cache: group JID -> group name
const groupNameCache: Map<string, string> = new Map();
// Track message IDs sent by the bot
const botSentMessageIds: Set<string> = new Set();
// Rolling window: queued media messages waiting to be processed
let pendingMedia: { jid: string; msg: WAMessage }[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let isProcessingBatch = false;

async function getGroupName(sock: WASocket, jid: string): Promise<string | null> {
  if (groupNameCache.has(jid)) {
    return groupNameCache.get(jid)!;
  }
  try {
    const meta = await sock.groupMetadata(jid);
    groupNameCache.set(jid, meta.subject);
    return meta.subject;
  } catch (err: any) {
    console.log(`  Could not fetch group metadata: ${err.message}`);
    return null;
  }
}

function looksLikeCorrection(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('correct') ||
    lower.includes('change') ||
    lower.includes('update') ||
    lower.includes('fix') ||
    lower.includes('should be') ||
    lower.includes('amount') ||
    lower.includes('description') ||
    lower.includes('date') ||
    lower.includes('invoice') ||
    lower.includes('category') ||
    lower.includes('currency') ||
    /\b(rs|inr|usd|\$|rupee)\b/i.test(lower)
  );
}

/** Process the accumulated media batch — called after the rolling window expires */
async function processPendingMedia(sock: WASocket): Promise<void> {
  if (isProcessingBatch || pendingMedia.length === 0) return;

  isProcessingBatch = true;
  const batch = [...pendingMedia];
  pendingMedia = [];
  batchTimer = null;

  const jid = batch[0].jid;
  const total = batch.length;

  try {
    await ensureActiveClaim(sock, jid);
    await sendMessage(sock, jid, `Processing ${total} invoice${total > 1 ? 's' : ''}...`);

    console.log(`  Processing ${total} invoices in parallel...`);
    const results = await Promise.all(
      batch.map((item, i) => {
        console.log(`  Started invoice ${i + 1}/${total}`);
        return processSingleInvoice(item.msg);
      })
    );

    await sendMessage(sock, jid, formatBatchSummary(results));
  } catch (error: any) {
    console.error('Error processing media batch:', error);
    await sendMessage(sock, jid, `Error processing invoices: ${error.message}`);
  } finally {
    isProcessingBatch = false;

    if (pendingMedia.length > 0) {
      resetBatchTimer(sock);
    }
  }
}

/** Reset the rolling window timer — called each time a new media message arrives */
function resetBatchTimer(sock: WASocket): void {
  if (batchTimer) {
    clearTimeout(batchTimer);
  }
  const windowMs = config.whatsapp.batchWindowSeconds * 1000;
  console.log(`  Batch timer reset — waiting ${config.whatsapp.batchWindowSeconds}s for more messages...`);
  batchTimer = setTimeout(() => processPendingMedia(sock), windowMs);
}

export function registerMessageHandler(sock: WASocket): void {
  // Intercept outgoing messages to track their IDs
  const origSockSend = sock.sendMessage.bind(sock);
  sock.sendMessage = async (jid: string, content: any, options?: any) => {
    const result = await origSockSend(jid, content, options);
    if (result?.key?.id) {
      botSentMessageIds.add(result.key.id);
      setTimeout(() => botSentMessageIds.delete(result.key.id!), 60000);
    }
    return result;
  };

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      const jid = msg.key.remoteJid;

      if (!jid || !jid.endsWith('@g.us')) continue;
      if (msg.key.id && botSentMessageIds.has(msg.key.id)) continue;
      if (!msg.message) continue;

      const groupName = await getGroupName(sock, jid);
      if (groupName !== config.whatsapp.groupName) continue;

      const rawMessage = msg.message;
      const text = getTextBody(rawMessage);
      const hasMediaContent = hasMedia(rawMessage);

      if (!hasMediaContent && !text) continue;

      const timestamp = new Date().toLocaleTimeString();
      console.log(`\n[${timestamp}] Message in "${groupName}":`);
      if (hasMediaContent) {
        console.log(`  Type: ${rawMessage.imageMessage ? 'Image' : 'Document/PDF'}${text ? ` | Caption: "${text}"` : ''}`);
      } else {
        console.log(`  Text: "${text}"`);
      }

      if (hasMediaContent) {
        // Queue media into the rolling window batch
        pendingMedia.push({ jid, msg });
        console.log(`  Queued for batch (${pendingMedia.length} pending)`);
        resetBatchTimer(sock);
      } else {
        // Text commands are handled immediately
        const lower = text.toLowerCase();

        if (lower.includes('start new claim') || lower.includes('new claim')) {
          await handleStartClaim(sock, jid);
        } else if (lower === 'submit' || lower === 'done' || lower === 'proceed' || lower.startsWith('submit ') || lower.startsWith('done ')) {
          await handleSubmit(sock, jid, text);
        } else if (activeClaim?.status === 'awaiting_claim_type' && (lower === '1' || lower === '2')) {
          await handleClaimTypeSelection(sock, jid, lower);
        } else if (activeClaim?.status === 'awaiting_confirmation' && /^(yes|y|confirm)$/i.test(lower)) {
          await handleConfirm(sock, jid);
        } else if (activeClaim?.status === 'awaiting_greythr_action' && (lower === '1' || lower === '2')) {
          await handleGreytHRAction(sock, jid, lower);
        } else if (lower === 'cancel') {
          await handleCancel(sock, jid);
        } else if (lower === 'status') {
          await handleStatus(sock, jid);
        } else if (activeClaim && looksLikeCorrection(lower)) {
          await handleCorrection(sock, jid, text);
        }
      }
    }
  });
}
