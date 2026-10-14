import { getEnv } from '../config/env.js';
import { Logger } from '../config/logger.js';

export class BharagRagConnector {
  /**
   * Query common BHARAG RAG Knowledge Substrate via Cluster Ask API (Spec §3, §4 & §6).
   * Uses the unified BHARAG cluster endpoint with x-api-key authentication.
   * Disambiguates queries by contextualizing with system name when necessary.
   * KMG9: Farm-specific identifiers (farm_id, unit_id) are NOT sent — the upstream
   * authorization boundary must enforce workspace scoping via workspaceKey/workspace.
   * Sending farm/unit identifiers without confirmed enforcement risks cross-tenant leakage.
   */
  static async askKnowledge(
    question: string,
    workspaceKey?: string,
    _unitContext?: Record<string, unknown>
  ): Promise<string> {
    const env = getEnv();
    const clusterUrl = env.BHARAG_CLUSTER_URL;
    const clusterKey = env.BHARAG_CLUSTER_KEY;
    const wsKey = workspaceKey || env.BHARAG_WORKSPACE_KEY;

    // Contextualize query with system name so BHARAG cluster router identifies the target workspace
    const qTrimmed = (question || '').trim();
    const hasSystemContext = /vfarm/i.test(qTrimmed);
    const framedQuery = hasSystemContext ? qTrimmed : `vFarm: ${qTrimmed}`;

    Logger.info(`BHARAG RAG Connector: Querying cluster knowledge for "${framedQuery}" using cluster endpoint`);

    try {
      const controller = new AbortController();
      const timeoutMs = env.BHARAG_CLUSTER_TIMEOUT_MS || 10000;
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const payload: Record<string, unknown> = {
        query: framedQuery,
        workspaceKey: wsKey,
        workspace: 'vfarm',
      };
      // KMG9: farm_id and unit_id intentionally omitted — upstream must enforce
      // workspace isolation via workspaceKey. CST cannot assume these fields
      // filter results unless the BHARAG API contract explicitly confirms it.

      const response = await fetch(clusterUrl, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'Content-Type': 'application/json',
          'x-api-key': clusterKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response && response.ok) {
        const data = (await response.json()) as any;
        const rawAnswer = data.answer || data.response || data.text || data.result;

        if (rawAnswer && typeof rawAnswer === 'string') {
          const lower = rawAnswer.toLowerCase();
          const lacksInfo =
            lower.includes("don't have enough information") ||
            lower.includes('not enough information') ||
            lower.includes('could not find specific information') ||
            lower.includes('does not include any specific') ||
            lower.includes('no information') ||
            (data.confidence != null && data.confidence < 0.3) ||
            data.has_context === false;

          if (!lacksInfo) {
            // Strip bracketed footnote citations (e.g. [1], [2]) for clean SMS presentation
            const cleanAnswer = rawAnswer
              .replace(/\s*\[\d+\]/g, '')
              .replace(/\s{2,}/g, ' ')
              .trim();
            return cleanAnswer;
          }
        }
      } else if (response) {
        Logger.warn(`BHARAG Cluster API returned non-OK status: ${response.status} ${response.statusText}`);
        Logger.infra({
          message: `BHARAG cluster knowledge API error: HTTP ${response.status}`,
          commercial_impact: 'Customer cannot receive verified knowledge answers from BHARAG cluster. Answering via domain fallback. Knowledge may be incomplete.',
          meta: { status: response.status, query: framedQuery, workspaceKey: wsKey },
        });
      }
    } catch (err: any) {
      Logger.warn(`BHARAG Cluster API call fallback: ${err.message}`);
      Logger.infra({
        message: 'BHARAG cluster knowledge API error or timeout',
        commercial_impact: 'Customer cannot receive verified knowledge answers from BHARAG cluster. Answering via domain fallback. Knowledge may be incomplete.',
        meta: { query: framedQuery, workspaceKey: wsKey, error: err.message },
      });
    }

    // ── Degraded fallback ──────────────────────────────────────────────────
    // BHARAG is unavailable or had no answer. We MUST NOT present canned text
    // as though BHARAG produced it (docs/degraded-state-spec-v0.1.md §3: no
    // synthetic values presented as authoritative). These strings are CST's own
    // static operator guidance, carry no farm-specific specification, and say so
    // explicitly; anything farm- or unit-specific is deferred to support.
    const prefix =
      'vFarm support (CST general guidance — the BHARAG knowledge base is unavailable, so this is not a verified answer for your site): ';

    const qLower = (question || '').toLowerCase();
    if (qLower.includes('filter') || qLower.includes('clean')) {
      return `${prefix}filter cleaning procedures vary between installations, so please confirm the procedure for your site with your vFarm manual or a support specialist before servicing the filter.`;
    }
    if (qLower.includes('ph') || qLower.includes('balance')) {
      return `${prefix}target pH depends on the crop and growth stage in your deployment, so please confirm the target range for your site with your vFarm manual or a support specialist before dosing.`;
    }
    if (qLower.includes('light') || qLower.includes('cycle')) {
      return `${prefix}lighting cycles are configured per installation, so please confirm the photoperiod for your site with your vFarm manual or a support specialist before changing it.`;
    }
    if (qLower.includes('irrigation') || qLower.includes('water')) {
      return `${prefix}irrigation rules vary by crop type and growth stage. Please consult your site-specific vFarm documentation or contact support for the values that apply to your installation.`;
    }

    return `${prefix}please consult your vFarm user manual or contact support for direct assistance with "${question}".`;
  }
}