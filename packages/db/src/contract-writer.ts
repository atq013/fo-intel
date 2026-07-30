import { connect } from './connect.js';
import type {
  Assertion,
  Claim,
  Entity,
  Evidence,
  ExtractionEvent,
  GateResult,
  Observation,
  ReleaseDecision,
  Source,
} from '@fo/core/contract/index.js';

/**
 * Persistence for the contract.
 *
 * The one rule this file exists to keep: an extraction event, its claims and
 * their establishing evidence are written together or not at all. A partial
 * write would leave a claim with no basis -- which the database would reject on
 * the evidence insert, but only after the claim row was already committed if the
 * writes were independent.
 *
 * Neon's HTTP driver has no interactive transaction, but `transaction()` sends a
 * statement array as one atomic unit, which is exactly what is needed here: the
 * statements are known up front because the extraction event is already closed.
 */
export function contractWriter(connectionString: string) {
  const sql = connect(connectionString);

  return {
    async upsertSource(s: Source): Promise<void> {
      await sql`
        INSERT INTO s2_source (id, kind, identifier, base_url, tier, rate_limit_per_min)
        VALUES (${s.id}, ${s.kind}, ${s.identifier}, ${s.baseUrl ?? null}, ${s.tier}, ${s.rateLimitPerMin})
        ON CONFLICT (kind, identifier) DO UPDATE SET base_url = EXCLUDED.base_url`;
    },

    async upsertObservation(o: Observation): Promise<void> {
      await sql`
        INSERT INTO s2_observation (id, source_id, url, fetched_at, content_hash, raw_ref, http_status, notes)
        VALUES (${o.id}, ${o.sourceId}, ${o.url}, ${o.fetchedAt}, ${o.contentHash},
                ${o.rawRef ?? null}, ${o.httpStatus ?? null}, ${o.notes ?? null})
        ON CONFLICT (id) DO NOTHING`;
    },

    async upsertEntity(e: Entity): Promise<void> {
      await sql`
        INSERT INTO s2_entity (id, canonical_name, entity_type, trust_state, commercial_state,
                               strict_reachable, profile_assisted_reachable)
        VALUES (${e.id}, ${e.canonicalName}, ${e.entityType}, ${e.trustState}, ${e.commercialState},
                ${e.strictReachable}, ${e.profileAssistedReachable})
        ON CONFLICT (id) DO UPDATE SET
          canonical_name = EXCLUDED.canonical_name,
          trust_state = EXCLUDED.trust_state,
          commercial_state = EXCLUDED.commercial_state,
          strict_reachable = EXCLUDED.strict_reachable,
          profile_assisted_reachable = EXCLUDED.profile_assisted_reachable,
          updated_at = now()`;
    },

    /**
     * Write a closed extraction event atomically.
     *
     * Ordering inside the batch matters: event, then claims, then evidence. The
     * composite foreign key on establishing evidence resolves against the claim
     * row, so the claim must exist in the same unit.
     */
    async writeEvent(
      event: ExtractionEvent,
      assertions: Assertion[],
      attached: Evidence[] = [],
    ): Promise<void> {
      const statements = [
        sql`INSERT INTO s2_extraction_event (id, run_id, observation_id, extractor, started_at, ended_at)
            VALUES (${event.id}, ${event.runId ?? null}, ${event.observationId}, ${event.extractor},
                    ${event.startedAt}, ${event.endedAt ?? null})
            ON CONFLICT (id) DO NOTHING`,
        ...assertions.map(({ claim }) => sql`
          INSERT INTO s2_claim (id, entity_id, extraction_event_id, field, value_json, value_type,
                                status, confidence, refresh_policy, established_at, expires_at)
          VALUES (${claim.id}, ${claim.entityId}, ${claim.extractionEventId}, ${claim.field},
                  ${JSON.stringify(claim.value)}::jsonb, ${claim.valueType}, ${claim.status},
                  ${claim.confidence}, ${claim.refreshPolicy}, ${claim.establishedAt}, ${claim.expiresAt ?? null})`),
        ...[...assertions.map((a) => a.establishing), ...attached].map((e) => sql`
          INSERT INTO s2_evidence (id, claim_id, observation_id, extraction_event_id, role,
                                   span_text, span_start, span_end, method, created_at)
          VALUES (${e.id}, ${e.claimId}, ${e.observationId}, ${e.extractionEventId}, ${e.role},
                  ${e.spanText}, ${e.spanStart ?? null}, ${e.spanEnd ?? null}, ${e.method}, ${e.createdAt})`),
      ];

      await sql.transaction(statements);
    },

    async recordGateResults(claimId: string, runId: string | null, results: GateResult[]): Promise<void> {
      if (!results.length) return;
      await sql.transaction(
        results.map((r) => sql`
          INSERT INTO s2_validation_result (id, claim_id, run_id, gate, outcome, band, detail, counterfactual)
          VALUES (${`vr_${claimId}_${r.gate}`}, ${claimId}, ${runId}, ${r.gate}, ${r.outcome}, ${r.band},
                  ${r.detail ?? null}, ${r.counterfactual ? JSON.stringify(r.counterfactual) : null}::jsonb)
          ON CONFLICT (claim_id, run_id, gate) DO UPDATE SET
            outcome = EXCLUDED.outcome, detail = EXCLUDED.detail,
            counterfactual = EXCLUDED.counterfactual, evaluated_at = now()`),
      );
    },

    /**
     * The chokepoint's write. The decision row and the status change go together,
     * so a released claim without a decision row naming its gates cannot exist --
     * that state is a bug the spec says must fail the build.
     */
    async applyRelease(d: ReleaseDecision, runId: string | null): Promise<void> {
      const status: Claim['status'] =
        d.decision === 'released' ? 'released' : d.decision === 'quarantined' ? 'quarantined' : 'candidate';

      await sql.transaction([
        sql`INSERT INTO s2_release_decision (id, claim_id, run_id, decision, gates_passed, gates_failed,
                                             gates_skipped, policy_version, reason)
            VALUES (${`rd_${d.claimId}_${d.policyVersion}`}, ${d.claimId}, ${runId}, ${d.decision},
                    ${d.gatesPassed}, ${d.gatesFailed}, ${d.gatesSkipped}, ${d.policyVersion}, ${d.reason ?? null})
            ON CONFLICT (id) DO UPDATE SET
              decision = EXCLUDED.decision, gates_passed = EXCLUDED.gates_passed,
              gates_failed = EXCLUDED.gates_failed, gates_skipped = EXCLUDED.gates_skipped,
              reason = EXCLUDED.reason, decided_at = now()`,
        sql`UPDATE s2_claim SET status = ${status}, updated_at = now() WHERE id = ${d.claimId}`,
      ]);
    },

    sql,
  };
}
