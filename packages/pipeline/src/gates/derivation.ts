/**
 * Derivation rules — the registry behind the third evidence kind.
 *
 * Gate 2 knows two kinds of evidence: quoting ("the value is written here") and
 * pointer ("the value is in the record this names"). Neither fits a value that
 * is *computed* from what the source says. A filing gives `MN`; the record needs
 * `United States`. That string appears nowhere in the document, so quoting
 * evidence fails it, and Phase 1 duly quarantined it.
 *
 * Quarantining was the correct behaviour for the rules as written and the wrong
 * outcome for the data. The fix is not to exempt derived values from checking --
 * that would reintroduce exactly the "unchecked value looks checked" failure the
 * contract exists to prevent. It is to make the derivation itself checkable:
 *
 *   the span holds the INPUT, `method` names a rule in this registry, and the
 *   gate passes only if the input is present in the span AND re-running the rule
 *   reproduces the value.
 *
 * So a derived value is re-derived at validation time, by a different code path
 * than the one that produced it. A rule that is not registered cannot be cited,
 * and a value that the rule does not reproduce fails.
 *
 * Rules must be pure, total and deterministic. No network, no model, no clock.
 */

export const DERIVED_PREFIX = 'derived:';

export type DerivationRule = {
  id: string;
  /** what the rule reads, for the human-readable method sentence */
  describes: string;
  apply: (input: string) => string | null;
};

const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

/**
 * The same table the rules use, exported so producers can ask "does this rule
 * apply?" before making a claim. Two separate lists would drift.
 */
export const US_STATE_CODES = new Set(Object.keys(US_STATES));

/** UK home nations are countries in the register's sense and one country in ISO's. */
const UK_NATIONS = new Set(['england', 'wales', 'scotland', 'northern ireland', 'great britain', 'united kingdom', 'gb', 'uk']);

/**
 * Words that carry no family identity, so a match on one proves nothing.
 *
 * Without this, "FAMILY" in a person's name field or a shared token like
 * "HOLDINGS" would classify half the register as a single family office.
 */
const NOT_A_FAMILY_NAME = new Set([
  'family', 'office', 'offices', 'holdings', 'holding', 'investment', 'investments',
  'capital', 'partners', 'group', 'limited', 'ltd', 'llp', 'plc', 'company', 'trust',
  'trustees', 'management', 'ventures', 'properties', 'property', 'estates', 'assets',
  'wealth', 'advisors', 'advisers', 'services', 'international', 'the', 'and',
  'mr', 'mrs', 'ms', 'miss', 'dr', 'sir', 'lord', 'lady', 'prof',
]);

/** The surname, matching gates/identity's reading of `SURNAME, FIRST, MIDDLE`. */
function surnameFrom(personName: string): string {
  const clean = personName.trim();
  const head = clean.includes(',') ? clean.split(',')[0]! : clean;
  const tokens = head.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((t) => t.length > 1);
  return tokens[tokens.length - 1] ?? '';
}

