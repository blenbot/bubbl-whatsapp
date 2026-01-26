import { whatsappClient } from './whatsapp.js';
import { redisCache } from './redis.js';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Message handler that processes incoming WhatsApp messages
 * and forwards them to Bubbl core for processing
 */
class MessageHandler {
  constructor() {
    this.bubblCoreUrl = config.bubblCoreUrl;
  }

  /**
   * Resolve LID (Linked Device ID) to real JID using group participants
   * This is a fallback when participantPn is not available
   * @param {string} lid - The LID to resolve (e.g., "123456789@lid")
   * @param {object} groupMetadata - Group metadata containing participants
   * @returns {string|null} - The real JID or null if not found
   */
  _resolveLidFromParticipants(lid, groupMetadata) {
    if (!lid || !groupMetadata?.participants) return null;
    
    // Participants may have both 'id' (can be @lid) and 'jid' (real number)
    // or the mapping might be stored differently
    const participant = groupMetadata.participants.find(p => p.id === lid);
    if (participant?.jid) {
      return participant.jid;
    }
    
    // If no direct mapping found, return null
    return null;
  }

  /**
   * Initialize message handlers
   */
  initialize() {
    whatsappClient.on('message', async (data) => {
      try {
        await this.handleIncomingMessage(data);
      } catch (error) {
        logger.error({ error }, 'Error in message handler');
      }
    });

    whatsappClient.on('group_participants_update', async (data) => {
      try {
        await this.handleGroupParticipantsUpdate(data);
      } catch (error) {
        logger.error({ error }, 'Error handling group participants update');
      }
    });

    logger.info('Message handlers initialized');
  }

  /**
   * Handle incoming WhatsApp message
   */
  async handleIncomingMessage(data) {
    let {
      chatId,
      sender,
      isGroup,
      isFromMe,
      messageContent,
      formattedMessage,
      groupMetadata,
    } = data;

    // Skip messages from self
    if (isFromMe) {
      logger.debug({ chatId }, 'Skipping self message');
      return;
    }

    // Skip non-text messages for now (can be extended later)
    if (messageContent.type !== 'text') {
      logger.debug({ chatId, type: messageContent.type }, 'Skipping non-text message');
      return;
    }

    // Additional LID fallback resolution using group participants
    // This handles cases where whatsapp.js couldn't resolve the LID
    if (isGroup && /@lid/.test(sender) && groupMetadata) {
      const resolvedJid = this._resolveLidFromParticipants(sender, groupMetadata);
      if (resolvedJid) {
        logger.info({ 
          originalSender: sender, 
          resolvedJid 
        }, 'Resolved LID from group participants');
        sender = resolvedJid;
      }
    }

    const text = messageContent.text;
    
    logger.info({
      chatId,
      sender,
      isGroup,
      textPreview: text.substring(0, 50),
    }, 'Processing incoming message');

    // Prepare payload for Bubbl core
    const payload = {
      platform: 'whatsapp',
      chat_id: chatId,
      sender: this._formatPhoneNumber(sender),
      text: text,
      is_group: isGroup,
      timestamp: formattedMessage.timestamp,
      sender_name: formattedMessage.pushName,
    };

    // Add group-specific data
    if (isGroup && groupMetadata) {
      payload.group_name = groupMetadata.subject;
      payload.participants = (groupMetadata.participants || []).map(p => ({
        id: this._formatPhoneNumber(p.id),
        admin: p.admin,
      }));
      
      // Fetch group invite link for storage (non-blocking, continues even if this fails)
      try {
        const inviteLink = await whatsappClient.getGroupInviteLink(chatId);
        if (inviteLink) {
          payload.invite_link = inviteLink;
          logger.debug({ chatId, inviteLink }, 'Added invite link to payload');
        }
      } catch (error) {
        logger.debug({ error, chatId }, 'Could not fetch invite link (non-critical)');
      }
    }

    // Get message history
    const history = await redisCache.getMessageHistory(chatId, 50);
    payload.history = history.map(msg => ({
      sender: this._formatPhoneNumber(msg.sender),
      text: msg.content?.text || '',
      timestamp: msg.timestamp,
      is_from_me: msg.isFromMe,
    }));

    // Forward to Bubbl core via HTTP
    try {
      const response = await this._sendToBubblCore(payload);
      
      if (response && response.reply) {
        await whatsappClient.sendTextMessage(chatId, response.reply);
        logger.info({ chatId }, 'Reply sent');
      }
    } catch (error) {
      logger.error({ error, chatId }, 'Failed to process message with Bubbl core');
    }
  }

