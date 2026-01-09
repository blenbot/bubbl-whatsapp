import Redis from 'ioredis';
import { config } from './config.js';
import { logger } from './logger.js';

class RedisCache {
  constructor() {
    this.client = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      retryDelayOnFailover: 100,
      enableReadyCheck: true,
      lazyConnect: true,
    });

    this.client.on('error', (err) => {
      logger.error({ err }, 'Redis connection error');
    });

    this.client.on('connect', () => {
      logger.info('Redis connected');
    });

    this.client.on('ready', () => {
      logger.info('Redis ready');
    });
  }

  async connect() {
    await this.client.connect();
  }

  async disconnect() {
    await this.client.quit();
  }

  // ==================== Message History ====================
  
  async saveMessage(chatId, message) {
    const key = `${config.redisKeys.messageHistory}${chatId}`;
    const messageData = JSON.stringify({
      ...message,
      timestamp: message.timestamp || Date.now(),
    });
    
    await this.client.lpush(key, messageData);
    await this.client.ltrim(key, 0, 499); // Keep last 500 messages
    await this.client.expire(key, config.cacheTTL.messageHistory * 24); // 24 hours
  }

  async getMessageHistory(chatId, limit = 50) {
    const key = `${config.redisKeys.messageHistory}${chatId}`;
    const messages = await this.client.lrange(key, 0, limit - 1);
    return messages.map(m => JSON.parse(m)).reverse();
  }

  async saveMessagesBatch(chatId, messages) {
    if (!messages.length) return;
    
    const key = `${config.redisKeys.messageHistory}${chatId}`;
    const pipeline = this.client.pipeline();
    
    for (const msg of messages) {
      pipeline.lpush(key, JSON.stringify({
        ...msg,
        timestamp: msg.timestamp || Date.now(),
      }));
    }
    
    pipeline.ltrim(key, 0, 499);
    pipeline.expire(key, config.cacheTTL.messageHistory * 24);
    
    await pipeline.exec();
  }

  // ==================== Group Metadata ====================
  
  async saveGroupMetadata(groupId, metadata) {
    const key = `${config.redisKeys.groupMetadata}${groupId}`;
    await this.client.setex(key, config.cacheTTL.groupMetadata, JSON.stringify(metadata));
  }

  async getGroupMetadata(groupId) {
    const key = `${config.redisKeys.groupMetadata}${groupId}`;
    const data = await this.client.get(key);
    return data ? JSON.parse(data) : null;
  }

  async updateGroupParticipants(groupId, participants) {
    const key = `${config.redisKeys.groupMetadata}${groupId}`;
    const existing = await this.getGroupMetadata(groupId);
    if (existing) {
      existing.participants = participants;
      await this.saveGroupMetadata(groupId, existing);
    }
  }

  // ==================== User Profile ====================
  
  async saveUserProfile(userId, profile) {
    const key = `${config.redisKeys.userProfile}${userId}`;
    await this.client.setex(key, config.cacheTTL.userProfile, JSON.stringify(profile));
  }

  async getUserProfile(userId) {
    const key = `${config.redisKeys.userProfile}${userId}`;
    const data = await this.client.get(key);
    return data ? JSON.parse(data) : null;
  }

  async updateUserLastSeen(userId) {
    const key = `${config.redisKeys.lastSeen}${userId}`;
    await this.client.set(key, Date.now().toString());
  }

  async getUserLastSeen(userId) {
    const key = `${config.redisKeys.lastSeen}${userId}`;
    const data = await this.client.get(key);
    return data ? parseInt(data, 10) : null;
  }

  // ==================== Connection State ====================
  
  async saveConnectionState(state) {
    const key = config.redisKeys.connectionState;
    await this.client.setex(key, config.cacheTTL.connectionState * 5, JSON.stringify({
      state,
      updatedAt: Date.now(),
    }));
  }

  async getConnectionState() {
    const key = config.redisKeys.connectionState;
    const data = await this.client.get(key);
    return data ? JSON.parse(data) : null;
  }

  // ==================== Message Queue ====================
  
  async queueOutgoingMessage(message) {
    await this.client.rpush(config.redisKeys.messageQueue, JSON.stringify({
      ...message,
      queuedAt: Date.now(),
    }));
  }

  async dequeueOutgoingMessage() {
    const data = await this.client.lpop(config.redisKeys.messageQueue);
    return data ? JSON.parse(data) : null;
  }

  async getQueueLength() {
    return await this.client.llen(config.redisKeys.messageQueue);
  }

  // ==================== Rate Limiting ====================
  
  async checkRateLimit(identifier) {
    const key = `${config.redisKeys.rateLimiter}${identifier}`;
    const count = await this.client.incr(key);
    
    if (count === 1) {
      await this.client.expire(key, 60); // 1 minute window
    }
    
    return {
      allowed: count <= config.rateLimitPerMinute,
      remaining: Math.max(0, config.rateLimitPerMinute - count),
      resetIn: await this.client.ttl(key),
    };
  }

  // ==================== Metrics ====================
  
  async incrementMessageCounter(type = 'incoming') {
    const dateKey = new Date().toISOString().split('T')[0];
    const key = `wa:metrics:${type}:${dateKey}`;
    await this.client.incr(key);
    await this.client.expire(key, 86400 * 30); // 30 days
  }

  async getMessageMetrics(days = 7) {
    const metrics = {};
    const now = new Date();
    
    for (let i = 0; i < days; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dateKey = date.toISOString().split('T')[0];
      
      const incoming = await this.client.get(`wa:metrics:incoming:${dateKey}`) || '0';
      const outgoing = await this.client.get(`wa:metrics:outgoing:${dateKey}`) || '0';
      
      metrics[dateKey] = {
        incoming: parseInt(incoming, 10),
        outgoing: parseInt(outgoing, 10),
      };
    }
    
    return metrics;
  }

  // ==================== Generic Operations ====================
  
  async set(key, value, ttl = null) {
    if (ttl) {
      await this.client.setex(key, ttl, JSON.stringify(value));
    } else {
      await this.client.set(key, JSON.stringify(value));
    }
  }

  async get(key) {
    const data = await this.client.get(key);
    return data ? JSON.parse(data) : null;
  }

  async delete(key) {
    await this.client.del(key);
  }

  async exists(key) {
    return (await this.client.exists(key)) === 1;
  }
}

export const redisCache = new RedisCache();
