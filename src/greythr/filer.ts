import { chromium, BrowserContext, Page } from 'playwright';
import { config } from '../config';
import { Claim, LineItem } from '../claims/store';

export interface FilingResult {
  success: boolean;
  savedAsDraft: boolean;
  url?: string;
  error?: string;
  totalAmount?: string;
}

const MAX_RETRIES = 3;
const RETRY_DELAYS = [5000, 10000, 20000];
const NAV_TIMEOUT = 30000;
const ACTION_TIMEOUT = 15000;
const GREYTHR_ACTION_TIMEOUT = 5 * 60 * 1000; // 5 minutes

const CLAIM_TYPE_LABELS: Record<string, string> = {
  'non-cadence': 'Travel Expenses - Others than cadence',
  'cadence': 'Travel Expenses - Cadence',
};

// The Cadence claim form uses a different category dropdown than non-cadence:
// non-cadence offers Conveyance/Food/Airfare/Stay/etc directly; Cadence only
// offers "Travel Expense" and "Other expenses". Map our internal categories
// to the cadence labels.
const CADENCE_CATEGORY_LABEL: Record<string, string> = {
  Conveyance: 'Travel Expense',
  Food: 'Other expenses',
};

function categoryLabelFor(claim: Claim, item: LineItem): string {
  if (claim.claimType === 'cadence') {
    return CADENCE_CATEGORY_LABEL[item.expenseCategory] || item.expenseCategory;
  }
  return item.expenseCategory;
}

// Persistent browser session — kept open between fill and submit phases
let activeContext: BrowserContext | null = null;
let activePage: Page | null = null;
let sessionTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

