import { cstStatusCommandCallback } from './cst-status.js';

export const register = (app) => {
  app.command('/cst-status', cstStatusCommandCallback);
};
