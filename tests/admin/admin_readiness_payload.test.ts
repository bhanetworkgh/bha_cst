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
  setActiveDashboardPublisher,
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
    setActiveDashboardPublisher(undefined as any);
    vi.restoreAllMocks();
  });

  it('reports the publisher mode and configuration state', async () => {
    const dryRunPublisher = new CstDashboardPublisher({
      dashboardUrl: 'https://dashboard.example/ingest',
      dashboardKey: 'not-a-real-key',
      dryRun: true,
    });
    setActiveDashboardPublisher(dryRunPublisher);

    const res = await request(app).get('/api/v1/admin/health/verification');

    expect(res.status).toBe(200);
    expect(res.body.dashboard_publisher).toBeDefined();
    expect(res.body.dashboard_publisher.dry_run).toBe(true);
    expect(res.body.dashboard_publisher.configured).toBe(true);
  });

  it('never carries the dashboard key or any other credential', async () => {
    const publisher = new CstDashboardPublisher({
      dashboardUrl: 'https://dashboard.example/ingest',
      dashboardKey: 'super-secret-dashboard-key-value',
      dryRun: false,
    });
    setActiveDashboardPublisher(publisher);

    const res = await request(app).get('/api/v1/admin/health/verification');
    const serialised = JSON.stringify(res.body);

    expect(res.body.dashboard_publisher.dry_run).toBe(false);
    expect(serialised).not.toContain('super-secret-dashboard-key-value');
  });

  it('the default publisher is the one the service uses', async () => {
    // The readiness payload must describe the LIVE publisher, not a copy.
    expect(getDashboardPublisher()).toBeTruthy();
    const res = await request(app).get('/api/v1/admin/health/verification');
    expect(typeof res.body.dashboard_publisher.dry_run).toBe('boolean');
  });
});
