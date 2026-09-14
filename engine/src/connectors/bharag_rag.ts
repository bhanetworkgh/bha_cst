import { getEnv } from '../config/env.js';
import { Logger } from '../config/logger.js';

export class BharagRagConnector {
  /**
   * Query common BHARAG RAG Knowledge Substrate via Cluster Ask API (Spec §3, §4 & §6).
   * Uses the unified BHARAG cluster endpoint with x-api-key authentication.
   * Disambiguates queries by contextualizing with system name when necessary.
   */
  static async askKnowledge(
    question: string,
    workspaceKey?: string,
    unitContext?: Record<string, unknown>
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
      if (unitContext?.farm_id) {
        payload.farm_id = unitContext.farm_id;
      }
      if (unitContext?.unit_id) {
        payload.unit_id = unitContext.unit_id;
      }

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

    // Fallback domain knowledge response when cluster is unavailable or lacks sufficient context
    const qLower = question.toLowerCase();
    if (qLower.includes('filter') || qLower.includes('clean')) {
      return 'BHARAG Knowledge: To clean the vFarm nutrient filter, shut off intake valve B, unthread filter casing, rinse mesh under warm water, and re-tighten to 5 Nm.';
    }
    if (qLower.includes('ph') || qLower.includes('balance')) {
      return 'BHARAG Knowledge: Ideal hydroponic pH is 5.8 - 6.5. Use pH Down (diluted phosphoric acid) if pH exceeds 6.8.';
    }
    if (qLower.includes('light') || qLower.includes('cycle')) {
      return 'BHARAG Knowledge: Standard LED lighting cycle is 18 hours ON / 6 hours OFF for vegetative growth stage.';
    }
    if (qLower.includes('irrigation') || qLower.includes('water')) {
      return 'BHARAG Knowledge: Irrigation rules vary by crop type and growth stage. Generally, maintain consistent moisture levels without waterlogging. Check specific crop guidelines in your vFarm documentation.';
    }

    return `BHARAG Knowledge: We received your query regarding "${question}". For detailed operational specifications, please consult your vFarm user manual or contact support for direct assistance.`;
  }
}