async function getBrowserContext(): Promise<BrowserContext> {
  if (activeContext) return activeContext;
  activeContext = await chromium.launchPersistentContext(config.paths.browserData, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  return activeContext;
}

async function getPage(context: BrowserContext): Promise<Page> {
  if (activePage) return activePage;
  activePage = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  activePage.on('dialog', async (d) => {
    console.log(`  [Dialog] ${d.type()}: ${d.message()}`);
    await d.accept();
  });
  return activePage;
}

/** Clean up the browser session */
export async function closeBrowserSession(): Promise<void> {
  if (sessionTimeoutTimer) {
    clearTimeout(sessionTimeoutTimer);
    sessionTimeoutTimer = null;
  }
  activePage = null;
  if (activeContext) {
    await activeContext.close().catch(() => {});
    activeContext = null;
  }
}

/** Start a 5-minute self-destruct timer for the browser session */
function startSessionTimeout(onTimeout: () => void): void {
  if (sessionTimeoutTimer) clearTimeout(sessionTimeoutTimer);
  sessionTimeoutTimer = setTimeout(async () => {
    console.log('  GreytHR session timed out (5 min). Closing browser.');
    await closeBrowserSession();
    onTimeout();
  }, GREYTHR_ACTION_TIMEOUT);
}

async function ensureLoggedIn(page: Page): Promise<boolean> {
  const claimsUrl = `${config.greythr.url}${config.greythr.claimsPath}`;

  await page.goto(claimsUrl, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });

  if (page.url().includes('accounts.google.com') || page.url().includes('login')) {
    console.log('\n========================================');
    console.log('  SSO Login Required!');
    console.log('  Please complete Google SSO login in the browser window.');
    console.log('  Waiting up to 2 minutes...');
    console.log('========================================\n');

    try {
      await page.waitForURL(`${config.greythr.url}/**`, { timeout: 120000 });
    } catch {
      return false;
    }
  }

  if (!page.url().includes('/v2/')) {
    console.log('  Redirected to v3 portal, navigating to v2 claims...');
    await page.goto(claimsUrl, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
  }

  await page.waitForTimeout(2000);
  return page.url().includes('/v2/') || page.url().includes('/claims');
}

async function clickNewClaim(page: Page): Promise<void> {
  console.log('  Step 1: Clicking "New Claim"...');
  const btn = page.locator('a:has-text("New Claim")').first();
  await btn.waitFor({ timeout: ACTION_TIMEOUT });
  await btn.click();
  await page.waitForTimeout(3000);
}

async function selectClaimType(page: Page, claim: Claim): Promise<void> {
  const label = CLAIM_TYPE_LABELS[claim.claimType || 'non-cadence'];
  console.log(`  Step 2: Selecting claim type "${label}"...`);

  await page.locator(`text=${label}`).first().click();
  await page.waitForTimeout(500);
  await page.locator('button:has-text("Create Claim")').click();
  await page.waitForTimeout(3000);
}

async function selectCategoryAndAddEntry(page: Page, category: string, isFirstEntry: boolean): Promise<void> {
  if (isFirstEntry) {
    // First entry: dropdown is jQuery UI autocomplete (gts-combobox)
    const chevron = page.locator('i.gtscombo-queryall');
    await chevron.waitFor({ timeout: ACTION_TIMEOUT });
    await chevron.click();
    await page.waitForTimeout(1000);

    const menuItem = page.locator(`.ui-autocomplete .ui-menu-item:has-text("${category}")`);
    await menuItem.waitFor({ timeout: ACTION_TIMEOUT });
    await menuItem.click();
    await page.waitForTimeout(500);
  } else {
    // After first entry saved: dropdown becomes a native <select> near "Add Entry" button
    // Try the combo input first (it might still be the jQuery autocomplete in some cases)
    const comboInput = page.locator('input.cb-autocomplete');
    const nativeSelect = page.locator('select:visible');

    if (await nativeSelect.count() > 0) {
      // Native <select> — use selectOption
      await nativeSelect.last().selectOption({ label: category });
      await page.waitForTimeout(500);
    } else if (await comboInput.isVisible().catch(() => false)) {
      // Still jQuery autocomplete
      const chevron = page.locator('i.gtscombo-queryall');
      await chevron.click();
      await page.waitForTimeout(1000);
      const menuItem = page.locator(`.ui-autocomplete .ui-menu-item:has-text("${category}")`);
      await menuItem.waitFor({ timeout: ACTION_TIMEOUT });
      await menuItem.click();
      await page.waitForTimeout(500);
    }
  }

  await page.locator('button.addEntryButton').click();
  await page.waitForTimeout(3000);
}

/** Navigate the jQuery UI datepicker to the correct month/year and click the day */
async function selectDateInPicker(page: Page, dateStr: string): Promise<void> {
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  // Parse YYYY-MM-DD
  const match = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) throw new Error(`Invalid date format: ${dateStr}. Expected YYYY-MM-DD.`);

  const targetYear = parseInt(match[1]);
  const targetMonth = parseInt(match[2]) - 1; // 0-based
  const targetDay = String(parseInt(match[3]));

  // Click the date input to open the datepicker
  await page.locator('input[name="claimDate"]').click();
  await page.waitForTimeout(500);

  // Navigate to the correct month/year
  for (let i = 0; i < 24; i++) {
    const headerText = await page.locator('.ui-datepicker-title').innerText().catch(() => '');
    if (headerText.includes(monthNames[targetMonth]) && headerText.includes(String(targetYear))) {
      break;
    }

    const currentMatch = headerText.match(/(\w+)\s+(\d{4})/);
    if (currentMatch) {
      const currentMonthIdx = monthNames.indexOf(currentMatch[1]);
      const currentYear = parseInt(currentMatch[2]);
      const currentTotal = currentYear * 12 + currentMonthIdx;
      const targetTotal = targetYear * 12 + targetMonth;
      if (targetTotal > currentTotal) {
        await page.locator('.ui-datepicker-next').click();
      } else if (targetTotal < currentTotal) {
        await page.locator('.ui-datepicker-prev').click();
      } else {
        break; // already on correct month
      }
    } else {
      break;
    }
    await page.waitForTimeout(200);
  }

  // Click the target day
  await page.locator(`.ui-datepicker td a:text-is("${targetDay}")`).first().click();
  await page.waitForTimeout(300);
}

