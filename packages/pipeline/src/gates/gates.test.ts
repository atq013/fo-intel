import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openExtractionEvent } from '@fo/core/contract/index.js';
import type { Claim, Entity, Evidence, GateContext, Observation } from '@fo/core/contract/index.js';

import { GATES } from './index.js';
import { coherenceGate } from './coherence.js';
import { releaseDecision } from '../release/gate.js';

/**
 * Every fixture below shipped to a customer in Stage 1.
 *
 * The exit criterion from the roadmap: each must be red before its gate exists
 * and green after. A gate that cannot turn a known, measured defect red is not
 * doing work, and this file is where that claim is settled rather than asserted.
 */

type Fixture = {
  id: string; defect: string; gate: string; firm: string; field: string;
  value: unknown; valueType: string; spanText: string; sourceUrl: string;
  expect: 'failed' | 'passed'; note: string;
};

const { fixtures } = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/stage1-defects.json', import.meta.url)), 'utf8'),
) as { fixtures: Fixture[] };

function buildContext(f: Fixture, extras: Claim[] = []): { claim: Claim; ctx: GateContext } {
  const observation: Observation = {
    id: 'obs_' + f.id, sourceId: 'src_' + f.id, url: f.sourceUrl,
    fetchedAt: new Date(), contentHash: 'h_' + f.id,
  };
  const event = openExtractionEvent({ observation, extractor: 'stage1-replay' });
  const { claim, establishing } = event.assert(
    { entityId: 'ent_' + f.id, field: f.field, value: f.value, valueType: f.valueType, confidence: 0.8 },
    { observationId: observation.id, spanText: f.spanText, method: f.spanText },
  );
  const entity: Entity = {
    id: 'ent_' + f.id, canonicalName: f.firm, entityType: 'unconfirmed', firstSeenAt: new Date(),
    trustState: 'active', commercialState: 'unassessed', strictReachable: false, profileAssistedReachable: false,
  };
  return {
    claim,
    ctx: { evidence: [establishing as Evidence], observation, siblings: extras, entity, policyVersion: 'test' },
  };
}

/**
 * The identity and contact_ownership gates ask about a *named person*, so the
 * fixture needs the principal's name alongside the value under test. Stage 1's
 * note field carries it, which is where it is read from.
 */
function siblingPerson(f: Fixture): Claim[] {
  const m = /attributed to ([^;]+);/.exec(f.note);
  if (!m) return [];
  const observation: Observation = {
    id: 'obs_sib_' + f.id, sourceId: 's', url: f.sourceUrl, fetchedAt: new Date(), contentHash: 'h',
  };
  const ev = openExtractionEvent({ observation, extractor: 'stage1-replay' });
  return [ev.assert(
    { entityId: 'ent_' + f.id, field: 'principal.fullName', value: m[1]!.trim(), valueType: 'person_name' },
    { observationId: observation.id, spanText: m[1]!.trim(), method: 'name of record' },
  ).claim];
}

for (const f of fixtures) {
  test(`${f.gate} · ${f.id} — ${f.defect}`, async () => {
    const { claim, ctx } = buildContext(f, siblingPerson(f));
    const gate = GATES.find((g) => g.name === f.gate);
    assert.ok(gate, `no gate named ${f.gate}`);

    const result = await gate.evaluate(claim, ctx);

    assert.equal(
      result.outcome,
      f.expect,
      `[${f.firm}] ${f.field} = ${JSON.stringify(f.value)}\n` +
        `      expected ${f.expect}, got ${result.outcome}: ${result.detail}\n` +
        `      fixture note: ${f.note}`,
    );

    // A failing gate must say what would otherwise have shipped. Without this
    // the evaluation in §11 cannot distinguish a load-bearing gate from a
    // decorative one, which is the whole point of recording counterfactuals.
    if (result.outcome === 'failed') {
      assert.ok(result.counterfactual, `${f.id}: failed without recording a counterfactual`);
    }
  });
}

