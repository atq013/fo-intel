import { createHash, randomUUID } from 'node:crypto';
import type { Collector, Extractor, Observation, Source } from '@fo/core/contract/index.js';
import type { OpenExtractionEvent } from '@fo/core/contract/index.js';
import { search } from '../lib/serper.js';
import { checkProfileSlug } from '../gates/identity.js';

/**
 * Verified personal profiles — the only measured channel that moves the 200.
 *
 * Companies House publishes no contact routes and Form ADV has no contact field.
 * SEC 13F signature blocks do, but that channel's ceiling is 56 family-named
 * filers. This is what is left, and it measured 67% on a 30-entity sample.
 *
 * ### A profile is not a phone
 *
 * These routes count toward **profile-assisted** reachability only. The database
 * refuses `counts_strict` on a linkedin row, so a profile can never inflate the
 * strict figure. Whether a profile is a contact route at all is assumption A1,
 * which a reviewer may reject -- hence two numbers that never merge (ADR-11).
 *
 * ### What makes a result evidence
 *
 * That a profile appears in results for a query is worth nothing: Stage 1
 * shipped two wrong-person links found exactly that way. The evidence is the
 * slug encoding the person's surname, corroborated by another part of their
 * name or their initials, which the `identity` gate re-checks independently.
 * Results that fail are not stored -- an unverified profile is not a weak route,
 * it is someone else's.
 */

export const VERIFIED_PROFILE_SOURCE: Source = {
  id: 'src_verified_profile',
  kind: 'search_result',
  identifier: 'serper/linkedin-profile-verification',
  baseUrl: 'https://www.linkedin.com',
  // Tier 3: an aggregator surfaced it. The slug check is what promotes it from
  // "a link someone found" to evidence about a specific person.
  tier: 3,
  rateLimitPerMin: 60,
  consecutiveFailures: 0,
};

export interface ProfileTarget {
  entityId: string;
  firmName: string;
  person: string;
}

export function verifiedProfileCollector(targets: ProfileTarget[]): Collector {
  return {
    kind: 'search_result',
    async *collect(source: Source, cursor?: string) {
      const start = cursor ? targets.findIndex((t) => t.entityId === cursor) + 1 : 0;
      for (let i = Math.max(0, start); i < targets.length; i++) {
        const t = targets[i]!;

        // Unquoted. Exact-phrase matching on a name written "SURNAME, FIRST,
        // MIDDLE" returns almost nothing on the open web -- it produced a false
        // 0% on the first measurement run.
        let results: Awaited<ReturnType<typeof search>> = [];
        try {
          results = await search(`${t.person} ${t.firmName} linkedin`, { num: 10 });
        } catch {
          continue; // a search that failed is not a person without a profile
        }

        const profiles = results.filter((r) => /linkedin\.com\/in\//i.test(r.link));
        const verified = profiles
          .map((p) => ({ p, v: checkProfileSlug(p.link, t.person) }))
          .find((x) => x.v.ok);

        // Nothing verified: emit no observation. Storing a rejected profile as a
        // low-confidence route is how a wrong person reaches a customer.
        if (!verified) continue;

        const payload = JSON.stringify({
          entityId: t.entityId, firmName: t.firmName, person: t.person,
          url: verified.p.link, title: verified.p.title ?? '', snippet: verified.p.snippet ?? '',
          verification: verified.v.why,
        });

        yield {
          observation: {
            id: `obs_${randomUUID()}`,
            sourceId: source.id,
            url: verified.p.link,
            fetchedAt: new Date(),
            contentHash: 'sha256:' + createHash('sha256').update(payload).digest('hex').slice(0, 32),
            httpStatus: 200,
            body: payload,
          },
          cursor: t.entityId,
        };
      }
    },
  };
}

export function verifiedProfileExtractor(): Extractor {
  return {
    name: 'verified_profile@1',

    async extract(observation: Observation, event: OpenExtractionEvent): Promise<void> {
      const d = JSON.parse(observation.body ?? '{}') as {
        entityId: string; person: string; url: string; title: string; verification: string;
      };
      if (!d.entityId || !d.url) return;

      // The span carries the profile URL and the person as the profile itself
      // renders them, so `contact_ownership` can check the route is bound to
      // this person's evidence rather than merely adjacent to it.
      const span =
        `LinkedIn profile result — URL: ${d.url} | Title: ${d.title || 'not stated'} | ` +
        `Named person of record: ${d.person}`;

      event.assert(
        {
          entityId: d.entityId,
          field: 'principal.linkedinUrl',
          value: d.url,
          valueType: 'profile_url',
          confidence: 0.8,
          // Profiles move: people change firms, and a profile that was right in
          // July is a liability in October.
          refreshPolicy: 'volatile',
        },
        { observationId: observation.id, spanText: span, method: d.verification },
      );
    },
  };
}