async function fillAndSaveEntry(page: Page, item: LineItem, claim: Claim): Promise<void> {
  // Fill Receipt No
  console.log(`    Receipt No: ${item.invoiceNumber}`);
  await page.locator('input[name="receipt"]').click();
  await page.keyboard.type(item.invoiceNumber, { delay: 20 });

  // Fill Claim Amount
  console.log(`    Claim Amount: ${item.amount}`);
  await page.locator('input[name="amount"]').click();
  await page.keyboard.press('Meta+a');
  await page.keyboard.type(item.amount.toString(), { delay: 20 });

  // Cadence-only tax bifurcation for Food (Other expenses). For Travel Expense
  // and for non-cadence claims these fields either don't exist or accept 0.00.
  if (claim.claimType === 'cadence' && item.expenseCategory === 'Food') {
    const before = item.amountBeforeTax ?? item.amount;
    const tax = item.taxAmount ?? 0;
    console.log(`    Amount Before Tax: ${before}, Tax Amount: ${tax}`);
    const beforeInput = page.locator('input[name="amountBeforeTax"]');
    if (await beforeInput.isVisible().catch(() => false)) {
      await beforeInput.click();
      await page.keyboard.press('Meta+a');
      await page.keyboard.type(before.toString(), { delay: 20 });
    }
    const taxInput = page.locator('input[name="taxAmount"]');
    if (await taxInput.isVisible().catch(() => false)) {
      await taxInput.click();
      await page.keyboard.press('Meta+a');
      await page.keyboard.type(tax.toString(), { delay: 20 });
    }
  }

  // Fill Remarks
  console.log(`    Remarks: ${item.description}`);
  await page.locator('textarea[name="remarks"]').click();
  await page.keyboard.type(item.description, { delay: 10 });

  // Select date via datepicker (navigates to correct month/year)
  console.log(`    Claim Date: ${item.date}`);
  await selectDateInPicker(page, item.date);

  // Upload Attachment
  if (item.filePath) {
    console.log(`    Attachment: ${item.fileName}`);
    await page.locator('input[type="file"][name="file"]').setInputFiles(item.filePath);
    await page.waitForTimeout(1000);
  }

  await page.waitForTimeout(500);

  // Click Save — focus the button and press Enter
  console.log('    Saving entry...');
  const saveBtn = page.locator('button.saveEntryButton');
  await saveBtn.scrollIntoViewIfNeeded();
  await saveBtn.focus();
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');

  // Wait for save to complete — the save button should disappear when the entry form closes
  try {
    await page.waitForSelector('button.saveEntryButton', { state: 'hidden', timeout: 15000 });
    console.log('    Entry saved successfully');
  } catch {
    const stillOpen = await page.locator('button.saveEntryButton').isVisible().catch(() => false);
    if (stillOpen) {
      throw new Error('Entry save failed — form still open after clicking Save');
    }
    console.log('    Entry likely saved (form closed)');
  }
  await page.waitForTimeout(1000);
}

async function addLineItemEntry(page: Page, item: LineItem, index: number, isFirstEntry: boolean, claim: Claim): Promise<void> {
  const categoryLabel = categoryLabelFor(claim, item);
  console.log(`  Step 3.${index + 1}: Adding ${categoryLabel} entry (${item.expenseCategory}) — "${item.description}"...`);
  await selectCategoryAndAddEntry(page, categoryLabel, isFirstEntry);
  await fillAndSaveEntry(page, item, claim);
}

async function fillGeneralRemarks(page: Page, claim: Claim): Promise<string> {
  console.log(`  Step 4: Filling General Remarks: "${claim.overallDescription}"...`);

  try {
    const remarksInput = page.locator('input[name="tmplCustomField1"]');
    if (await remarksInput.isVisible().catch(() => false)) {
      await remarksInput.fill(claim.overallDescription);
    }
  } catch { /* optional */ }

  await page.locator('textarea[name="generalRemarks"]').fill(claim.overallDescription);

  let totalAmount = '';
  try {
    totalAmount = await page.evaluate(() => {
      const tds = Array.from(document.querySelectorAll('td'));
      for (const td of tds) {
        if (td.textContent?.trim() === 'Amount Claimed') {
          return td.nextElementSibling?.textContent?.trim() || '';
        }
      }
      const match = document.body.textContent?.match(/Amount Claimed\s+([\d,.]+\s*INR)/);
      return match?.[1] || '';
    });
  } catch { /* ignore */ }

  return totalAmount;
}

