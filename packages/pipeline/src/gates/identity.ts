import type { Claim, Gate, GateContext, GateResult } from '@fo/core/contract/index.js';

/**
 * Gate 4 · identity — is this the person we think, or a namesake?
 *
 * Stage 1 shipped two profile URLs belonging to entirely different people:
 * David Blitzer linked to /in/jonas-cohon, Rodger Riney to
 * /in/bobby-w-sandage-jr-phd-69087211. Both were found by a human reviewer after
 * submission.
 *
 * The Phase 0 spike re-derived them in microseconds with a slug check. That is
 * worth stating plainly: the defect that embarrassed the Stage 1 submission was
 * catchable by a string comparison nobody had written. The gate is cheap because
 * the check is cheap; it was missing because nobody asked the question.
 *
 * Band A despite being an identity question, because URL-slug verification needs
 * no network. Resolving the profile itself is Band B and comes later.
 */

/**
 * Which token is the surname depends on the source's format, and getting it
 * wrong silently inverts the check.
 *
 * SEC Schedule A and 13F signature blocks write "LOFTUS, DOUGLAS, PAUL" --
 * surname first. Companies House writes "BUTTAR, Sharnpreet Singh". Web sources
 * write "Douglas Loftus". Taking the last token as the surname is right for the
 * third form and wrong for the first two: it looked for "paul" and rejected
 * /in/dploftus, which is the correct profile for Douglas Paul Loftus.
 *
 * A comma is the reliable signal: everything before the first comma is the
 * family name.
 */
export function surnameOf(personName: string): string {
  const clean = personName.trim();
  const head = clean.includes(',') ? clean.split(',')[0]! : clean;
  const tokens = head.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter((t) => t.length > 1);
  if (clean.includes(',')) return tokens[tokens.length - 1] ?? '';
  return tokens[tokens.length - 1] ?? '';
}

export function checkProfileSlug(url: string, personName: string): { ok: boolean; why: string } {
  const slug = (url.split('/in/')[1] ?? '').split(/[/?#]/)[0]?.toLowerCase() ?? '';
  if (!slug) return { ok: false, why: 'not a personal profile URL' };

  const tokens = personName.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((t) => t.length > 2);
  if (!tokens.length) return { ok: false, why: 'no comparable name tokens' };

  const surname = surnameOf(personName);
  if (!surname) return { ok: false, why: 'could not identify a surname' };

  // A bare substring test is not enough. "CURTI, THOMAS, ALFRED" matched
  // /in/curtis-martin-thom, because "curti" sits inside "curtis" -- a different
  // person entirely, and exactly the wrong-person error this gate exists to
  // catch. So the surname must be corroborated by a second name part.
  // When the slug has separators it is telling us where the words end, and that
  // must be respected. "curti" is a substring of "curtis", so a bare
  // includes() matched /in/alfred-curtis for "CURTI, THOMAS, ALFRED" -- Alfred
  // Curtis, a different person, and precisely the wrong-person error this gate
  // exists to catch.
  //
  // Consecutive parts are also joined before comparing, because a slug splits
  // names the punctuation did not: "o-connor" is one surname, O'Connor.
  const parts = slug.split(/[^a-z]+/).filter(Boolean);
  const alpha = slug.replace(/[^a-z]/g, '');

  let surnameFound: boolean;
  if (parts.length > 1) {
    const joins = new Set<string>();
    for (let a = 0; a < parts.length; a++) {
      let acc = '';
      for (let b = a; b < parts.length && b < a + 3; b++) { acc += parts[b]; joins.add(acc); }
    }
    surnameFound = joins.has(surname);
  } else {
    // A concatenated slug gives no boundaries, so substring is all there is --
    // the corroboration check below is what keeps it honest.
    surnameFound = alpha.includes(surname);
  }

  if (!surnameFound) {
    return { ok: false, why: `slug "${slug}" does not contain the surname "${surname}" as a whole name part` };
  }

  const remainder = alpha.replace(surname, '');
  const others = tokens.filter((t) => t !== surname);
  // Prefix matching in either direction, because slugs abbreviate ("lintonjen"
  // for Vivienne Jennifer Linton) and names carry middle initials.
  const corroborating = others.find(
    (o) => remainder.includes(o) || o.startsWith(remainder) || remainder.startsWith(o),
  );

  // Initials count as corroboration: /in/dploftus is D.P. Loftus for
  // "LOFTUS, DOUGLAS, PAUL". Every character in the remainder must be the first
  // letter of one of the other name parts, so a random two-letter tail cannot
  // pass -- "dp" corroborates Douglas Paul, "sx" corroborates nothing.
  const initials = others.map((o) => o[0]);
  const remainderIsInitials =
    remainder.length > 0 && remainder.length <= 3 &&
    [...remainder].every((ch) => initials.includes(ch));

  if (!corroborating && !remainderIsInitials) {
    return {
      ok: false,
      why: `slug "${slug}" contains "${surname}" but nothing corroborating it; ` +
           `the remainder "${remainder}" matches no other part of "${personName}"`,
    };
  }

  return {
    ok: true,
    why: corroborating
      ? `slug encodes the surname "${surname}" corroborated by "${corroborating}"`
      : `slug encodes the surname "${surname}" corroborated by the initials "${remainder}"`,
  };
}

export const identityGate: Gate = {
  name: 'identity',
  band: 'A',
  async evaluate(claim: Claim, ctx: GateContext): Promise<GateResult> {
    if (claim.valueType !== 'profile_url') {
      return { gate: 'identity', outcome: 'skipped', band: 'A', detail: 'not a profile claim' };
    }
    // A firm can have several principals, so the profile must be checked against
    // ALL of them. Taking the first name found compared /in/-varunmalhotra
    // against a colleague called Elliott and quarantined 32 correct profiles --
    // the gate was strict, but about the wrong person.
    const people = ctx.siblings
      .filter((c) => c.field.endsWith('fullName') && typeof c.value === 'string')
      .map((c) => String(c.value));

    if (!people.length) {
      return { gate: 'identity', outcome: 'failed', band: 'A', detail: 'no named person to verify against' };
    }

    const url = String(claim.value);
    const checks = people.map((person) => ({ person, r: checkProfileSlug(url, person) }));
    const hit = checks.find((c) => c.r.ok);

    if (hit) {
      return {
        gate: 'identity',
        outcome: 'passed',
        band: 'A',
        detail: `${hit.r.why} — matches ${hit.person}`,
      };
    }

    return {
      gate: 'identity',
      outcome: 'failed',
      band: 'A',
      detail: `no named principal matches this profile; ${checks[0]!.r.why}`,
      counterfactual: {
        wouldHaveReleased: claim.value,
        asProfileForAnyOf: people.slice(0, 4),
      },
    };
  },
};
