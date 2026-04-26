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

export async function startWhatsApp(onReady: MessageHandler): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(config.paths.auth);
  const { version } = await fetchLatestBaileysVersion();

  function connectToWhatsApp() {
    sock = makeWASocket({
      version,
      auth: state,
      logger,
      browser: ['GreytHR Claims Bot', 'Chrome', '1.0.0'],
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
        const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;

        console.log(
          `Connection closed. Reason: ${reason}. ${shouldReconnect ? 'Reconnecting...' : 'Logged out. Delete auth/ folder and restart.'}`
        );

        if (shouldReconnect) {
          setTimeout(connectToWhatsApp, 3000);
        }
      }

      if (connection === 'open') {
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