async function sendForApproval(page: Page): Promise<void> {
  console.log('  Clicking "Send for Approval"...');
  await page.locator('button.claimTemplateSubmit').click();
  await page.waitForTimeout(3000);

  try {
    const modal = page.locator('.modal:visible, .bootbox:visible');
    if (await modal.isVisible({ timeout: 3000 }).catch(() => false)) {
      const okBtn = modal.locator('button:has-text("OK"), button:has-text("Yes"), button.btn-primary').first();
      if (await okBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await okBtn.click();
        await page.waitForTimeout(3000);
      }
    }
  } catch { /* no dialog */ }
}

async function saveAndSubmitLater(page: Page): Promise<void> {
  console.log('  Clicking "Save & Submit Later"...');
  try {
    await page.locator('button.claimTemplateSaveLater').click();
    await page.waitForTimeout(3000);
  } catch (err: any) {
    console.log(`  Warning: Could not click "Save & Submit Later": ${err.message}`);
  }
}

// =====================================================================
// Phase 1: Fill all entries + general remarks, stop BEFORE submitting
// =====================================================================
export async function fillClaimOnGreytHR(
  claim: Claim,
  onTimeout: () => void
): Promise<FilingResult & { filled: boolean }> {
  try {
    const context = await getBrowserContext();
    const page = await getPage(context);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      console.log(`\nFilling attempt ${attempt}/${MAX_RETRIES}...`);

      try {
        const loggedIn = await ensureLoggedIn(page);
        if (!loggedIn) {
          return { success: false, savedAsDraft: false, filled: false,
            error: 'SSO login timed out. Please log in manually and try again.' };
        }

        await clickNewClaim(page);
        await selectClaimType(page, claim);

        for (let i = 0; i < claim.lineItems.length; i++) {
          await addLineItemEntry(page, claim.lineItems[i], i, i === 0, claim);
        }

        const totalAmount = await fillGeneralRemarks(page, claim);

        // Start 5-min timeout — browser stays open waiting for user decision
        startSessionTimeout(onTimeout);

        return {
          success: false, // not submitted yet
          savedAsDraft: false,
          filled: true,
          totalAmount,
          url: page.url(),
        };
      } catch (error: any) {
        console.log(`Filling attempt ${attempt} failed: ${error.message}`);

        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAYS[attempt - 1];
          console.log(`Waiting ${delay / 1000}s before retry...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          // All retries exhausted — try to save as draft
          try {
            await saveAndSubmitLater(page);
            await closeBrowserSession();
            return { success: false, savedAsDraft: true, filled: false,
              url: `${config.greythr.url}${config.greythr.claimsPath}`,
              error: error.message };
          } catch {
            await closeBrowserSession();
            return { success: false, savedAsDraft: false, filled: false, error: error.message };
          }
        }
      }
    }

    return { success: false, savedAsDraft: false, filled: false, error: 'All attempts failed.' };
  } catch (error: any) {
    await closeBrowserSession();
    return { success: false, savedAsDraft: false, filled: false, error: error.message };
  }
}

// =====================================================================
// Phase 2: Complete the action — Submit for Approval or Save as Draft
// =====================================================================
export async function completeClaimAction(action: 'submit' | 'save_draft'): Promise<FilingResult> {
  // Cancel the timeout timer since user responded
  if (sessionTimeoutTimer) {
    clearTimeout(sessionTimeoutTimer);
    sessionTimeoutTimer = null;
  }

  if (!activePage) {
    return { success: false, savedAsDraft: false,
      error: 'Browser session expired. Please try filing the claim again.' };
  }

  try {
    if (action === 'submit') {
      await sendForApproval(activePage);
      const url = activePage.url();
      await closeBrowserSession();
      return {
        success: true,
        savedAsDraft: false,
        url: url.includes('claims') || url.includes('apply')
          ? url : `${config.greythr.url}${config.greythr.claimsPath}`,
      };
    } else {
      await saveAndSubmitLater(activePage);
      const url = activePage.url();
      await closeBrowserSession();
      return {
        success: false,
        savedAsDraft: true,
        url: url.includes('claims') || url.includes('apply')
          ? url : `${config.greythr.url}${config.greythr.claimsPath}`,
      };
    }
  } catch (error: any) {
    await closeBrowserSession();
    return { success: false, savedAsDraft: false, error: error.message };
  }
}

/** Check if there's an active browser session waiting for user action */
export function hasActiveSession(): boolean {
  return activePage !== null && sessionTimeoutTimer !== null;
}