const RULES: DerivationRule[] = [
  {
    /**
     * SFO-1 from the inclusion rubric, as a re-runnable rule.
     *
     * A statutory control register naming an individual whose surname is also in
     * the company name is the strongest evidence in the build: it is a legal
     * filing about who controls the entity, not a firm describing itself.
     *
     * Both inputs come from the same filing and the span cites both fields, so
     * the gate re-derives this from the register rather than trusting the
     * extractor. A classification that cannot be reproduced does not release.
     *
     * It says single-family OFFICE and not merely family-controlled, which is a
     * real inferential step: the register proves control, and the name claiming
     * "family office" is the firm's own description. Both are required here.
     * Control alone was Stage 1's SFO-1 error -- twenty records qualified on
     * family control that were not family offices.
     */
    id: 'family_surname_control',
    describes: 'a PSC individual and the company name, from the same filing',
    apply: (input) => {
      const [person, company] = input.split('||').map((x) => x.trim());
      if (!person || !company) return null;

      const surname = surnameFrom(person);
      if (!surname || surname.length < 3 || NOT_A_FAMILY_NAME.has(surname)) return null;

      // Whole-token match. A substring test made "curti" match "curtis" once
      // already; the same mistake here would invent family control.
      const companyTokens = company.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/);
      if (!companyTokens.includes(surname)) return null;

      // The firm must also describe itself as a family office. Control without
      // that is a family-owned company, which is a different thing.
      const text = company.toLowerCase();
      if (/\bfamily\s+(office|investment|holdings?)\b/.test(text)) return 'single_family_office';
      return null;
    },
  },
  {
    id: 'us_state_to_country',
    describes: 'a two-letter US state code',
    apply: (input) => (US_STATES[input.trim().toUpperCase()] ? 'United States' : null),
  },
  {
    id: 'us_state_code_to_name',
    describes: 'a two-letter US state code',
    apply: (input) => US_STATES[input.trim().toUpperCase()] ?? null,
  },
  {
    id: 'uk_nation_to_country',
    describes: 'a UK home nation',
    apply: (input) => (UK_NATIONS.has(input.trim().toLowerCase()) ? 'United Kingdom' : null),
  },
];

const REGISTRY = new Map(RULES.map((r) => [r.id, r]));

export function getRule(id: string): DerivationRule | undefined {
  return REGISTRY.get(id);
}

/** `method` looks like `derived:us_state_to_country from "MN"` */
export function parseDerivedMethod(method: string): { ruleId: string; input: string } | null {
  if (!method.startsWith(DERIVED_PREFIX)) return null;
  const rest = method.slice(DERIVED_PREFIX.length);
  const m = /^([a-z0-9_]+)\s+from\s+"(.+)"$/i.exec(rest.trim());
  if (!m) return null;
  return { ruleId: m[1]!, input: m[2]! };
}

export function derivedMethod(ruleId: string, input: string): string {
  return `${DERIVED_PREFIX}${ruleId} from "${input}"`;
}

/**
 * Re-derive and compare. This is the whole check.
 */
export function checkDerivation(
  value: unknown,
  spanText: string,
  method: string,
): { outcome: 'passed' | 'failed'; detail: string; counterfactual?: unknown } | null {
  const parsed = parseDerivedMethod(method);
  if (!parsed) return null;

  const rule = getRule(parsed.ruleId);
  if (!rule) {
    // An unregistered rule is an unauditable one. Refusing it is the point:
    // otherwise `method` becomes free text that can claim anything.
    return {
      outcome: 'failed',
      detail: `derivation rule "${parsed.ruleId}" is not registered`,
      counterfactual: { wouldHaveReleased: value, citingUnknownRule: parsed.ruleId },
    };
  }

  // The input must actually appear in the source we read. Without this the rule
  // could be fed a value invented at extraction time.
  const inputPresent = new RegExp(`(^|[^A-Za-z0-9])${parsed.input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`, 'i')
    .test(spanText);
  if (!inputPresent) {
    return {
      outcome: 'failed',
      detail: `derivation input "${parsed.input}" does not appear in the span`,
      counterfactual: { wouldHaveReleased: value, derivedFromAbsentInput: parsed.input },
    };
  }

  const recomputed = rule.apply(parsed.input);
  if (recomputed === null) {
    return {
      outcome: 'failed',
      detail: `rule ${rule.id} does not apply to "${parsed.input}"`,
      counterfactual: { wouldHaveReleased: value, ruleReturned: null },
    };
  }
  if (String(value).trim().toLowerCase() !== recomputed.trim().toLowerCase()) {
    return {
      outcome: 'failed',
      detail: `rule ${rule.id} on "${parsed.input}" yields "${recomputed}", not "${String(value)}"`,
      counterfactual: { wouldHaveReleased: value, ruleActuallyYields: recomputed },
    };
  }

  return {
    outcome: 'passed',
    detail: `re-derived "${recomputed}" from ${rule.describes} "${parsed.input}" present in the span`,
  };
}
