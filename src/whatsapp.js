import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  Browsers,
  proto,
  getAggregateVotesInPollMessage,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { config } from './config.js';
import { logger } from './logger.js';
import { redisCache } from './redis.js';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

class WhatsAppClient extends EventEmitter {
  constructor() {
    super();
    this.sock = null;
    this.isConnected = false;
    this.qrCode = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 3000;
  }

  async initialize() {
    try {
      // Ensure auth directory exists
      if (!fs.existsSync(config.authStateDir)) {
        fs.mkdirSync(config.authStateDir, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(config.authStateDir);
      const { version, isLatest } = await fetchLatestBaileysVersion();

      logger.info({ version, isLatest }, 'Using Baileys version');

      this.sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        printQRInTerminal: true,
        browser: config.browserType === 'Desktop' 
          ? Browsers.macOS('Desktop')
          : Browsers.appropriate('Chrome'),
        syncFullHistory: config.syncFullHistory,
        logger: logger.child({ module: 'baileys' }),
        generateHighQualityLinkPreview: true,
        getMessage: async (key) => {
          // Fetch message from cache for retries
          const history = await redisCache.getMessageHistory(key.remoteJid, 100);
          const msg = history.find(m => m.key?.id === key.id);
          return msg?.message || undefined;
        },
      });

      this._setupEventHandlers(saveCreds);
      
      logger.info('WhatsApp client initialized');
    } catch (error) {
      logger.error({ error }, 'Failed to initialize WhatsApp client');
      throw error;
    }
  }

  _setupEventHandlers(saveCreds) {
    // Credentials update
    this.sock.ev.on('creds.update', saveCreds);

    // Connection state updates
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qrCode = qr;
        this.emit('qr', qr);
        logger.info('QR code generated - scan to connect');
      }

