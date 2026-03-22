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

export async function startWhatsApp(onReady: MessageHandler): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(config.paths.auth);
  const { version } = await fetchLatestBaileysVersion();

  function connectToWhatsApp() {
    sock = makeWASocket({
      version,
      auth: state,
      logger,
      browser: ['GreytHR Claims Bot', 'Chrome', '1.0.0'],
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
