import { getEnv } from '../config/env.js';
import { Logger } from '../config/logger.js';

/**
 * Masked workspace key for logs — shows presence only, never enough of the
 * value to reconstruct a short credential.
 */
function maskKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  if (key.length <= 8) return '***';
  return `${key.slice(0, 2)}***${key.slice(-2)}`;
}

/**
 * Classify a query into a safe loggable category. Never includes the raw
 * customer speech or any private knowledge content.
 */
function queryCategory(question: string): string {
  const q = (question || '').toLowerCase();
  if (/filter|clean|clean the filter/i.test(q)) return 'filter_maintenance';
  if (/ph|balance|pH/i.test(q)) return 'ph_balance';
  if (/light|cycle|photoperiod/i.test(q)) return 'lighting_cycle';
  if (/irrigation|water/i.test(q)) return 'irrigation';
  if (/vfarm|farm|status|reading|sensor|telemetry|temperature|humidity/i.test(q)) return 'farm_operational';
  return 'general_help';
}

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
    const startTime = Date.now();
    let responseStatus: number | undefined;
    let responseOk: boolean | undefined;
    const category = queryCategory(question);

    // Contextualize query with system name so BHARAG cluster router identifies the target workspace
    const qTrimmed = (question || '').trim();
    const hasSystemContext = /vfarm/i.test(qTrimmed);
    const framedQuery = hasSystemContext ? qTrimmed : `vFarm: ${qTrimmed}`;

    // Request start: log only category + masked key — never raw customer speech
    Logger.info(`BHARAG RAG Connector: Querying cluster knowledge using cluster endpoint`, {
      query_category: category,
      workspaceKey: maskKey(wsKey),
    });

    try {
      const controller = new AbortController();
      const timeoutMs = env.BHARAG_CLUSTER_TIMEOUT_MS || 10000;
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const payload: Record<string, unknown> = {
        query: framedQuery,
      };
      // BHARAG CST key boundary: per DW-1793623465895-F20Q, request body is query only.
      // Credential identity cst-help-read bound to BHARAG_CLUSTER_KEY restricts search scope
      // to cst-help-manuals upstream. workspaceKey and workspace overrides are omitted.
      // Farm-specific identifiers (farm_id, unit_id) are strictly prohibited (KMG9).

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
      const elapsedMs = Date.now() - startTime;

      responseStatus = response.status;
      responseOk = response.ok;

      // Log HTTP status and response shape (redacted — no credentials or knowledge content)
      const responseShape: Record<string, unknown> = { status: response.status, elapsedMs, ok: response.ok };

      if (response.ok) {
        let data: any;
        try {
          data = (await response.json()) as any;
        } catch (parseErr: any) {
          Logger.infra({
            message: 'BHARAG cluster knowledge API parse failure',
            commercial_impact: 'Customer cannot receive verified knowledge answers from BHARAG cluster. Malformed response discarded.',
            meta: {
              ...responseShape,
              query_category: category,
              workspaceKey: maskKey(wsKey),
              parse_error: parseErr?.message || String(parseErr),
            },
          });
          // Fall through to degraded fallback — do not claim knowledge was retrieved.
        }

        if (data) {
          const rawAnswer = data.answer || data.response || data.text || data.result;
          const lower = (rawAnswer && typeof rawAnswer === 'string') ? rawAnswer.toLowerCase() : '';
          const hasAnswer = Boolean(rawAnswer && typeof rawAnswer === 'string');
          const lacksInfo =
            !hasAnswer ||
            (lower.includes("don't have enough information") ||
              lower.includes('not enough information') ||
              lower.includes('could not find specific information') ||
              lower.includes('does not include any specific') ||
              lower.includes('no information')) ||
            (data.confidence != null && data.confidence < 0.3) ||
            data.has_context === false;

          if (!lacksInfo) {
            const cleanAnswer = rawAnswer
              .replace(/\s*\[\d+\]/g, '')
              .replace(/\s{2,}/g, ' ')
              .trim();
            Logger.info(`BHARAG RAG Connector: Knowledge answer received`, {
              query_category: category,
              elapsedMs,
              status: response.status,
              answer_present: true,
              answer_length: cleanAnswer.length,
            });
            return cleanAnswer;
          }

          Logger.info(`BHARAG RAG Connector: Knowledge answer absent or insufficient`, {
            query_category: category,
            elapsedMs,
            status: response.status,
            answer_present: false,
            has_context: data.has_context,
            confidence: data.confidence,
          });
        }
      } else {
        Logger.warn(`BHARAG Cluster API returned non-OK status: ${response.status} ${response.statusText}`);
        Logger.infra({
          message: `BHARAG cluster knowledge API error: HTTP ${response.status}`,
          commercial_impact: 'Customer cannot receive verified knowledge answers from BHARAG cluster. Answering via domain fallback. Knowledge may be incomplete.',
          meta: { ...responseShape, query_category: category, workspaceKey: maskKey(wsKey) },
        });
      }
    } catch (err: any) {
      const elapsedMs = Date.now() - startTime;
      const isTimeout = err?.name === 'AbortError' || /abort|timeout/i.test(String(err?.message));
      // Sanitize the error message so credentials embedded in exception text
      // (e.g. "token sk_live_abc123xyz") never reach the logs.
      const safeErrorMsg = String(err?.message || err).replace(
        /(token|key|secret|password|api[-_]?key)[\s:=]+[^\s,;}]+/gi,
        '$1 ***',
      );
      Logger.warn(
        `BHARAG Cluster API call ${isTimeout ? 'timeout' : 'error'}: ${safeErrorMsg}`,
        { elapsedMs, query_category: category, workspaceKey: maskKey(wsKey) }
      );
      Logger.infra({
        message: `BHARAG cluster knowledge API ${isTimeout ? 'timeout' : 'error'}`,
        commercial_impact: 'Customer cannot receive verified knowledge answers from BHARAG cluster. Answering via domain fallback. Knowledge may be incomplete.',
        meta: {
          status: responseStatus,
          ok: responseOk,
          elapsedMs,
          query_category: category,
          workspaceKey: maskKey(wsKey),
          error: safeErrorMsg,
        },
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