      if (connection === 'close') {
        this.isConnected = false;
        await redisCache.saveConnectionState('disconnected');
        
        const statusCode = (lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        logger.warn({ statusCode, shouldReconnect }, 'Connection closed');

        if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
          
          logger.info({ attempt: this.reconnectAttempts, delay }, 'Reconnecting...');
          
          setTimeout(() => this.initialize(), delay);
        } else if (!shouldReconnect) {
          logger.error('Logged out - need to re-scan QR code');
          this.emit('logged_out');
        } else {
          logger.error('Max reconnection attempts reached');
          this.emit('max_reconnect_reached');
        }
      } else if (connection === 'open') {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.qrCode = null;
        
        await redisCache.saveConnectionState('connected');
        
        logger.info('✅ Connected to WhatsApp!');
        this.emit('connected');
      }
    });

    // Message handling
    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      logger.debug({ count: messages.length, type }, 'Messages received');

      for (const msg of messages) {
        try {
          await this._handleIncomingMessage(msg, type);
        } catch (error) {
          logger.error({ error, messageId: msg.key?.id }, 'Error handling message');
        }
      }
    });

    // History sync
    this.sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest }) => {
      logger.info({ 
        chatsCount: chats.length, 
        contactsCount: contacts.length,
        messagesCount: messages.length,
        isLatest 
      }, 'History sync received');

      // Store messages in Redis
      for (const msg of messages) {
        const chatId = msg.key?.remoteJid;
        if (chatId) {
          await redisCache.saveMessage(chatId, this._formatMessage(msg));
        }
      }

      // Store contacts
      for (const contact of contacts) {
        if (contact.id) {
          await redisCache.saveUserProfile(contact.id, {
            name: contact.name || contact.notify,
            id: contact.id,
          });
        }
      }

      this.emit('history_synced', { chats, contacts, messages });
    });

    // Group updates
    this.sock.ev.on('groups.update', async (updates) => {
      for (const update of updates) {
        logger.info({ groupId: update.id }, 'Group updated');
        
        // Refresh group metadata
        try {
          const metadata = await this.sock.groupMetadata(update.id);
          await redisCache.saveGroupMetadata(update.id, metadata);
        } catch (error) {
          logger.error({ error, groupId: update.id }, 'Failed to update group metadata');
        }
      }
    });

    // Group participants update
    this.sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
      logger.info({ groupId: id, participants, action }, 'Group participants updated');
      
      // Refresh group metadata
      try {
        const metadata = await this.sock.groupMetadata(id);
        await redisCache.saveGroupMetadata(id, metadata);
      } catch (error) {
        logger.error({ error, groupId: id }, 'Failed to update group metadata after participant change');
      }

      this.emit('group_participants_update', { id, participants, action });
    });

    // Message updates (read receipts, reactions, etc.)
    this.sock.ev.on('messages.update', async (updates) => {
      for (const { key, update } of updates) {
        logger.debug({ key, update }, 'Message updated');
      }
    });

    // Presence updates
    this.sock.ev.on('presence.update', async ({ id, presences }) => {
      for (const jid in presences) {
        await redisCache.updateUserLastSeen(jid);
      }
    });
  }

  async _handleIncomingMessage(msg, type) {
    // Skip if no message content
    if (!msg.message) return;

    // Skip status broadcasts
    if (msg.key.remoteJid === 'status@broadcast') return;

    const chatId = msg.key.remoteJid;
    const isGroup = chatId.endsWith('@g.us');
    const isFromMe = msg.key.fromMe;
    const sender = isGroup 
      ? msg.key.participant || msg.participant 
      : chatId;

    // Extract message content
    const messageContent = this._extractMessageContent(msg);
    if (!messageContent) return;

    // Format message for storage
    const formattedMessage = this._formatMessage(msg);
    
    // Save to Redis
    await redisCache.saveMessage(chatId, formattedMessage);
    await redisCache.incrementMessageCounter('incoming');
    await redisCache.updateUserLastSeen(sender);

    // Get group metadata if needed
    let groupMetadata = null;
    if (isGroup) {
      groupMetadata = await redisCache.getGroupMetadata(chatId);
      if (!groupMetadata) {
        try {
          groupMetadata = await this.sock.groupMetadata(chatId);
          await redisCache.saveGroupMetadata(chatId, groupMetadata);
        } catch (error) {
          logger.error({ error, chatId }, 'Failed to fetch group metadata');
        }
      }
    }

    // Emit event for external handling
    this.emit('message', {
      chatId,
      sender,
      isGroup,
      isFromMe,
      messageContent,
      formattedMessage,
      groupMetadata,
      rawMessage: msg,
      type,
    });
  }

  _extractMessageContent(msg) {
    const message = msg.message;
    
    // Text message
    if (message.conversation) {
      return { type: 'text', text: message.conversation };
    }
    
    // Extended text (with link preview, mentions, etc.)
    if (message.extendedTextMessage) {
      return { 
        type: 'text', 
        text: message.extendedTextMessage.text,
        contextInfo: message.extendedTextMessage.contextInfo,
      };
    }

    // Image
    if (message.imageMessage) {
      return { 
        type: 'image', 
        caption: message.imageMessage.caption,
        mimetype: message.imageMessage.mimetype,
      };
    }

    // Video
    if (message.videoMessage) {
      return { 
        type: 'video', 
        caption: message.videoMessage.caption,
        mimetype: message.videoMessage.mimetype,
      };
    }

    // Audio
    if (message.audioMessage) {
      return { 
        type: 'audio', 
        mimetype: message.audioMessage.mimetype,
        ptt: message.audioMessage.ptt, // voice note
      };
    }

    // Document
    if (message.documentMessage) {
      return { 
        type: 'document', 
        fileName: message.documentMessage.fileName,
        mimetype: message.documentMessage.mimetype,
      };
    }

    // Sticker
    if (message.stickerMessage) {
      return { type: 'sticker' };
    }

    // Location
    if (message.locationMessage) {
      return { 
        type: 'location', 
        latitude: message.locationMessage.degreesLatitude,
        longitude: message.locationMessage.degreesLongitude,
      };
    }

    // Contact
    if (message.contactMessage) {
      return { 
        type: 'contact', 
        displayName: message.contactMessage.displayName,
      };
    }

    // Reaction
    if (message.reactionMessage) {
      return { 
        type: 'reaction', 
        text: message.reactionMessage.text,
        key: message.reactionMessage.key,
      };
    }

    // Poll
    if (message.pollCreationMessage) {
      return { 
        type: 'poll', 
        name: message.pollCreationMessage.name,
        options: message.pollCreationMessage.options,
      };
    }

    return null;
  }

  _formatMessage(msg) {
    const content = this._extractMessageContent(msg);
    const isGroup = msg.key.remoteJid?.endsWith('@g.us');
    
    return {
      id: msg.key.id,
      chatId: msg.key.remoteJid,
      sender: isGroup 
        ? (msg.key.participant || msg.participant)
        : msg.key.remoteJid,
      isFromMe: msg.key.fromMe,
      timestamp: msg.messageTimestamp 
        ? (typeof msg.messageTimestamp === 'number' 
          ? msg.messageTimestamp * 1000 
          : msg.messageTimestamp.low * 1000)
        : Date.now(),
      content,
      pushName: msg.pushName,
      key: msg.key,
    };
  }

  // ==================== Sending Messages ====================

  async sendTextMessage(jid, text, options = {}) {
    if (!this.isConnected) {
      throw new Error('WhatsApp client not connected');
    }

    // Rate limiting
    const rateLimit = await redisCache.checkRateLimit(jid);
    if (!rateLimit.allowed) {
      throw new Error(`Rate limit exceeded. Reset in ${rateLimit.resetIn} seconds`);
    }

    try {
      const sent = await this.sock.sendMessage(jid, { 
        text,
        ...options,
      });

      await redisCache.incrementMessageCounter('outgoing');
      
      logger.info({ jid, messageId: sent.key.id }, 'Text message sent');
      
      return sent;
    } catch (error) {
      logger.error({ error, jid }, 'Failed to send text message');
      throw error;
    }
  }

  async sendImageMessage(jid, imageBuffer, caption = '', options = {}) {
    if (!this.isConnected) {
      throw new Error('WhatsApp client not connected');
    }

    try {
      const sent = await this.sock.sendMessage(jid, {
        image: imageBuffer,
        caption,
        ...options,
      });

      await redisCache.incrementMessageCounter('outgoing');
      
      logger.info({ jid, messageId: sent.key.id }, 'Image message sent');
      
      return sent;
    } catch (error) {
      logger.error({ error, jid }, 'Failed to send image message');
      throw error;
    }
  }

  async sendDocumentMessage(jid, buffer, fileName, mimetype, options = {}) {
    if (!this.isConnected) {
      throw new Error('WhatsApp client not connected');
    }

    try {
      const sent = await this.sock.sendMessage(jid, {
        document: buffer,
        fileName,
        mimetype,
        ...options,
      });

      await redisCache.incrementMessageCounter('outgoing');
      
      logger.info({ jid, messageId: sent.key.id }, 'Document message sent');
      
      return sent;
    } catch (error) {
      logger.error({ error, jid }, 'Failed to send document message');
      throw error;
    }
  }

  async sendReaction(jid, messageKey, emoji) {
    if (!this.isConnected) {
      throw new Error('WhatsApp client not connected');
    }

    try {
      await this.sock.sendMessage(jid, {
        react: {
          text: emoji,
          key: messageKey,
        }
      });
      
      logger.info({ jid, emoji }, 'Reaction sent');
    } catch (error) {
      logger.error({ error, jid }, 'Failed to send reaction');
      throw error;
    }
  }

  // ==================== Group Operations ====================

  async getGroupMetadata(groupId) {
    // Try cache first
    let metadata = await redisCache.getGroupMetadata(groupId);
    
    if (!metadata) {
      metadata = await this.sock.groupMetadata(groupId);
      await redisCache.saveGroupMetadata(groupId, metadata);
    }
    
    return metadata;
  }

  async getAllGroups() {
    const groups = await this.sock.groupFetchAllParticipating();
    
    // Cache all group metadata
    for (const [id, metadata] of Object.entries(groups)) {
      await redisCache.saveGroupMetadata(id, metadata);
    }
    
    return groups;
  }

  async addGroupParticipants(groupId, participants) {
    return await this.sock.groupParticipantsUpdate(groupId, participants, 'add');
  }

  async removeGroupParticipants(groupId, participants) {
    return await this.sock.groupParticipantsUpdate(groupId, participants, 'remove');
  }

  // ==================== History ====================

  async fetchMessageHistory(chatId, limit = 50) {
    // Try cache first
    const cached = await redisCache.getMessageHistory(chatId, limit);
    
    if (cached.length >= limit) {
      return cached;
    }

    // Fetch from WhatsApp if needed
    try {
      const messages = await this.sock.fetchMessageHistory(chatId, limit);
      
      // Save to cache
      if (messages?.messages) {
        for (const msg of messages.messages) {
          await redisCache.saveMessage(chatId, this._formatMessage(msg));
        }
        return messages.messages.map(m => this._formatMessage(m));
      }
    } catch (error) {
      logger.error({ error, chatId }, 'Failed to fetch message history');
    }
    
    return cached;
  }

  // ==================== Status ====================

  getConnectionStatus() {
    return {
      isConnected: this.isConnected,
      qrCode: this.qrCode,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  async logout() {
    if (this.sock) {
      await this.sock.logout();
      this.isConnected = false;
      this.qrCode = null;
      
      // Clear auth state
      if (fs.existsSync(config.authStateDir)) {
        fs.rmSync(config.authStateDir, { recursive: true });
      }
      
      logger.info('Logged out from WhatsApp');
    }
  }
}

export const whatsappClient = new WhatsAppClient();
