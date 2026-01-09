import 'dotenv/config';

export const config = {
  // Server
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Redis
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  
  // Bubbl Core API
  bubblCoreUrl: process.env.BUBBL_CORE_URL || 'http://localhost:8080',
  
  // WhatsApp / Baileys
  browserType: process.env.BROWSER_TYPE || 'Desktop',
  syncFullHistory: process.env.SYNC_FULL_HISTORY === 'true',
  
  // Rate limiting
  rateLimitPerMinute: parseInt(process.env.RATE_LIMIT_PER_MINUTE || '30', 10),
  
  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
  
  // Auth state directory
  authStateDir: './auth_state',
  
  // Cache TTLs (in seconds)
  cacheTTL: {
    messageHistory: 3600,      // 1 hour
    groupMetadata: 1800,       // 30 minutes
    userProfile: 3600,         // 1 hour
    connectionState: 60,       // 1 minute
  },
  
  // Redis key prefixes
  redisKeys: {
    messageHistory: 'wa:history:',
    groupMetadata: 'wa:group:',
    userProfile: 'wa:user:',
    messageQueue: 'wa:queue:outgoing',
    connectionState: 'wa:connection:state',
    rateLimiter: 'wa:ratelimit:',
    lastSeen: 'wa:lastseen:',
  }
};
