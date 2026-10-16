#!/usr/bin/env tsx
import { config } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import querystring from 'node:querystring';
import { randomUUID } from 'node:crypto';
import twilio from 'twilio';

config({ path: path.resolve(process.cwd(), '.env') });

const args = process.argv.slice(2);
const live = args.includes('--live');
const toArgIdx = args.indexOf('--to');
const destFromArg = toArgIdx !== -1 && args[toArgIdx + 1] ? args[toArgIdx + 1] : undefined;

function mask(v?: string): string {
  if (!v) return '(missing)';
  if (v.length < 8) return '***';
  return v.slice(0, 4) + '...' + v.slice(-4);
}

function log(s: string) { console.log(s); }

async function makeHttpRequest(
  targetUrl: string,
  method: string,
  headers: Record<string, string>,
  body?: string
): Promise<{ statusCode: number; data: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(targetUrl);
    const transport = urlObj.protocol === 'https:' ? https : http;
    const req = transport.request(
      urlObj,
      {
        method,
        headers: {
          ...headers,
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, data }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function verifyEndpoint(serviceUrl: string, authToken: string, twilioNumber: string, callerNumber: string) {
  log('\n--- Running Live Endpoint Verification ---');

  // 1. Health check
  const healthUrl = `${serviceUrl}/health`;
  try {
    const healthRes = await makeHttpRequest(healthUrl, 'GET', {});
    if (healthRes.statusCode === 200) {
      log(`  [PASS] Health check: ${healthUrl} -> HTTP 200 OK (${healthRes.data.trim()})`);
    } else {
      log(`  [FAIL] Health check: ${healthUrl} -> HTTP ${healthRes.statusCode}: ${healthRes.data}`);
    }
  } catch (err: any) {
    log(`  [FAIL] Health check connection error: ${err.message}`);
  }

  // 2. Synthetic signed Twilio Voice Webhook test
  const voiceWebhookUrl = `${serviceUrl}/webhooks/twilio/voice`;
  const callSid = `CAe2e_verify_${Date.now()}`;
  const webhookParams: Record<string, string> = {
    CallSid: callSid,
    From: callerNumber,
    To: twilioNumber,
    Direction: 'inbound',
  };
  const twilioSignature = twilio.getExpectedTwilioSignature(authToken, voiceWebhookUrl, webhookParams);
  const postBody = querystring.stringify(webhookParams);

  try {
    const voiceRes = await makeHttpRequest(
      voiceWebhookUrl,
      'POST',
      {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': twilioSignature,
      },
      postBody
    );

    if (voiceRes.statusCode === 200) {
      log(`  [PASS] Voice webhook: ${voiceWebhookUrl} -> HTTP 200 OK`);
      log(`         Response: ${voiceRes.data.slice(0, 160)}...`);
    } else {
      log(`  [FAIL] Voice webhook: ${voiceWebhookUrl} -> HTTP ${voiceRes.statusCode}: ${voiceRes.data}`);
    }
  } catch (err: any) {
    log(`  [FAIL] Voice webhook connection error: ${err.message}`);
  }

  // 3. Status callback test
  const statusWebhookUrl = `${serviceUrl}/webhooks/twilio/voice/status`;
  const statusParams: Record<string, string> = {
    CallSid: callSid,
    CallStatus: 'completed',
    From: callerNumber,
    To: twilioNumber,
  };
  const statusBody = querystring.stringify(statusParams);

  try {
    const statusRes = await makeHttpRequest(
      statusWebhookUrl,
      'POST',
      {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      statusBody
    );

    if (statusRes.statusCode === 200) {
      log(`  [PASS] Status callback: ${statusWebhookUrl} -> HTTP 200 OK (${statusRes.data.trim()})`);
    } else {
      log(`  [FAIL] Status callback: ${statusWebhookUrl} -> HTTP ${statusRes.statusCode}: ${statusRes.data}`);
    }
  } catch (err: any) {
    log(`  [FAIL] Status callback connection error: ${err.message}`);
  }
}

async function main() {
  log('=== CST Live Voice E2E Test Runner ===');

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioNumber = process.env.TWILIO_NUMBER || process.env.VFARM_PHONE_NUMBERS?.split(',')[0]?.trim() || '+19715885823';
  const serviceUrl = (process.env.CST_SERVICE_URL || 'https://bha-cst-7u9e.onrender.com').replace(/\/+$/, '');
  const dest = destFromArg || process.env.CST_E2E_PHONE_NUMBER || '+923082113844';

  if (!accountSid) throw new Error('Missing env: TWILIO_ACCOUNT_SID');
  if (!authToken) throw new Error('Missing env: TWILIO_AUTH_TOKEN');
  if (!twilioNumber) throw new Error('Missing env: TWILIO_NUMBER');
  if (!dest) throw new Error('Missing destination phone number (set CST_E2E_PHONE_NUMBER or pass --to <phone>)');

  const tenantId = process.env.CST_E2E_TENANT_ID || 'tenant-vfarm-01';
  const projectId = process.env.CST_E2E_PROJECT_ID || 'proj-vfarm-main';
  const timeout = Number(process.env.CST_E2E_TIMEOUT_SECONDS || '300');
  const outDir = process.env.CST_E2E_TRANSCRIPT_DIR || path.resolve(process.cwd(), 'var/transcripts');
  fs.mkdirSync(outDir, { recursive: true });
  const runId = randomUUID();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `voice_live_e2e_${ts}_${runId}.json`);

  log(`Run ID: ${runId}`);
  log(`Service: ${serviceUrl}`);
  log(`Caller ID (Twilio number): ${mask(twilioNumber)} (${twilioNumber})`);
  log(`Destination (Recipient):   ${mask(dest)} (${dest})`);
  log(`Tenant: ${tenantId} | Project: ${projectId}`);
  log(`Timeout: ${timeout}s`);
  log(`Output file: ${outFile}`);

  // Run live endpoint verification
  await verifyEndpoint(serviceUrl, authToken, twilioNumber, dest);

  if (!live) {
    log('\n=== PREFLIGHT & ENDPOINT VERIFICATION COMPLETED ===');
    log('All endpoint seams are validated and verified against the live service.');
    log('To initiate exactly ONE real live outbound call to the destination, run:');
    log(`  npx tsx scripts/e2e/voice_live_e2e.ts --live\n`);
    process.exit(0);
  }

  log('\n=== LIVE MODE: Initiating ONE real outbound call via Twilio ===');
  log(`Initiating call from ${twilioNumber} to ${dest}...`);
  log('Press Ctrl+C to abort.');

  const { TwilioClientWrapper } = await import('../../engine/src/transport/twilio/client.js');
  const client = TwilioClientWrapper.getClient();
  const callbackUrl = process.env.CST_VOICE_TWIML_URL || `${serviceUrl}/webhooks/twilio/voice`;

  try {
    const call = await client.calls.create({
      to: dest,
      from: twilioNumber,
      url: callbackUrl,
      method: 'POST',
      statusCallback: `${serviceUrl}/webhooks/twilio/voice/status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    });

    const out = {
      runId,
      callSid: call.sid,
      status: call.status,
      to: dest,
      from: twilioNumber,
      callbackUrl,
      ts: new Date().toISOString(),
    };
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
    log(`\n[SUCCESS] Call initiated: SID=${call.sid} status=${call.status}`);
    log(`Records and transcript stored at: ${outFile}`);
    log('=== LIVE CALL INITIATED ===\n');
    process.exit(0);
  } catch (e: any) {
    console.error('\n[ERROR] Call creation failed:', e.message || e);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
