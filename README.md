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

- **macOS** (uses Playwright Chromium + an optional launchd service for always-on running). It will mostly work on Linux too, but the launchd instructions below are Mac-only.
- **Node.js** v18+ — `brew install node`
- **AI API Key** from one of: [Anthropic](https://console.anthropic.com/), [OpenAI](https://platform.openai.com/), or [Google Gemini](https://aistudio.google.com/). Anthropic Claude is the default and recommended.
- **A WhatsApp account** that you can scan a QR code with. The bot links itself as a paired device.
- **A GreytHR account** with Google SSO access (BrowserStack employees: this is your existing greythr.com account).
- **A dedicated WhatsApp group for yourself.** *Important: each user needs their own group.* The bot is single-user — multiple people sharing one group will cause crossed conversations. The simplest setup is a 1-person group with just your own number.

## Setup

```bash
git clone https://github.com/sourav-kundu/greythr-autonomous-claims-filing.git
cd greythr-autonomous-claims-filing
npm install
npm run setup:browser    # Installs Playwright Chromium
cp .env.example .env     # Then edit .env (see below)
```

Edit `.env` and set at minimum:
- `ANTHROPIC_API_KEY` (or whichever provider you chose)
- `WHATSAPP_GROUP_NAME` — the exact name of the WhatsApp group you created (case-sensitive, must match exactly)

Then start the bot:

```bash
npm start
```

### First run — interactive

You'll need to do two one-time logins:

1. **WhatsApp** — a QR code appears in the terminal. Open WhatsApp on your phone → Settings → Linked Devices → Link a device → scan the code. Credentials are saved to `auth/` so this is one-time.
2. **GreytHR Google SSO** — when you trigger your first claim, a Chromium window will open. Complete Google SSO once. Cookies are saved to `browser-data/` so this is also one-time.

Both `auth/` and `browser-data/` are gitignored — they live only on your machine.

## Always-on with launchd (recommended)

Once you've confirmed the bot works with `npm start`, set it up as a launchd service so it survives reboots and crashes:

```bash
# Generate the plist for your user
USER_DIR="$(pwd)"
cat > ~/Library/LaunchAgents/com.$USER.greythr-claims-bot.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.$USER.greythr-claims-bot</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>$USER_DIR/node_modules/tsx/dist/cli.mjs</string>
    <string>$USER_DIR/src/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$USER_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/><key>Crashed</key><true/></dict>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$USER_DIR/logs/bot.out.log</string>
  <key>StandardErrorPath</key><string>$USER_DIR/logs/bot.err.log</string>
</dict>
</plist>
EOF

mkdir -p logs
launchctl load ~/Library/LaunchAgents/com.$USER.greythr-claims-bot.plist
```

The plist runs the bot directly from TypeScript source via `tsx`, so **`git pull` is all you need to deploy new code** — no build step. Restart with:

```bash
launchctl kickstart -k gui/$(id -u)/com.$USER.greythr-claims-bot
```

Check it's alive:

```bash
launchctl list | grep claims
tail -f logs/bot.out.log
```

## Environment Variables

| Variable | Required | Default |
|----------|----------|---------|
| `AI_PROVIDER` | No | `anthropic` |
| `AI_MODEL` | No | `claude-sonnet-4-20250514` (consider upgrading to a newer Sonnet/Opus) |
| `ANTHROPIC_API_KEY` | If using Anthropic | — |
| `OPENAI_API_KEY` | If using OpenAI | — |
| `GEMINI_API_KEY` | If using Gemini | — |
| `GREYTHR_URL` | No | `https://browserstack.greythr.com` |
| `WHATSAPP_GROUP_NAME` | **Yes** | `GreytHr Travel Reimbursement` (change this) |
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
| `1` or `2` | Select claim type (when prompted — see below) |
| `yes` / `y` | Confirm and start filing on GreytHR |
| `1` (Submit) or `2` (Save Draft) | Final action after GreytHR is filled |
| `cancel` | Cancel active claim |

## Claim types — when to pick 1 or 2

After typing `submit`, the bot asks:

```
Reply 1 for: Travel Expenses - Others than cadence
Reply 2 for: Travel Expenses - Cadence
```

- **1 — Non-cadence**: Regular work travel — client visits, business trips, day-to-day travel for work. This is the common case.
- **2 — Cadence**: Travel related to a Cadence event (offsites, team gatherings, stackconnects, all-hands). Your company-internal Cadence travel policy applies.

The bot adapts the GreytHR form for whichever you pick — the category dropdowns and required fields are different between the two. You don't need to think about this; just pick the right claim type.

### Cadence-specific behavior

For Cadence claims, GreytHR's category dropdown only has "Travel Expense" and "Other expenses" (no Conveyance/Food). The bot automatically maps:

- Conveyance bills (Uber, taxi) → **Travel Expense** in cadence form
- Food bills (restaurants) → **Other expenses** in cadence form, with the **pre-tax amount and tax amount filled separately** (GreytHR requires this split for food in cadence). The parser tries to read the tax breakdown from the bill itself; if the bill doesn't show GST/tax explicitly, the bot puts the full amount under "before tax" and 0 under "tax".

For non-cadence, this all works the way it did before — Conveyance/Food map directly.

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

## Updating

```bash
git pull
launchctl kickstart -k gui/$(id -u)/com.$USER.greythr-claims-bot
tail -f logs/bot.out.log  # watch it come back up
```

No `npm run build` needed — the launchd service runs from TypeScript source via `tsx`. If you've added new dependencies, run `npm install` before the kickstart.

## For Claude Code users

This repo includes a `CLAUDE.md` at the root with architecture notes, conventions, and gotchas. Claude Code auto-loads it when you start a session in this directory, so you can ask things like:

- "How does the cadence claim flow differ from non-cadence?"
- "Where do I add a new AI provider?"
- "Walk me through the WhatsApp message handling pipeline"

…and Claude will already have the relevant context.

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

## Troubleshooting

| Problem | Fix |
|---------|-----|
| QR code keeps regenerating | Delete `auth/` folder, restart |
| Phone keeps showing "Finished syncing with WhatsApp on Google Chrome (Claims Bot)" | Mute the `(You)` / "Message yourself" chat in WhatsApp — these notifications are pushed by WhatsApp, not the bot |
| GreytHR login timed out | Complete SSO within 2 min, then retry with `yes` |
| Claim saved as draft | Bot retried 3x and fell back. Complete manually at the provided URL |
| Bot doesn't respond | `tail -f logs/bot.out.log` and `logs/bot.err.log`. Verify `.env` keys and that `WHATSAPP_GROUP_NAME` exactly matches your group |
| Bot won't restart after `launchctl kickstart` | Check `logs/bot.err.log` for the actual error. Common cause: changed dependencies but skipped `npm install` |
| `Connection closed. Reason: 440` repeatedly | Another instance is using the same WhatsApp session. Find it with `ps aux \| grep tsx` or `launchctl list \| grep claims` and stop the duplicate |

## Security

- All secrets live in `.env` (git-ignored). No API keys or credentials are committed.
- Session data (`auth/` for WhatsApp, `browser-data/` for GreytHR cookies) is local-only and git-ignored.
- Invoice files (`data/`) stay on your machine.
- The only network egress is to your chosen AI provider (for parsing) and to WhatsApp + GreytHR servers.

## License

MIT