  /**
   * Handle group participants update
   */
  async handleGroupParticipantsUpdate({ id, participants, action }) {
    const payload = {
      platform: 'whatsapp',
      event: 'group_participants_update',
      group_id: id,
      participants: participants.map(p => this._formatPhoneNumber(p)),
      action: action, // 'add', 'remove', 'promote', 'demote'
    };

    try {
      await this._sendToBubblCore(payload, '/webhook/group-update');
    } catch (error) {
      logger.error({ error }, 'Failed to notify Bubbl core of group update');
    }
  }

  /**
   * Format WhatsApp JID to phone number with country code
   * Ensures phone numbers have + prefix for consistency with Firestore
   * Handles LID (Linked Device ID) format which cannot be directly converted
   */
  _formatPhoneNumber(jid) {
    if (!jid) return null;
    
    // Check if this is an LID (Linked Device ID)
    // LIDs are internal WhatsApp identifiers that may not have been resolved to phone numbers
    if (/@lid/.test(jid)) {
      // Log at debug level since this can happen during the resolution process
      logger.debug({ jid }, 'Received LID - will use LID identifier for now');
      // Extract the LID user portion (without device number) for identification
      // Format: "123456789:0@lid" -> we want "123456789"
      const lidUser = jid.split('@')[0].split(':')[0];
      // Return with a special prefix to indicate this is an LID-based identifier
      // The backend should handle this appropriately
      return lidUser ? `lid:${lidUser}` : null;
    }
    
    // Remove @s.whatsapp.net or @g.us suffix and extract digits
    const digits = jid.split('@')[0].replace(/[^0-9]/g, '');
    // Always add + prefix for consistent storage/lookup
    return digits ? `+${digits}` : null;
  }

  /**
   * Send data to Bubbl core Python server
   */
  async _sendToBubblCore(payload, endpoint = '/webhook/whatsapp') {
    try {
      const response = await fetch(`${this.bubblCoreUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      logger.error({ error, endpoint }, 'Failed to communicate with Bubbl core');
      throw error;
    }
  }
}

export const messageHandler = new MessageHandler();


/**
 * Send message to a WhatsApp chat
 * This function is called from the HTTP API
 */
export async function sendMessage(chatId, message, options = {}) {
  // Format JID if needed - strip + prefix if present for WhatsApp JID format
  let jid;
  if (chatId.includes('@')) {
    jid = chatId;
  } else {
    // Remove + prefix if present, WhatsApp JIDs use raw digits
    const digits = chatId.replace(/^\+/, '').replace(/[^0-9]/g, '');
    jid = `${digits}@s.whatsapp.net`;
  }
  
  logger.info({ jid, messagePreview: message.substring(0, 50) }, 'Sending message');
  
  return await whatsappClient.sendTextMessage(jid, message, options);
}

/**
 * Send message to a WhatsApp group
 */
export async function sendGroupMessage(groupId, message, options = {}) {
  // Format JID if needed - handle various group ID formats
  let jid;
  if (groupId.includes('@')) {
    jid = groupId;
  } else {
    // Remove any non-numeric characters except - for group IDs
    const cleanId = groupId.replace(/[^0-9\-]/g, '');
    jid = `${cleanId}@g.us`;
  }
  
  logger.info({ jid, messagePreview: message.substring(0, 50) }, 'Sending group message');
  
  return await whatsappClient.sendTextMessage(jid, message, options);
}

/**
 * Get chat history for a specific chat
 */
export async function getChatHistory(chatId, limit = 50) {
  // Handle + prefix in phone numbers
  let jid;
  if (chatId.includes('@')) {
    jid = chatId;
  } else {
    const digits = chatId.replace(/^\+/, '').replace(/[^0-9]/g, '');
    jid = `${digits}@s.whatsapp.net`;
  }
  return await whatsappClient.fetchMessageHistory(jid, limit);
}

/**
 * Get group metadata
 */
export async function getGroupInfo(groupId) {
  let jid;
  if (groupId.includes('@')) {
    jid = groupId;
  } else {
    const cleanId = groupId.replace(/[^0-9\-]/g, '');
    jid = `${cleanId}@g.us`;
  }
  return await whatsappClient.getGroupMetadata(jid);
}

/**
 * Get all joined groups
 */
export async function getAllGroups() {
  return await whatsappClient.getAllGroups();
}
