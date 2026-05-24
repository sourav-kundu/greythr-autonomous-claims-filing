# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GreytHR Claims Bot — a WhatsApp-based automation tool that lets users send travel invoices (images/PDFs) to a WhatsApp group, parses them with AI (vision), and files reimbursement claims on BrowserStack's GreytHR instance via Playwright browser automation.

Target users are BrowserStack employees on macOS who need to file travel reimbursement claims. The tool supports two user-facing expense categories: **Conveyance** (taxi/Uber/transport) and **Food** (restaurant/lunch/meals). These map to different GreytHR dropdown labels depending on claim type — see "Claim type differences" under the Filer section.

## Build and Run Commands

```bash
npm install                    # Install dependencies
npm run setup:browser          # Install Playwright Chromium (required once)
npm start                      # Run with tsx (development AND production)
npm run build                  # Compile TypeScript to dist/ (optional — not needed for production)
npm run start:built            # Run compiled JS
npx tsc --noEmit               # Type-check without emitting
```

**Production runs from source via tsx.** The recommended deployment is a launchd plist that invokes `node node_modules/tsx/dist/cli.mjs src/index.ts`, so `git pull` is sufficient to roll out code changes (no build step). See README's "Always-on with launchd" section for the plist template. The `dist/` build target is kept available for pm2 / other process managers that prefer compiled JS.

## Architecture

The app is a long-running Node.js process with four subsystems:

### 1. WhatsApp Listener (`src/whatsapp/`)

- Uses **Baileys** v7 (WebSocket-based, no browser needed) to connect to WhatsApp via QR code scan
- QR code rendered in terminal using `qrcode-terminal` (Baileys v7 deprecated `printQRInTerminal`)
- Listens to a single configured group (default: "GreytHR Travel Reimbursement")
- **Critical**: The bot is linked to the user's own WhatsApp account, so `msg.key.fromMe` is `true` for user messages. The handler must NOT skip `fromMe` messages — only skip empty `fromMe` messages that are bot echoes
- `client.ts` handles connection, QR auth, auto-reconnect on disconnect
- `handler.ts` routes text commands and media messages to appropriate handlers

### 2. Invoice Parser (`src/parser/`)

- Multi-provider AI vision integration with adapter pattern
- `invoice.ts` defines the common interface, system prompt, and provider routing
- Provider implementations: `anthropic.ts`, `openai.ts`, `gemini.ts`
- All providers receive invoice as base64-encoded image/PDF and return structured JSON
- Extracts: `description`, `amount`, `currency`, `invoiceNumber`, `date`, `expenseCategory`, and optionally `amountBeforeTax` / `taxAmount`
- `expenseCategory` is auto-classified as "Conveyance" (transport) or "Food" (meals) by the AI
- `amountBeforeTax` / `taxAmount` are extracted **only for Food bills** that show a tax breakdown (GST/CGST+SGST/VAT). The parser also validates `amountBeforeTax + taxAmount ≈ amount` (within 1 unit of rounding) and drops both fields if they don't reconcile. These are used by the Filer only when filing a Cadence claim (see Filer section).
- Adding a new provider: create a new file in `src/parser/`, register in `invoice.ts` parser map

### 3. Claims Store (`src/claims/store.ts`)

- JSON file-based persistence under `data/claims/<claim-id>/`
- Each claim directory contains `claim.json` and original invoice files
- Claim status lifecycle: `collecting → awaiting_claim_type → awaiting_confirmation → filing → filed/draft_saved/failed`
- `submittedAt` timestamp recorded when claim is filed or saved as draft
- Auto-creates new claim if user sends invoices without explicit "start new claim"
- Auto-closes stale claims from previous days (new day = new claim)
- Only one active claim at a time per group

### 4. GreytHR Filer (`src/greythr/filer.ts`)

Playwright automation against BrowserStack's GreytHR instance. The exact flow matches the GreytHR UI:

1. Navigate to claims page, check login status
2. Click **"New Claim"** button
3. Select claim type radio button: "Travel Expenses - Others than cadence" or "Travel Expenses - Cadence"
4. Click **"Create Claim"**
5. For each line item:
   - Select expense category from dropdown (label depends on claim type — see below)
   - Click **"Add Entry"**
   - Fill: Receipt No, Claim Date, Claim Amount, Remarks
   - For Cadence + Food entries only: also fill **Amount Before Tax** and **Tax Amount**
   - Upload attachment via file input
   - Click **"Save"**
6. Fill outer **Remarks** (`tmplCustomField1`, required for both claim types) and **General Remarks** with the overall claim description
7. Click **"Send for Approval"**

Retry strategy: 3 attempts with increasing delays (5s, 10s, 20s). On failure, falls back to **"Save & submit later"** button. Uses persistent browser context (`browser-data/`) so Google SSO session survives across restarts.

#### Claim type differences

The Cadence and non-cadence forms on GreytHR are structurally different. The filer adapts based on `claim.claimType`:

| | Non-cadence | Cadence |
|---|---|---|
| Category dropdown options | Conveyance, Food, Airfare, Stay Expenses, Internet, Mobile, Other expenses, Travel Insurance, Visa | **Travel Expense, Other expenses** (only two) |
| Conveyance bills go to | "Conveyance" | "Travel Expense" |
| Food bills go to | "Food" | "Other expenses" |
| Per-entry tax fields (`amountBeforeTax`, `taxAmount`) | Don't exist on the form | Exist, but only required to be filled for **Food** (Other expenses). Travel Expense entries leave them at 0.00 — HR doesn't require tax bifurcation for taxi/Uber bills. |

The category mapping lives in `CADENCE_CATEGORY_LABEL` in `filer.ts`. The tax-field fill is gated on `claim.claimType === 'cadence' && item.expenseCategory === 'Food'`.

If the parser couldn't extract a tax breakdown for a Food bill (no GST shown on the receipt), the filer falls back to `amountBeforeTax = amount, taxAmount = 0` so the form saves — GreytHR doesn't enforce `amount == before + tax` server-side.

## WhatsApp Conversation Flow

```
User sends invoices (auto-starts claim if none active)
  → AI parses each: category, description, amount, invoice no, date
  → Bot confirms parsed details, user can correct
User types "submit [optional description]"
  → Bot shows summary with all line items
  → Asks claim type: reply "1" (non-cadence) or "2" (cadence)
User types "1" or "2"
  → Bot confirms claim type and asks for final "yes"
User types "yes" (also accepted: "y", "confirm")
  → Playwright fills the claim on GreytHR (does NOT submit)
  → Bot reports back and asks: reply "1" to submit for approval, "2" to save as draft
User types "1" or "2"
  → Playwright clicks the corresponding GreytHR button
  → Bot returns result URL
```

### Supported Commands

| Command | Action |
|---------|--------|
| `start new claim` | Begin fresh claim (closes any existing) |
| *(send image/PDF)* | Auto-starts claim if needed, parses invoice |
| `amount is 750` | Correct last parsed invoice's amount |
| `description should be ...` | Correct description |
| `category should be Food` | Correct expense category |
| `correct #2 amount to 500` | Correct a specific line item |
| `status` | Show current claim summary |
| `submit [description]` | Show summary + ask claim type |
| `1` or `2` | Select claim type (when prompted), then later: 1=submit, 2=save draft |
| `yes` / `y` / `confirm` | Proceed with filing on GreytHR (after claim type chosen) |
| `cancel` | Cancel active claim |

## Key Design Decisions