/**
 * Coherence, reconstructed rather than replayed — and the reason is a finding.
 *
 * Across the 39 delivered records with a composite address, the number whose
 * parts cite different source URLs is zero. The addresses are wrong anyway: Kopp
 * shipped 701 CARLSON PARKWAY / 55305 / BLOOMINGTON, three parts that do not
 * form a real address, all citing one filing.
 *
 * They cite one URL *because the evidence was copied*. So no URL-keyed check
 * could ever have caught this, and the Stage 1 file cannot supply a red fixture
 * for one. The values below are Kopp's real shipped values; the two extraction
 * events are the structure M1 added, which is what makes the defect visible.
 */
test('coherence · kopp-address — composite assembled from two readings', async () => {
  const mk = (field: string, value: string, url: string) => {
    const observation: Observation = {
      id: 'obs_' + field, sourceId: 'src', url, fetchedAt: new Date(), contentHash: 'h_' + field,
    };
    const ev = openExtractionEvent({ observation, extractor: 'stage1-replay' });
    return ev.assert(
      { entityId: 'ent_kopp', field, value, valueType: 'string' },
      { observationId: observation.id, spanText: value, method: 'read from the filing' },
    );
  };

  const filing = 'https://www.sec.gov/Archives/edgar/data/1683689/000168368921000004/primary_doc.xml';
  const street = mk('street', '701 CARLSON PARKWAY, SUITE 1030', filing);
  const postcode = mk('postcode', '55305', filing);
  const city = mk('city', 'BLOOMINGTON', filing);

  const entity: Entity = {
    id: 'ent_kopp', canonicalName: 'Kopp Family Office, LLC', entityType: 'unconfirmed',
    firstSeenAt: new Date(), trustState: 'active', commercialState: 'unassessed',
    strictReachable: false, profileAssistedReachable: false,
  };

  const result = await coherenceGate.evaluate(street.claim, {
    evidence: [street.establishing],
    siblings: [postcode.claim, city.claim],
    entity,
    policyVersion: 'test',
  });

  assert.equal(result.outcome, 'failed', `expected failure, got ${result.outcome}: ${result.detail}`);
  assert.match(result.detail!, /readings/);

  // The same three parts, from one reading, must pass -- otherwise the gate
  // rejects correct records too and is worthless.
  const obs: Observation = {
    id: 'obs_one', sourceId: 'src', url: filing, fetchedAt: new Date(), contentHash: 'h',
  };
  const one = openExtractionEvent({ observation: obs, extractor: 'stage1-replay' });
  const a = one.assert({ entityId: 'ent_kopp', field: 'street', value: '8400 NORMANDALE LAKE BOULEVARD SUITE 1450', valueType: 'string' }, { observationId: obs.id, spanText: 'x', method: 'm' });
  const b = one.assert({ entityId: 'ent_kopp', field: 'postcode', value: '55437', valueType: 'string' }, { observationId: obs.id, spanText: 'x', method: 'm' });
  const c = one.assert({ entityId: 'ent_kopp', field: 'city', value: 'BLOOMINGTON', valueType: 'string' }, { observationId: obs.id, spanText: 'x', method: 'm' });

  const ok = await coherenceGate.evaluate(a.claim, {
    evidence: [a.establishing], siblings: [b.claim, c.claim], entity, policyVersion: 'test',
  });
  assert.equal(ok.outcome, 'passed', `single-reading address must pass, got: ${ok.detail}`);
});

/** PTC-2: a skipped gate must never be counted as a gate that agreed. */
test('release · a skipped attribution holds the claim rather than releasing it', () => {
  const observation: Observation = {
    id: 'obs_p', sourceId: 's', url: 'https://example.test', fetchedAt: new Date(), contentHash: 'h',
  };
  const ev = openExtractionEvent({ observation, extractor: 't' });
  const { claim } = ev.assert(
    { entityId: 'e', field: 'street', value: '1 Test Street', valueType: 'string' },
    { observationId: observation.id, spanText: 'filed on the UK register for company 12706913', method: 'pointer' },
  );

  const decision = releaseDecision(claim, [
    { gate: 'schema', outcome: 'passed', band: 'A' },
    { gate: 'attribution', outcome: 'skipped', band: 'A', detail: 'pointer evidence' },
  ]);

  assert.equal(decision.decision, 'held');
  assert.deepEqual(decision.gatesSkipped, ['attribution']);
  assert.ok(!decision.gatesPassed.includes('attribution'));
});
