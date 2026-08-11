import 'dotenv/config';
import { createApp } from './server.js';
import { loadEnv } from './config/env.js';
import { logger } from './lib/logger.js';
import { installShutdown } from './lib/lifecycle.js';
import { prisma } from './lib/prisma.js';

const env = loadEnv();
const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Backend listening');
});
installShutdown(server, prisma);
