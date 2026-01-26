import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { logger } from './logger.js';
import { whatsappClient } from './whatsapp.js';
import { redisCache } from './redis.js';
import {
  sendMessage,
  sendGroupMessage,
  getChatHistory,
  getGroupInfo,
  getAllGroups,
} from './handlers.js';

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
  logger.debug({ method: req.method, path: req.path }, 'Incoming request');
  next();
});

// ==================== Health & Status ====================

app.get('/health', (req, res) => {
  const status = whatsappClient.getConnectionStatus();
  res.json({
    status: 'ok',
    whatsapp: {
      connected: status.isConnected,
      hasQR: !!status.qrCode,
      reconnectAttempts: status.reconnectAttempts,
    },
    timestamp: new Date().toISOString(),
  });
});

app.get('/status', async (req, res) => {
  try {
    const status = whatsappClient.getConnectionStatus();
    const metrics = await redisCache.getMessageMetrics(7);
    const queueLength = await redisCache.getQueueLength();

    res.json({
      connection: {
        connected: status.isConnected,
        hasQR: !!status.qrCode,
        reconnectAttempts: status.reconnectAttempts,
      },
      metrics,
      queueLength,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error({ error }, 'Error getting status');
    res.status(500).json({ error: 'Failed to get status' });
  }
});

app.get('/qr', (req, res) => {
  const status = whatsappClient.getConnectionStatus();
  
  if (status.isConnected) {
    return res.json({ 
      status: 'connected',
      message: 'Already connected to WhatsApp' 
    });
  }

  if (status.qrCode) {
    return res.json({ 
      status: 'pending',
      qr: status.qrCode,
      message: 'Scan QR code to connect' 
    });
  }

  res.json({ 
    status: 'initializing',
    message: 'QR code not yet available' 
  });
});

// ==================== Messaging ====================

/**
 * Send a text message to a private chat
 * POST /api/send
 * Body: { to: "phone_number", message: "text", platform: "whatsapp" }
 */
app.post('/api/send', async (req, res) => {
  try {
    const { to, message, platform } = req.body;

    if (!to || !message) {
      return res.status(400).json({ error: 'Missing required fields: to, message' });
    }

    // Only handle WhatsApp
    if (platform && platform !== 'whatsapp') {
      return res.status(400).json({ error: 'Invalid platform. Only whatsapp is supported.' });
    }

    const result = await sendMessage(to, message);
    
    res.json({
      success: true,
      messageId: result.key.id,
      timestamp: Date.now(),
    });
  } catch (error) {
    logger.error({ error }, 'Error sending message');
    res.status(500).json({ error: error.message });
  }
});

/**
 * Send a text message to a group
 * POST /api/send/group
 * Body: { groupId: "group_jid", message: "text" }
 */
app.post('/api/send/group', async (req, res) => {
  try {
    const { groupId, message } = req.body;

    if (!groupId || !message) {
      return res.status(400).json({ error: 'Missing required fields: groupId, message' });
    }

    const result = await sendGroupMessage(groupId, message);
    
    res.json({
      success: true,
      messageId: result.key.id,
      timestamp: Date.now(),
    });
  } catch (error) {
    logger.error({ error }, 'Error sending group message');
    res.status(500).json({ error: error.message });
  }
});

/**
 * Broadcast message to multiple recipients
 * POST /api/broadcast
 * Body: { recipients: ["phone1", "phone2"], message: "text" }
 */
app.post('/api/broadcast', async (req, res) => {
  try {
    const { recipients, message } = req.body;

    if (!recipients || !Array.isArray(recipients) || !message) {
      return res.status(400).json({ error: 'Missing required fields: recipients (array), message' });
    }

    const results = [];
    const errors = [];

    for (const recipient of recipients) {
      try {
        const result = await sendMessage(recipient, message);
        results.push({ recipient, messageId: result.key.id, success: true });
        
        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        errors.push({ recipient, error: error.message });
      }
    }

    res.json({
      success: errors.length === 0,
      sent: results.length,
      failed: errors.length,
      results,
      errors,
    });
  } catch (error) {
    logger.error({ error }, 'Error broadcasting message');
    res.status(500).json({ error: error.message });
  }
});

// ==================== History ====================

/**
 * Get chat history
 * GET /api/history/:chatId?limit=50
 */
app.get('/api/history/:chatId', async (req, res) => {
  try {
    const { chatId } = req.params;
    const limit = parseInt(req.query.limit) || 50;

    const history = await getChatHistory(chatId, limit);
    
    res.json({
      chatId,
      count: history.length,
      messages: history,
    });
  } catch (error) {
    logger.error({ error }, 'Error getting chat history');
    res.status(500).json({ error: error.message });
  }
});

// ==================== Groups ====================

/**
 * Get all joined groups
 * GET /api/groups
 */
app.get('/api/groups', async (req, res) => {
  try {
    const groups = await getAllGroups();
    
    const groupList = Object.entries(groups).map(([id, metadata]) => ({
      id,
      name: metadata.subject,
      participantCount: metadata.participants?.length || 0,
      description: metadata.desc,
      owner: metadata.owner,
      creation: metadata.creation,
    }));

    res.json({
      count: groupList.length,
      groups: groupList,
    });
  } catch (error) {
    logger.error({ error }, 'Error getting groups');
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get group info
 * GET /api/groups/:groupId
 */
app.get('/api/groups/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;
    const metadata = await getGroupInfo(groupId);
    
    res.json({
      id: metadata.id,
      name: metadata.subject,
      description: metadata.desc,
      owner: metadata.owner,
      creation: metadata.creation,
      participants: metadata.participants?.map(p => ({
        id: p.id,
        admin: p.admin,
      })),
    });
  } catch (error) {
    logger.error({ error }, 'Error getting group info');
    res.status(500).json({ error: error.message });
  }
});

// ==================== Webhook (for Bubbl Core to send responses) ====================

/**
 * Webhook endpoint for Bubbl core to send WhatsApp messages
 * POST /webhook/send
 * Body: { chat_id: "jid", message: "text", is_group: boolean }
 */
app.post('/webhook/send', async (req, res) => {
  try {
    const { chat_id, message, is_group } = req.body;

    if (!chat_id || !message) {
      return res.status(400).json({ error: 'Missing required fields: chat_id, message' });
    }

    let result;
    if (is_group) {
      result = await sendGroupMessage(chat_id, message);
    } else {
      result = await sendMessage(chat_id, message);
    }

    res.json({
      success: true,
      messageId: result.key.id,
    });
  } catch (error) {
    logger.error({ error }, 'Webhook send error');
    res.status(500).json({ error: error.message });
  }
});

// ==================== Admin ====================

/**
 * Logout from WhatsApp
 * POST /admin/logout
 */
app.post('/admin/logout', async (req, res) => {
  try {
    await whatsappClient.logout();
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    logger.error({ error }, 'Error logging out');
    res.status(500).json({ error: error.message });
  }
});

/**
 * Reconnect WhatsApp
 * POST /admin/reconnect
 */
app.post('/admin/reconnect', async (req, res) => {
  try {
    await whatsappClient.initialize();
    res.json({ success: true, message: 'Reconnection initiated' });
  } catch (error) {
    logger.error({ error }, 'Error reconnecting');
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get invite links for all groups (for migration purposes)
 * GET /admin/group-invite-links
 * Returns: { groups: [{ id, name, inviteLink }] }
 */
app.get('/admin/group-invite-links', async (req, res) => {
  try {
    const groups = await getAllGroups();
    const results = [];

    for (const [groupId, metadata] of Object.entries(groups)) {
      try {
        const inviteLink = await whatsappClient.getGroupInviteLink(groupId);
        results.push({
          id: groupId,
          name: metadata.subject,
          inviteLink: inviteLink || null,
        });
      } catch (error) {
        logger.debug({ error, groupId }, 'Could not get invite link for group');
        results.push({
          id: groupId,
          name: metadata.subject,
          inviteLink: null,
          error: 'Could not retrieve invite link',
        });
      }
    }

    res.json({
      success: true,
      count: results.length,
      groups: results,
    });
  } catch (error) {
    logger.error({ error }, 'Error getting group invite links');
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get invite link for a specific group
 * GET /admin/group-invite-link/:groupId
 */
app.get('/admin/group-invite-link/:groupId', async (req, res) => {
  try {
    let groupId = req.params.groupId;
    
    // Add @g.us suffix if not present
    if (!groupId.includes('@')) {
      groupId = `${groupId}@g.us`;
    }

    const inviteLink = await whatsappClient.getGroupInviteLink(groupId);
    
    if (inviteLink) {
      res.json({
        success: true,
        groupId,
        inviteLink,
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Could not retrieve invite link (may not have permission)',
      });
    }
  } catch (error) {
    logger.error({ error }, 'Error getting group invite link');
    res.status(500).json({ error: error.message });
  }
});

// ==================== Error Handler ====================

app.use((err, req, res, next) => {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

export { app };
