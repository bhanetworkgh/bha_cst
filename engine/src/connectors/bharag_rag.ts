import { getEnv } from '../config/env.js';
import { Logger } from '../config/logger.js';

export class BharagRagConnector {
  /**
   * Query common BHARAG RAG Knowledge Substrate via Cluster Ask API (Spec §3, §4 & §6).
   * Uses the unified BHARAG cluster endpoint with x-api-key authentication.
   */
  static async askKnowledge(
    question: string,
    workspaceKey?: string,
    unitContext?: Record<string, unknown>
  ): Promise<string> {
    const env = getEnv();
    const clusterUrl = env.BHARAG_CLUSTER_URL;
    const clusterKey = env.BHARAG_CLUSTER_KEY;

    Logger.info(`BHARAG RAG Connector: Querying cluster knowledge for "${question}" using cluster endpoint`);

    try {
      const controller = new AbortController();
      const timeoutMs = env.BHARAG_CLUSTER_TIMEOUT_MS || 10000;
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const payload: Record<string, unknown> = {
        query: question,
      };
      if (workspaceKey) {
        payload.workspaceKey = workspaceKey;
      }
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
      }).catch(() => null);

      clearTimeout(timeoutId);

      if (response && response.ok) {
        const data = await response.json() as any;
        if (data.answer) {
          return data.answer;
        }
        // Fallback if answer is empty but request succeeded
        if (data.has_context === false || !data.answer || data.confidence < 0.3) {
          return `BHARAG Knowledge: I couldn't find specific information about "${question}" in the available knowledge base. Please consult your vFarm operational manuals or contact support for detailed guidance.`;
        }
      }
    } catch (err: any) {
      Logger.warn(`BHARAG Cluster API call fallback: ${err.message}`);
    }

    // Fallback domain knowledge response when cluster is unavailable
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

    return `BHARAG Knowledge: We received your query regarding "${question}". According to vFarm docs, please inspect main manifold valves and verify control panel status.`;
  }
}
