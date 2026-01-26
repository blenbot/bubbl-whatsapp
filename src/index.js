import { config } from './config.js';
import { logger } from './logger.js';
import { redisCache } from './redis.js';
import { whatsappClient } from './whatsapp.js';
import { messageHandler } from './handlers.js';
import { app } from './api.js';

async function main() {
  logger.info('Starting Bubbl WhatsApp Server...');

  try {
    // Connect to Redis
    logger.info('Connecting to Redis...');
    await redisCache.connect();

    // Initialize message handlers
    messageHandler.initialize();

    // Initialize WhatsApp client
    logger.info('Initializing WhatsApp client...');
    await whatsappClient.initialize();

    // Start HTTP server
    const server = app.listen(config.port, () => {
      logger.info({ port: config.port }, '🚀 Bubbl WhatsApp Server is running');
      logger.info(`   Health check: http://localhost:${config.port}/health`);
      logger.info(`   API docs: http://localhost:${config.port}/api`);
    });

    // Graceful shutdown
    const shutdown = async (signal) => {
      logger.info({ signal }, 'Shutdown signal received');

      server.close(async () => {
        logger.info('HTTP server closed');

        try {
          await redisCache.disconnect();
          logger.info('Redis disconnected');
        } catch (error) {
          logger.error({ error }, 'Error disconnecting Redis');
        }

        process.exit(0);
      });

      // Force exit after 10 seconds
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
      logger.error({ error }, 'Uncaught exception');
      shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error({ reason }, 'Unhandled rejection');
    });

  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  }
}

main();