- **Baileys over whatsapp-web.js**: Baileys uses direct WebSocket (no Puppeteer/Chromium overhead). The bot already needs Playwright for GreytHR, so avoiding a second browser instance matters.
- **Persistent Playwright context**: Stores cookies in `browser-data/` so Google SSO login survives across restarts. First run requires manual SSO in headed browser; subsequent runs reuse the session.
- **AI provider is swappable**: Configured via `AI_PROVIDER` and `AI_MODEL` env vars. Adding a new provider means adding one file in `src/parser/` and registering it in `invoice.ts`.
- **Single active claim**: Only one claim session exists at a time per group. Simplifies state management since WhatsApp group chat is inherently sequential.
- **Auto-start claims**: Users don't need to type "start new claim" — sending an invoice auto-creates one. New day auto-closes stale claims.
- **fromMe handling**: Since the bot runs on the user's own WhatsApp (linked device), all user messages have `fromMe=true`. The handler processes these and only skips truly empty echo messages.
- **Two user-facing expense categories**: Conveyance and Food. These cover the most common BrowserStack travel claim items. Other GreytHR categories (Airfare, Stay, etc.) exist on the non-cadence form but are not yet supported by the bot — extending the parser's `ExpenseCategory` type and the filer's dropdown selection would cover them.
- **Reconnect strategy**: `client.ts` exponentially backs off (5s → 5min) for recoverable disconnects, immediately reconnects on `restartRequired` (515), and **stops** reconnecting for fatal reasons (`loggedOut`, `connectionReplaced`, `badSession`, `multideviceMismatch`, `forbidden`). The fatal-reason list prevents notification storms — every reconnect triggers a phone-side "Finished syncing" notification, so blind 3s retries used to spam the user.

## GreytHR-Specific Details

- URL: `https://browserstack.greythr.com`
- Claims path: `/v2/employee/claims/advance`
- Login: Google SSO only (no username/password)
- Claim types supported: "Travel Expenses - Others than cadence", "Travel Expenses - Cadence"
- Expense dropdown options used:
  - Non-cadence: "Conveyance", "Food"
  - Cadence: "Travel Expense", "Other expenses"
- Entry form fields:
  - Both: Receipt No, Claim Date, Claim Amount (INR), Attachment, Remarks
  - Cadence-only extras: Amount Before Tax, Tax Amount (filled by bot only for Food in cadence; otherwise left at 0.00)
- Outer-form Remarks: `input[name="tmplCustomField1"]` — required for both claim types
- After all entries: General Remarks, then "Send for Approval"
- Fallback on failure: "Save & submit later"

## Sensitive Directories (git-ignored)

- `auth/` — WhatsApp Baileys session credentials
- `data/` — Stored claims, invoice files, claim.json
- `browser-data/` — Playwright persistent browser profile with GreytHR SSO cookies
- `.env` — API keys and configuration
- `logs/` — Runtime stdout/stderr from the launchd service (`bot.out.log`, `bot.err.log`)

## Running in Production

The recommended deployment is a per-user launchd plist at `~/Library/LaunchAgents/com.<user>.greythr-claims-bot.plist` that invokes the bot directly from TypeScript source via tsx (see README "Always-on with launchd" for the template). This means **deploying a code change is just `git pull` + `launchctl kickstart -k gui/$(id -u)/com.<user>.greythr-claims-bot`** — no build step.

When debugging the running bot:
- `tail -f logs/bot.out.log` — runtime output (connections, claim filings, errors raised by handler logic)
- `tail -f logs/bot.err.log` — Baileys pino logger output (Signal protocol session churn, mostly noise; useful for connection issues)
- `launchctl list | grep claims` — verify the service is up and get its PID
- `ps -p <PID> -o etime,command` — uptime

The launchd plist has `KeepAlive` with `Crashed=true, SuccessfulExit=false`, so a crash auto-restarts (with a 15s `ThrottleInterval`). A clean exit (e.g. `loggedOut` disconnect) does **not** auto-restart — by design, since those cases need manual intervention (re-scan QR, etc.).

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `AI_PROVIDER` | AI provider: `anthropic`, `openai`, `gemini` | `anthropic` |
| `AI_MODEL` | Model name for the chosen provider | `claude-sonnet-4-20250514` |
| `ANTHROPIC_API_KEY` | Anthropic API key | — |
| `OPENAI_API_KEY` | OpenAI API key | — |
| `GEMINI_API_KEY` | Google Gemini API key | — |
| `GREYTHR_URL` | GreytHR base URL | `https://browserstack.greythr.com` |
| `WHATSAPP_GROUP_NAME` | Exact WhatsApp group name to listen to | `GreytHr Travel Reimbursement` |
