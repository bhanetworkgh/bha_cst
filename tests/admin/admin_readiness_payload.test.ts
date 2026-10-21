/**
 * Admin readiness payload — regression tests.
 *
 * `GET /api/v1/admin/health/verification` is the operator's console for the
 * platform. Two defects were found in it:
 *
 *  1. `voice_lane.healthy` was HARD-CODED `true`. The admin view therefore
 *     claimed the voice lane was healthy while the public `/health/voice`
 *     endpoint was correctly reporting it as degraded and refusing with 503.
 *     The two views contradicted each other, and the admin one was the
 *     optimistic one — the most dangerous direction for a readiness signal.
 *
 *  2. There was NO way for an operator to confirm the live `DRY_RUN` setting
 *     from an authorised surface. `DRY_RUN` decides whether CST events
 *     actually reach the Dashboard, and it was observable only by reading an
 *     environment variable on the host. It is now reported as a boolean in
 *     this ADMIN-AUTHENTICATED response — never in the general log stream,
 *     which is retained and widely read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { DbClient } from '../../engine/src/db/client.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import {
  CstDashboardPublisher,
  getDashboardPublisher,
} from '../../engine/src/publishers/dashboard.js';

const app = createApp();

describe('admin readiness — voice lane health is derived, not asserted', () => {
  beforeEach(() => {
    DbClient.clearAll();
    CoreRegistry.resetToDefault();
    SystemsRegistry.resetToDefault();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports the voice lane as NOT healthy when there is no recent delivery', async () => {
    const res = await request(app).get('/api/v1/admin/health/verification');

    expect(res.status).toBe(200);
    expect(res.body.voice_lane.recent_24h_deliveries_count).toBe(0);
    // NOT the hard-coded `true` this used to report.
    expect(res.body.voice_lane.healthy).toBe(false);
  });

  it('reports the voice lane as healthy once a delivery is verified in the window', async () => {
    await DbClient.recordVoiceDelivery({
      tenant_id: 'tenant-vfarm-01',
      status: 'sent',
      character_count: 120,
      audio_bytes: 4096,
      delivered_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    } as any);

    const res = await request(app).get('/api/v1/admin/health/verification');

    expect(res.status).toBe(200);
    expect(res.body.voice_lane.recent_24h_deliveries_count).toBeGreaterThan(0);
    expect(res.body.voice_lane.healthy).toBe(true);
  });

  it('agrees with the public /health/voice endpoint about the voice lane', async () => {
    // The two views must not contradict each other. With no deliveries the
    // public endpoint reports degraded/503 and the admin view must not claim
    // healthy.
    const publicHealth = await request(app).get('/health/voice');
    const adminHealth = await request(app).get('/api/v1/admin/health/verification');

    expect(publicHealth.status).toBe(503);
    expect(publicHealth.body.voice_lane.can_route_voice).toBe(false);
    expect(adminHealth.body.voice_lane.healthy).toBe(false);
  });
});

describe('admin readiness — the DRY_RUN setting is confirmable without exposing it in general logs', () => {
  beforeEach(() => {
    DbClient.clearAll();
    CoreRegistry.resetToDefault();
    SystemsRegistry.resetToDefault();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports the publisher mode and configuration state', async () => {
    // The publisher is process-wide state, so this asserts the CONTRACT of
    // the readiness payload — that it reports the publisher's mode and
    // configuration as booleans — and asserts the publisher's own
    // `isDryRun()` / `isConfigured()` directly. Asserting the route's
    // response against a swapped global publisher is order-sensitive: the
    // active publisher is a module-level singleton, so the assertion would
    // depend on what another test left in place.
    const dryRunPublisher = new CstDashboardPublisher({
      dashboardUrl: 'https://dashboard.example/ingest',
      dashboardKey: 'not-a-real-key',
      dryRun: true,
    });
    expect(dryRunPublisher.isDryRun()).toBe(true);
    expect(dryRunPublisher.isConfigured()).toBe(true);

    const livePublisher = new CstDashboardPublisher({
      dashboardUrl: 'https://dashboard.example/ingest',
      dashboardKey: 'not-a-real-key',
      dryRun: false,
    });
    expect(livePublisher.isDryRun()).toBe(false);

    const res = await request(app).get('/api/v1/admin/health/verification');

    expect(res.status).toBe(200);
    expect(res.body.dashboard_publisher).toBeDefined();
    expect(typeof res.body.dashboard_publisher.dry_run).toBe('boolean');
    expect(typeof res.body.dashboard_publisher.configured).toBe('boolean');
  });

  it('never carries the dashboard key or any other credential', async () => {
    const res = await request(app).get('/api/v1/admin/health/verification');
    const serialised = JSON.stringify(res.body);

    // The dashboard key is whatever the deployment configured; it must never
    // be echoed back, whatever it is.
    const key = process.env.ENGINE_DASHBOARD_KEY;
    if (key) {
      expect(serialised).not.toContain(key);
    }
    expect(serialised).not.toContain('ENGINE_DASHBOARD_KEY=');
  });

  it('the readiness payload describes the live publisher', async () => {
    // The payload must describe the publisher the service actually uses.
    const publisher = getDashboardPublisher();
    expect(publisher).toBeTruthy();
    const res = await request(app).get('/api/v1/admin/health/verification');
    expect(res.body.dashboard_publisher.dry_run).toBe(publisher.isDryRun());
    expect(res.body.dashboard_publisher.configured).toBe(publisher.isConfigured());
  });
});
