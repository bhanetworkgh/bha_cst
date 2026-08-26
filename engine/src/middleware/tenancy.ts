import { Request, Response, NextFunction } from 'express';
import { Logger } from '../config/logger.js';

export interface TenancyContext {
  tenant_id: string;
  system_id: string;
  role: string;
  scope_resolved_by: 'receiving_number' | 'jwt' | 'system_service';
}

declare global {
  namespace Express {
    interface Request {
      tenancy?: TenancyContext;
    }
  }
}

export function enforceTenancyGate(req: Request, res: Response, next: NextFunction): void {
  const tenancy = req.tenancy;

  if (!tenancy || !tenancy.tenant_id) {
    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: null,
      actor: (req.headers['x-actor-id'] as string) || 'anonymous',
      role: 'none',
      entry_point: req.path.startsWith('/webhooks') ? 'webhook' : 'api',
      tool_or_route: req.originalUrl || req.path,
      outcome: 'refused',
      reason: 'Missing or unresolved server-side tenant scope (fail closed)',
    });

    res.status(403).json({
      error: 'TENANT_SCOPE_VIOLATION',
      message: 'Unresolved server-side tenant scope',
    });
    return;
  }

  // Cross-tenant payload tamper prevention:
  // If request body contains a tenant_id, it MUST match the server-resolved tenant_id
  if (req.body && typeof req.body === 'object' && 'tenant_id' in req.body) {
    if (req.body.tenant_id !== tenancy.tenant_id) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: tenancy.tenant_id,
        actor: tenancy.tenant_id,
        role: tenancy.role,
        entry_point: req.path.startsWith('/webhooks') ? 'webhook' : 'api',
        tool_or_route: req.originalUrl || req.path,
        outcome: 'refused',
        reason: `Cross-tenant payload mismatch: body tenant_id (${req.body.tenant_id}) !== resolved (${tenancy.tenant_id})`,
      });

      res.status(403).json({
        error: 'TENANT_SCOPE_VIOLATION',
        message: 'Client-provided tenant_id overrides are strictly forbidden',
      });
      return;
    }
  }

  next();
}
