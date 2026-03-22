# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GreytHR Claims Bot — a WhatsApp-based automation tool that lets users send travel invoices (images/PDFs) to a WhatsApp group, parses them with AI (vision), and files reimbursement claims on BrowserStack's GreytHR instance via Playwright browser automation.

Target users are BrowserStack employees on macOS who need to file travel reimbursement claims. The tool supports two expense categories: **Conveyance** (taxi/Uber/transport) and **Food** (restaurant/lunch/meals).

## Build and Run Commands

```bash
npm install                    # Install dependencies
npm run setup:browser          # Install Playwright Chromium (required once)
npm start                      # Run with tsx (development)
npm run build                  # Compile TypeScript to dist/
npm run start:built            # Run compiled JS
npx tsc --noEmit               # Type-check without emitting
```

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
- Extracts 5 fields: `description`, `amount`, `currency`, `invoiceNumber`, `date`, `expenseCategory`
- `expenseCategory` is auto-classified as "Conveyance" (transport) or "Food" (meals) by the AI
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
   - Select expense category from dropdown ("Conveyance" or "Food")
   - Click **"Add Entry"**
   - Fill: Receipt No, Claim Date, Claim Amount, Remarks
   - Upload attachment via file input
   - Click **"Save"**
6. Fill **"General Remarks"** with overall claim description
7. Click **"Send for Approval"**

Retry strategy: 3 attempts with increasing delays (5s, 10s, 20s). On failure, falls back to **"Save & submit later"** button. Uses persistent browser context (`browser-data/`) so Google SSO session survives across restarts.

## WhatsApp Conversation Flow

```
User sends invoices (auto-starts claim if none active)
  → AI parses each: category, description, amount, invoice no, date
  → Bot confirms parsed details, user can correct
User types "submit [optional description]"
  → Bot shows summary with all line items
  → Asks claim type: reply "1" (non-cadence) or "2" (cadence)
User types "1" or "2"
  → Bot confirms claim type, asks for final "confirm"
User types "confirm"
  → Playwright files on GreytHR
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
| `status` | Show current claim summary |
| `submit [description]` | Show summary + ask claim type |
| `1` or `2` | Select claim type (when prompted) |
| `confirm` | File the claim on GreytHR |
| `cancel` | Cancel active claim |

## Key Design Decisions

- **Baileys over whatsapp-web.js**: Baileys uses direct WebSocket (no Puppeteer/Chromium overhead). The bot already needs Playwright for GreytHR, so avoiding a second browser instance matters.
- **Persistent Playwright context**: Stores cookies in `browser-data/` so Google SSO login survives across restarts. First run requires manual SSO in headed browser; subsequent runs reuse the session.
- **AI provider is swappable**: Configured via `AI_PROVIDER` and `AI_MODEL` env vars. Adding a new provider means adding one file in `src/parser/` and registering it in `invoice.ts`.
- **Single active claim**: Only one claim session exists at a time per group. Simplifies state management since WhatsApp group chat is inherently sequential.
- **Auto-start claims**: Users don't need to type "start new claim" — sending an invoice auto-creates one. New day auto-closes stale claims.
- **fromMe handling**: Since the bot runs on the user's own WhatsApp (linked device), all user messages have `fromMe=true`. The handler processes these and only skips truly empty echo messages.
- **Two expense categories only**: Conveyance and Food. This matches the most common BrowserStack travel claim items. Other categories (Airfare, Stay, etc.) exist in GreytHR but are not yet supported.

## GreytHR-Specific Details

- URL: `https://browserstack.greythr.com`
- Claims path: `/v2/employee/claims/advance`
- Login: Google SSO only (no username/password)
- Claim types supported: "Travel Expenses - Others than cadence", "Travel Expenses - Cadence"
- Expense dropdown options used: "Conveyance", "Food"
- Entry form fields: Receipt No, Claim Date, Claim Amount (INR), Attachment, Remarks
- After all entries: General Remarks, then "Send for Approval"
- Fallback on failure: "Save & submit later"

## Sensitive Directories (git-ignored)

- `auth/` — WhatsApp Baileys session credentials
- `data/` — Stored claims, invoice files, claim.json
- `browser-data/` — Playwright persistent browser profile with GreytHR SSO cookies
- `.env` — API keys and configuration

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
