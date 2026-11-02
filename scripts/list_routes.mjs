import { createApp } from '../dist/engine/src/app.js';
import fs from 'node:fs';

const app = createApp();

function getRoutes(app) {
  const routes = [];

  function processStack(stack, basePath = '') {
    for (const layer of stack) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods).map(m => m.toUpperCase());
        const path = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const p of path) {
          routes.push({
            method: methods.join(', '),
            path: basePath + p,
          });
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        let routePath = '';
        const str = layer.regexp?.source || '';
        if (str.includes('webhooks')) routePath = '/webhooks';
        else if (str.includes('api\\/v1\\/auth')) routePath = '/api/v1/auth';
        else if (str.includes('api\\/v1\\/admin')) routePath = '/api/v1/admin';
        else if (str.includes('api-docs')) routePath = '/api-docs';
        
        processStack(layer.handle.stack, basePath + routePath);
      }
    }
  }

  processStack(app._router.stack);
  return routes;
}

const routes = getRoutes(app);
fs.writeFileSync('scripts/routes.json', JSON.stringify(routes, null, 2));
console.log(`Saved ${routes.length} routes to scripts/routes.json`);
process.exit(0);
