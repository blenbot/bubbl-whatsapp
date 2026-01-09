# Bubbl WhatsApp Server

WhatsApp integration for Bubbl using the Baileys library. This server acts as an intermediate layer to receive and send WhatsApp messages, forwarding them to the Bubbl core Python server for processing.

## Features

- ✅ Full Baileys configuration with reconnection logic
- ✅ Redis caching for message history, group metadata, and rate limiting
- ✅ HTTP API for sending messages and managing the connection
- ✅ WebSocket-based WhatsApp connection with QR authentication
- ✅ History sync on connection
- ✅ Group message support
- ✅ Rate limiting to prevent bans
- ✅ Graceful shutdown handling

## Prerequisites

- Node.js 18+ 
- Redis server running
- Bubbl core Python server running

## Installation

```bash
cd bubbl-whatsapp
npm install
```

## Configuration

Copy the example environment file and configure:

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```env
PORT=3001
REDIS_URL=redis://localhost:6379
BUBBL_CORE_URL=http://localhost:5000
BROWSER_TYPE=Desktop
SYNC_FULL_HISTORY=true
RATE_LIMIT_PER_MINUTE=30
LOG_LEVEL=info
```

## Running

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

## First Run - QR Authentication

1. Start the server: `npm start`
2. A QR code will appear in the terminal
3. Open WhatsApp on your phone → Settings → Linked Devices → Link a Device
4. Scan the QR code
5. The server will save credentials in `./auth_state/`

## API Endpoints

### Health & Status

- `GET /health` - Health check
- `GET /status` - Detailed status with metrics
- `GET /qr` - Get QR code for authentication

### Messaging

- `POST /api/send` - Send message to a private chat
  ```json
  { "to": "1234567890", "message": "Hello!" }
  ```

- `POST /api/send/group` - Send message to a group
  ```json
  { "groupId": "123456789-1234567890@g.us", "message": "Hello group!" }
  ```

- `POST /api/broadcast` - Broadcast to multiple recipients
  ```json
  { "recipients": ["123", "456"], "message": "Broadcast!" }
  ```

### History

- `GET /api/history/:chatId?limit=50` - Get chat history

### Groups

- `GET /api/groups` - List all joined groups
- `GET /api/groups/:groupId` - Get group info

### Webhook (for Bubbl Core)

- `POST /webhook/send` - Send message from Bubbl core
  ```json
  { "chat_id": "123@s.whatsapp.net", "message": "Reply", "is_group": false }
  ```

### Admin

- `POST /admin/logout` - Logout from WhatsApp
- `POST /admin/reconnect` - Reconnect WhatsApp

## Integration with Bubbl Core

The WhatsApp server forwards incoming messages to the Bubbl core Python server at `POST /webhook/whatsapp` with the following payload:

```json
{
  "platform": "whatsapp",
  "chat_id": "1234567890@s.whatsapp.net",
  "sender": "1234567890",
  "text": "Hello!",
  "is_group": false,
  "timestamp": 1704067200000,
  "sender_name": "John Doe",
  "history": [
    { "sender": "1234567890", "text": "Previous message", "timestamp": 1704067100000 }
  ]
}
```

For group messages, additional fields are included:
```json
{
  "group_name": "My Group",
  "participants": [
    { "id": "1234567890", "admin": "admin" }
  ]
}
```

## Anti-Ban Tips

1. **Rate Limiting**: Built-in rate limiting (30 messages/minute by default)
2. **Warm Up**: Start slow with a new number, gradually increase activity
3. **Desktop Emulation**: Uses macOS Desktop browser fingerprint
4. **Natural Delays**: Add delays between bulk messages
5. **Don't Spam**: Avoid sending identical messages to many recipients

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   WhatsApp      │────▶│  Bubbl WhatsApp │────▶│   Bubbl Core    │
│   (Baileys)     │◀────│     Server      │◀────│    (Python)     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌─────────────────┐
                        │     Redis       │
                        │  (Cache/Queue)  │
                        └─────────────────┘
```

## Troubleshooting

### QR Code Not Appearing
- Check if Redis is running
- Delete `auth_state/` folder and restart

### Connection Keeps Dropping
- Check your internet connection
- WhatsApp may be rate limiting - wait 30 minutes
- Check if WhatsApp Web is working on the same number

### Messages Not Sending
- Check rate limits: `GET /status`
- Verify the recipient number format (without +, spaces, or dashes)
- Check Redis connection

## License

MIT
