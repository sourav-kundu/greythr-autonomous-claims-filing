import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  WASocket,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { config } from '../config';

const logger = pino({ level: 'silent' });

let sock: WASocket | null = null;

export type MessageHandler = (sock: WASocket) => void;

// Only process group chats — ignore DMs, status broadcasts, newsletters, etc.
// at the socket level so Baileys never even syncs them.
function isAllowedJid(jid: string | undefined | null): boolean {
  return !!jid && jid.endsWith('@g.us');
}

// Disconnect reasons that mean "don't bother reconnecting" — either the session
// is unrecoverable without user action, or another session has taken over and
// reconnecting would just ping-pong (and trigger another sync notification).
const FATAL_DISCONNECT_REASONS = new Set<number>([
  DisconnectReason.loggedOut,
  DisconnectReason.connectionReplaced,
  DisconnectReason.badSession,
  DisconnectReason.multideviceMismatch,
  DisconnectReason.forbidden,
]);

export async function startWhatsApp(onReady: MessageHandler): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(config.paths.auth);
  const { version } = await fetchLatestBaileysVersion();

  let reconnectAttempts = 0;

  function connectToWhatsApp() {
    sock = makeWASocket({
      version,
      auth: state,
      logger,
      browser: ['Claims Bot', 'Chrome', '1.0.0'],
      // Don't appear online (also reduces sync chatter)
      markOnlineOnConnect: false,
      // Never sync chat history — we only care about live messages going forward
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      // Drop any message addressed to a non-group JID before Baileys processes it.
      // This prevents the bot from "syncing" with personal DM threads.
      shouldIgnoreJid: (jid) => !isAllowedJid(jid),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('\n========================================');
        console.log('  Scan the QR code below with WhatsApp');
        console.log('  (Phone > Settings > Linked Devices)');
        console.log('========================================\n');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        const reason = (lastDisconnect?.error as Boom)?.output?.statusCode ?? 0;

        if (FATAL_DISCONNECT_REASONS.has(reason)) {
          console.log(
            `Connection closed. Reason: ${reason}. Not reconnecting — manual intervention required (delete auth/ and restart, or re-pair the device).`
          );
          return;
        }

        // restartRequired (515): Baileys explicitly asks for an immediate restart
        // with the existing session. Reset backoff so we come back fast.
        if (reason === DisconnectReason.restartRequired) {
          reconnectAttempts = 0;
          console.log('Connection closed. Reason: 515 (restart required). Reconnecting immediately.');
          setTimeout(connectToWhatsApp, 1000);
          return;
        }

        // Everything else (connectionClosed, connectionLost, timedOut,
        // unavailableService, unknown) gets exponential backoff so a flaky
        // network doesn't trigger a sync-notification storm.
        reconnectAttempts++;
        const delayMs = Math.min(5_000 * 2 ** (reconnectAttempts - 1), 300_000);
        console.log(
          `Connection closed. Reason: ${reason}. Reconnect attempt ${reconnectAttempts} in ${Math.round(delayMs / 1000)}s.`
        );
        setTimeout(connectToWhatsApp, delayMs);
      }

      if (connection === 'open') {
        reconnectAttempts = 0;
        console.log('\nWhatsApp connected successfully!');
        console.log(`Listening for messages in group: "${config.whatsapp.groupName}"\n`);
        onReady(sock!);
      }
    });
  }

  connectToWhatsApp();
}

export function getSocket(): WASocket | null {
  return sock;
}
