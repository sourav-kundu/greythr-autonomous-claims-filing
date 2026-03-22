# GreytHR Autonomous Claims Filing

Automate GreytHR travel reimbursement claims via WhatsApp. Send invoices to a WhatsApp group, AI parses them, and the bot files the claim on GreytHR automatically via browser automation.

## How It Works

1. Send invoices (photos/PDFs) to a WhatsApp group
2. AI extracts amount, date, invoice number, description, and expense category
3. Correct any details via natural language chat
4. Type **submit** — bot shows summary and asks for claim type
5. Type **yes** — bot fills the claim on GreytHR via Playwright
6. Choose to **Submit for Approval** or **Save as Draft**

## Prerequisites

- **Node.js** v18+ ([install via Homebrew](https://brew.sh): `brew install node`)
- **AI API Key** from one of: [Anthropic](https://console.anthropic.com/), [OpenAI](https://platform.openai.com/), or [Google Gemini](https://aistudio.google.com/)
- **WhatsApp** account (bot links as a paired device)
- **GreytHR** account with Google SSO access

## Setup

```bash
git clone https://github.com/sourav-kundu/greythr-autonomous-claims-filing.git
cd greythr-autonomous-claims-filing
npm install
npm run setup:browser    # Install Playwright Chromium
cp .env.example .env     # Then edit .env with your API key
npm start
```

On first run:
1. **Scan the QR code** in terminal with WhatsApp (Settings → Linked Devices)
2. **Complete Google SSO** when the browser opens for GreytHR (one-time; session is saved)

## Environment Variables

| Variable | Required | Default |
|----------|----------|---------|
| `AI_PROVIDER` | No | `anthropic` |
| `AI_MODEL` | No | `claude-sonnet-4-20250514` |
| `ANTHROPIC_API_KEY` | If using Anthropic | — |
| `OPENAI_API_KEY` | If using OpenAI | — |
| `GEMINI_API_KEY` | If using Gemini | — |
| `GREYTHR_URL` | No | `https://browserstack.greythr.com` |
| `WHATSAPP_GROUP_NAME` | No | `GreytHr Travel Reimbursement` |
| `BATCH_WINDOW_SECONDS` | No | `5` |

## WhatsApp Commands

| Command | Action |
|---------|--------|
| *Send image/PDF* | Auto-starts claim, parses invoice with AI |
| `start new claim` | Begin fresh claim (closes any existing) |
| `amount is 750` | Correct last invoice's amount |
| `description should be ...` | Correct description |
| `category should be Food` | Correct expense category |
| `correct #2 amount to 500` | Correct a specific invoice |
| `status` | Show current claim summary |
| `submit [description]` | Show summary, ask for claim type |
| `1` or `2` | Select claim type (when prompted) |
| `yes` / `y` | Confirm and start filing on GreytHR |
| `1` (Submit) or `2` (Save Draft) | Final action after GreytHR is filled |
| `cancel` | Cancel active claim |

## Example Conversation

```
You:   [send uber_receipt.pdf]
Bot:   Auto-started new claim. Parsed 1 invoice:
       1. [Conveyance] Uber ride airport to office
          INR 450 | 2026-03-13 | UBER-IN-12345

You:   [send lunch_bill.jpg with caption "Team lunch"]
Bot:   Parsed 1 invoice:
       1. [Food] Team lunch
          INR 1200 | 2026-03-14 | REST-4521

You:   amount is 1250
Bot:   Updated item #2 — amount changed to: 1250

You:   submit Mumbai trip
Bot:   Which claim type?
       Reply 1 for: Travel Expenses - Others than cadence
       Reply 2 for: Travel Expenses - Cadence

You:   1
Bot:   [Shows summary] Proceed? Reply yes to continue.

You:   yes
Bot:   Filling claim on GreytHR... This may take a minute.
Bot:   Claim has been filled on GreytHR!
       Reply 1 — Submit for Approval
       Reply 2 — Save & Submit Later

You:   1
Bot:   Claim submitted for approval!
```

## Architecture

```
src/
├── index.ts              # Entry point
├── config.ts             # Environment config
├── whatsapp/
│   ├── client.ts         # Baileys WebSocket connection + QR auth
│   ├── handler.ts        # Message routing, commands, conversation flow
│   └── correction.ts     # AI-powered natural language correction parsing
├── parser/
│   ├── invoice.ts        # Common interface + system prompt
│   ├── anthropic.ts      # Claude vision parser
│   ├── openai.ts         # GPT-4o vision parser
│   └── gemini.ts         # Gemini vision parser
├── claims/
│   └── store.ts          # JSON file-based claim persistence
└── greythr/
    └── filer.ts          # Playwright browser automation (two-phase)
```

**Key design decisions:**
- **Baileys** (WebSocket) for WhatsApp — no extra browser needed
- **Persistent Playwright context** — Google SSO session survives restarts
- **Two-phase filing** — fills GreytHR first, then waits for user to choose submit or save (5-min timeout)
- **Swappable AI providers** — Anthropic/OpenAI/Gemini via adapter pattern
- **Rolling-window batching** — multiple invoices sent quickly are processed in parallel

## Keeping It Running

```bash
# Option A: Leave terminal open
npm start

# Option B: Use pm2
npm run build
pm2 start dist/index.js --name greythr-bot
pm2 save && pm2 startup
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| QR code keeps regenerating | Delete `auth/` folder, restart |
| GreytHR login timed out | Complete SSO within 2 min, then retry with `yes` |
| Claim saved as draft | Bot retried 3x and fell back. Complete manually at the provided URL |
| Bot doesn't respond | Check terminal logs, verify `.env` keys, ensure group name matches exactly |

## Security

All secrets live in `.env` (git-ignored). Session data (`auth/`, `browser-data/`) is local-only and git-ignored. No data leaves your machine except AI API calls for invoice parsing.

## License

MIT
