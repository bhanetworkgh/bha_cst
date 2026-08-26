import { createApp } from './app.js';
import { getEnv } from './config/env.js';
import { Logger } from './config/logger.js';

const env = getEnv();
const app = createApp();

app.listen(env.PORT, () => {
  Logger.info(`CS Twin Engine listening on port ${env.PORT}`, {
    node_env: env.NODE_ENV,
  });
});
