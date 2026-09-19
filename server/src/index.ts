import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import corsPlugin from '@fastify/cors';
import staticPlugin from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initDb } from './db/client.js';
import { registerApiRoutes } from './routes/api.js';
import { registerWebSocketRoutes } from './routes/ws.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let loggerConfig: any = true;
try {
  loggerConfig = {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        ignore: 'pid,hostname'
      }
    }
  };
} catch (_) {
  loggerConfig = true;
}

const fastify = Fastify({
  logger: loggerConfig
});

async function main() {
  // 1. Initialize SQLite Database & seed defaults
  initDb();

  // 2. Register plugins
  await fastify.register(corsPlugin, {
    origin: true,
    credentials: true
  });

  await fastify.register(websocketPlugin, {
    options: {
      maxPayload: 1024 * 1024 // 1MB max payload
    }
  });

  // 3. Register HTTP and WebSocket routes
  await registerApiRoutes(fastify);
  await registerWebSocketRoutes(fastify);

  // 4. Serve client SPA static files if built
  const clientDistPath = path.resolve(__dirname, '../../client/dist');
  if (fs.existsSync(clientDistPath)) {
    await fastify.register(staticPlugin, {
      root: clientDistPath,
      prefix: '/'
    });

    fastify.setNotFoundHandler((req, reply) => {
      if (req.raw.url && req.raw.url.startsWith('/api')) {
        reply.status(404).send({ error: 'API route not found' });
      } else {
        reply.sendFile('index.html');
      }
    });
  }

  const port = parseInt(process.env.PORT || '3001', 10);
  const host = process.env.HOST || '0.0.0.0';

  try {
    await fastify.listen({ port, host });
    console.log(`\n======================================================`);
    console.log(`🎯 Trivia Night App Server is listening on http://localhost:${port}`);
    console.log(`🔌 WebSocket endpoint available at ws://localhost:${port}/ws`);
    console.log(`======================================================\n`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

main();
