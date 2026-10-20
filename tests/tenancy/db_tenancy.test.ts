import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient, CustomerRecord } from '../../engine/src/db/client.js';
import { CoreEngine } from '../../engine/src/core/engine.js';
import { ITenantAdapter } from '../../engine/src/adapters/types.js';
import { SpeakerIdentity, Project, Tenant } from '../../engine/src/core/types.js';

describe('CST DB Tenancy Refactor & Persistence Verification', () => {
  beforeEach(() => {
    DbClient.clearAll();
    DbClient.resetDurableStores();
    CoreRegistry.clear();
    CoreRegistry.resetToDefault();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1. Two tenants/projects remain isolated
  it('enforces strict isolation between two distinct tenants and projects', async () => {
    // Register Tenant A & Project A
    const tenantA: Tenant = {
      tenant_id: 'tenant-alpha',
      name: 'Alpha Agri',
      status: 'active',
      adapter_type: 'custom',
      created_at: new Date().toISOString(),
    };
    const projectA: Project = {
      project_id: 'proj-alpha-01',
      tenant_id: 'tenant-alpha',
      name: 'Alpha Project 1',
      status: 'active',
      capabilities: { sms: true },
      speaker_policy: 'allowlist',
    };
    CoreRegistry.registerTenant(tenantA);
    CoreRegistry.registerProject(projectA);

    // Register Tenant B & Project B
    const tenantB: Tenant = {
      tenant_id: 'tenant-beta',
      name: 'Beta Agri',
      status: 'active',
      adapter_type: 'custom',
      created_at: new Date().toISOString(),
    };
    const projectB: Project = {
      project_id: 'proj-beta-01',
      tenant_id: 'tenant-beta',
      name: 'Beta Project 1',
      status: 'active',
      capabilities: { sms: true },
      speaker_policy: 'allowlist',
    };
    CoreRegistry.registerTenant(tenantB);
    CoreRegistry.registerProject(projectB);

    // Bind DIDs
    CoreRegistry.bindServiceNumber({
      phone_e164: '+19715550001',
      tenant_id: 'tenant-alpha',
      project_id: 'proj-alpha-01',
      capability: 'sms',
      status: 'bound',
    });
    CoreRegistry.bindServiceNumber({
      phone_e164: '+19715550002',
      tenant_id: 'tenant-beta',
      project_id: 'proj-beta-01',
      capability: 'sms',
      status: 'bound',
    });

    // Verification: Outbound / Destination DID resolution preserves tenant boundary
    const bindingA = CoreRegistry.resolveServiceNumber('+19715550001');
    const bindingB = CoreRegistry.resolveServiceNumber('+19715550002');
    expect(bindingA?.tenant_id).toBe('tenant-alpha');
    expect(bindingB?.tenant_id).toBe('tenant-beta');
    expect(bindingA?.project_id).toBe('proj-alpha-01');
    expect(bindingB?.project_id).toBe('proj-beta-01');

    // Cross-tenant project validation fails
    expect(await DbClient.validateProjectScope('tenant-alpha', 'proj-beta-01')).toBe(false);
    expect(await DbClient.validateProjectScope('tenant-beta', 'proj-alpha-01')).toBe(false);
    expect(await DbClient.validateProjectScope('tenant-alpha', 'proj-alpha-01')).toBe(true);
  });

  // 2. DID binding persists across restart
  it('persists service number bindings across simulated process restart without auto-rebinding', async () => {
    // Custom tenant and binding
    const customTenant: Tenant = {
      tenant_id: 'tenant-custom-persist',
      name: 'Custom Persist Corp',
      status: 'active',
      adapter_type: 'custom',
      created_at: new Date().toISOString(),
    };
    const customProject: Project = {
      project_id: 'proj-custom-01',
      tenant_id: 'tenant-custom-persist',
      name: 'Custom Project',
      status: 'active',
      capabilities: { sms: true },
      speaker_policy: 'allowlist',
    };
    CoreRegistry.registerTenant(customTenant);
    CoreRegistry.registerProject(customProject);

    const customDid = '+19715559988';
    CoreRegistry.bindServiceNumber({
      phone_e164: customDid,
      tenant_id: 'tenant-custom-persist',
      project_id: 'proj-custom-01',
      capability: 'sms',
      status: 'bound',
    });

    // A number that is NOT in the seed and NOT in the database must never be
    // bound — not by the seed, and not by a restart.
    //
    // This used to be a stale assertion about '+19715885824' being a default
    // binding. That number is not owned by the Twilio account, so it is no
    // longer seeded; the assertion now guards the property that matters: a
    // phantom number is never bound.
    expect(CoreRegistry.resolveServiceNumber('+19715885824')).toBeNull();
    expect(CoreRegistry.resolveServiceNumber('+19715885825')).toBeNull();

    // Simulate process restart: completely wipe in-memory CoreRegistry
    CoreRegistry.clear();
    expect(CoreRegistry.resolveServiceNumber(customDid)).toBeNull();
    expect(CoreRegistry.getAllTenants().length).toBe(0);

    // Bootstrap from DB
    await CoreRegistry.initFromDb();

    // Verify custom binding was durably restored
    const restoredBinding = CoreRegistry.resolveServiceNumber(customDid);
    expect(restoredBinding).toBeDefined();
    expect(restoredBinding?.tenant_id).toBe('tenant-custom-persist');
    expect(restoredBinding?.project_id).toBe('proj-custom-01');

    // Verify the phantom number was NOT resurrected by the seed on restart
    expect(CoreRegistry.resolveServiceNumber('+19715885824')).toBeNull();
    expect(CoreRegistry.resolveServiceNumber('+19715885825')).toBeNull();
  });

  // 3. Conversations and customers are project-scoped
  it('scopes conversations and customers strictly by tenant_id + project_id', async () => {
    const speakerPhone = '+15550001122';

    // Seed customer with distinct farm grants in Project 1 vs Project 2
    DbClient.seedCustomer({
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      phone_e164: speakerPhone,
      customer_ref: 'cust_speaker_proj1',
      role: 'owner',
      farm_ids: ['farm_austin_main'],
    });

    DbClient.seedCustomer({
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-dallas',
      phone_e164: speakerPhone,
      customer_ref: 'cust_speaker_proj2',
      role: 'tech',
      farm_ids: ['farm_dallas_north'],
    });

    // Verify customer lookups return project-scoped identity and role
    const custProj1 = await DbClient.lookupCustomerByPhoneAsync(speakerPhone, 'tenant-vfarm-01', 'proj-vfarm-main');
    const custProj2 = await DbClient.lookupCustomerByPhoneAsync(speakerPhone, 'tenant-vfarm-01', 'proj-vfarm-dallas');

    expect(custProj1?.customer_ref).toBe('cust_speaker_proj1');
    expect(custProj1?.role).toBe('owner');
    expect(custProj1?.farm_ids).toEqual(['farm_austin_main']);

    expect(custProj2?.customer_ref).toBe('cust_speaker_proj2');
    expect(custProj2?.role).toBe('tech');
    expect(custProj2?.farm_ids).toEqual(['farm_dallas_north']);

    // Verify getOrCreateConversation creates separate conversations for the two projects
    const conv1 = await DbClient.getOrCreateConversation(
      'tenant-vfarm-01',
      'proj-vfarm-main',
      'cust_speaker_proj1',
      'tenant-vfarm-01',
      '',
      'proj-vfarm-main'
    );

    const conv2 = await DbClient.getOrCreateConversation(
      'tenant-vfarm-01',
      'proj-vfarm-dallas',
      'cust_speaker_proj2',
      'tenant-vfarm-01',
      '',
      'proj-vfarm-dallas'
    );

    expect(conv1.conversation_id).not.toBe(conv2.conversation_id);

    // Messages appended to conversation are scoped
    await DbClient.addMessageToTranscript({
      message_id: 'msg_proj1_001',
      conversation_id: conv1.conversation_id,
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      direction: 'inbound',
      from_e164: speakerPhone,
      to_e164: '+19715885823',
      body: 'Status check for project 1',
    });

    const messages1 = await DbClient.getMessagesForConversation(conv1.conversation_id, 'tenant-vfarm-01', 'proj-vfarm-main');
    expect(messages1.length).toBe(1);
    expect(messages1[0].project_id).toBe('proj-vfarm-main');

    // Querying with other project_id yields no messages
    const messages2 = await DbClient.getMessagesForConversation(conv1.conversation_id, 'tenant-vfarm-01', 'proj-vfarm-dallas');
    expect(messages2.length).toBe(0);
  });

  // 4. Speaker farm scope is enforced & fail closed
  it('enforces speaker farm scope, blocking access when farm_ids is empty or out-of-scope', async () => {
    // 4A: Speaker with empty farm_ids receives no farm data
    const emptyScopeSpeaker: SpeakerIdentity = {
      person_id: 'person_empty_farms',
      customer_ref: 'cust_empty_farms',
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      phone_e164: '+15553334444',
      is_known: true,
      role: 'owner',
      permissions: ['farm:read'],
      farm_ids: [], // Empty farm grants
    };

    const emptyEnvelope = {
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      channel: 'sms' as const,
      speaker_ref: '+15553334444',
      text: 'Give me status of the farm',
      media: [],
      correlation_id: 'corr_empty_farms',
    };

    const emptyResponse = await CoreEngine.processEnvelope(emptyEnvelope, emptyScopeSpeaker);
    expect(emptyResponse.reply_text).toContain('not linked to any active farm resources');
    expect(emptyResponse.reply_text).not.toContain('farm_austin');

    // 4B: Adapter failure / degraded state fails closed
    const mockFailingAdapter: ITenantAdapter = {
      tenantId: 'tenant-failing-adapter',
      pullProjects: vi.fn(),
      pullResourceScopes: vi.fn(),
      pullSpeakers: vi.fn(),
      pullCandidateNumbers: vi.fn(),
      resolveSpeaker: vi.fn().mockRejectedValue(new Error('Adapter timeout / downstream outage')),
    };

    CoreRegistry.registerTenant(
      {
        tenant_id: 'tenant-failing-adapter',
        name: 'Failing Tenant',
        status: 'active',
        adapter_type: 'failing',
        created_at: new Date().toISOString(),
      },
      mockFailingAdapter
    );

    const resolvedDegraded = await CoreRegistry.resolveSpeaker({
      tenantId: 'tenant-failing-adapter',
      projectId: 'proj-any',
      phoneE164: '+15559998888',
    });

    // Must fail closed with is_known: false and farm_ids: []
    expect(resolvedDegraded.is_known).toBe(false);
    expect(resolvedDegraded.role).toBe('unknown');
    expect(resolvedDegraded.farm_ids).toEqual([]);
  });

  // 5. No vFarm hardcoded tenancy remains
  it('executes end-to-end messaging for a completely arbitrary third-party tenant without vFarm artifacts', async () => {
    const thirdPartyTenant: Tenant = {
      tenant_id: 'tenant-hydro-green',
      name: 'HydroGreen Technologies',
      status: 'active',
      adapter_type: 'hydro',
      created_at: new Date().toISOString(),
    };

    const thirdPartyProject: Project = {
      project_id: 'proj-hydro-denver',
      tenant_id: 'tenant-hydro-green',
      name: 'Denver Facility',
      status: 'active',
      capabilities: { sms: true },
      speaker_policy: 'allowlist',
      onboarding_reply: 'Welcome to HydroGreen Denver Support! How can we assist you?',
    };

    CoreRegistry.registerTenant(thirdPartyTenant);
    CoreRegistry.registerProject(thirdPartyProject);

    CoreRegistry.bindServiceNumber({
      phone_e164: '+19715557766',
      tenant_id: 'tenant-hydro-green',
      project_id: 'proj-hydro-denver',
      capability: 'sms',
      status: 'bound',
    });

    // Unknown speaker -> receives third-party onboarding reply, zero vFarm references
    const unknownSpeaker: SpeakerIdentity = {
      person_id: 'opaque_unregistered',
      customer_ref: 'opaque_unregistered',
      tenant_id: 'tenant-hydro-green',
      project_id: 'proj-hydro-denver',
      phone_e164: '+15551112233',
      is_known: false,
      role: 'unknown',
      permissions: [],
      farm_ids: [],
    };

    const envelope = {
      tenant_id: 'tenant-hydro-green',
      project_id: 'proj-hydro-denver',
      channel: 'sms' as const,
      speaker_ref: '+15551112233',
      text: 'Hello, need help',
      media: [],
      correlation_id: 'corr_hydro_unknown',
    };

    const response = await CoreEngine.processEnvelope(envelope, unknownSpeaker);
    expect(response.reply_text).toContain('Welcome to HydroGreen Denver Support! How can we assist you?');
    expect(response.reply_text).toContain('To opt in, reply YES');
    expect(response.tenant_id).toBe('tenant-hydro-green');
    expect(response.project_id).toBe('proj-hydro-denver');
  });
});
