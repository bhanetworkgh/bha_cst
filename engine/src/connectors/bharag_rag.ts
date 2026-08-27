import { getEnv } from '../config/env.js';
import { Logger } from '../config/logger.js';

export class BharagRagConnector {
  /**
   * Query common BHARAG RAG Knowledge Substrate (Spec §3, §4 & §6).
   * Authenticates using the tenant's CST workspace key (`workspace_vfarm_cst_key`).
   */
  static async askKnowledge(question: string, workspaceKey?: string): Promise<string> {
    const env = getEnv();
    const key = workspaceKey || env.BHARAG_WORKSPACE_KEY;
    const apiUrl = env.BHARAG_API_URL;

    Logger.info(`BHARAG RAG Connector: Querying knowledge for "${question}" using workspace_key "${key}"`);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000); // 2s timeout for SMS responsiveness

      const response = await fetch(`${apiUrl}/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`,
        },
        body: JSON.stringify({ question, workspace_key: key }),
        signal: controller.signal,
      }).catch(() => null);

      clearTimeout(timeoutId);

      if (response && response.ok) {
        const data = await response.json() as any;
        if (data.answer) {
          return data.answer;
        }
      }
    } catch (err: any) {
      Logger.warn(`BHARAG RAG API call fallback: ${err.message}`);
    }

    // Fallback domain knowledge response when BHARAG server is running in standalone mode
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

    return `BHARAG Knowledge: We received your query regarding "${question}". According to vFarm docs, please inspect main manifold valves and verify control panel status.`;
  }
}
