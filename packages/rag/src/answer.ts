/**
 * Answer orchestration.
 *
 * The pipeline is: parse constraints -> retrieve under those constraints ->
 * generate discrete claims that cite chunk ids -> audit every claim -> decide
 * whether what survived is worth showing.
 *
 * The system declines rather than guesses in three situations, all of which are
 * ordinary rather than exceptional:
 *   - retrieval found nothing within the user's constraints
 *   - what it found is too far from the question to be about it
 *   - the claims the model wrote did not survive the audit
 *
 * A declined answer is a correct answer. The brief asks for a control that makes
 * the system qualify, limit, or decline when evidence is insufficient, and a
 * control that never fires is not a control.
 */
import { retrieve, getFirms, countMatching, firmsNamedIn, logQuery, type RetrievedChunk } from '@fo/db';
import type { RequestedField } from './query.js';
import { checkAttribution, type Claim, type CheckedClaim } from './attribution.js';
import { parseQuery, type ParsedQuery } from './query.js';
import { embed, generateJson, ServiceUnavailable } from './llm.js';

export interface FirmSummary {
  id: string;
  name: string;
  type: string;
  typeConfidence: number;
  location: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  principal: string | null;
  principalTitle: string | null;
  principalControl: string | null;
  otherPrincipals: Array<{ name: string; title: string }>;
  address: string | null;
  latestSignal: { summary: string; date: string } | null;
  /** How each shown value was confirmed, keyed by field. */
  basis: Record<string, string>;
}

export interface AnswerResult {
  question: string;
  parsed: ParsedQuery;
  answered: boolean;
  declineReason: string | null;
  /** True when the answer is missing because a provider failed, not because the evidence was thin. */
  serviceError: boolean;
  claims: CheckedClaim[];
  droppedClaims: CheckedClaim[];
  firms: FirmSummary[];
  /** Firms matching the structured filters, which may exceed those shown. */
  totalMatching: number;
  timings: { totalMs: number; retrievalMs: number; generationMs: number; auditMs: number };
}

/**
 * Cosine distance above this means the best match is not about the question.
 * Tuned on the adversarial query set - see docs/RAG_NOTES.md.
 */
const MAX_DISTANCE = 0.62;

/** What to tell the user when the file simply does not carry the field they asked for. */
const FIELD_ABSENT: Record<NonNullable<RequestedField>, string> = {
  email: 'No verified email address is held for the firms matching that question. Where an address could not be confirmed it is left blank rather than guessed.',
  phone: 'No verified phone number is held for the firms matching that question.',
  aum: 'Assets under management are not held for any firm in this dataset. No free statutory source publishes it, so the field is blank throughout rather than estimated.',
  sectors: 'Investment sectors are not held for any firm in this dataset. The field is blank throughout rather than inferred.',
  thesis: 'Investment thesis is not held for any firm in this dataset.',
  website: 'No confirmed website is held for the firms matching that question.',
  ranking: 'This dataset holds no size or performance measure, so firms cannot be ranked. Ranking them would require a number that does not exist in any record.',
};

/**
 * True when the firms the question is actually about carry the requested field.
 *
 * Scoping to the named firm matters. Asked for Francis Family Office's email, an
 * unscoped check asks "does any retrieved firm have an email" - and once a few
 * records did, the gate opened and the answer listed three other firms' emails.
 * Every claim was true and none of them answered the question.
 */
async function fieldIsHeld(
  field: NonNullable<RequestedField>,
  firmIds: string[],
  question: string,
): Promise<boolean> {
  if (field === 'ranking' || field === 'aum' || field === 'sectors' || field === 'thesis') return false;
  if (firmIds.length === 0) return false;

  // If the question names a firm we hold, that firm alone decides the answer -
  // whether or not similarity search happened to retrieve it.
  const named = await firmsNamedIn(question).catch(() => []);
  const scope = named.length > 0 ? named : await getFirms(firmIds);

  return scope.some((row) => {
    const r = row.record;
    const p = r.principals?.[0];
    if (field === 'email') return Boolean(p?.email?.value);
    if (field === 'phone') return Boolean(p?.phone?.value);
    if (field === 'website') return Boolean(r.website?.value);
    return false;
  });
}

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          cited_chunk_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['text', 'cited_chunk_ids'],
      },
    },
  },
  required: ['claims'],
};

/**
 * Sources sent to the answering model. Deliberately fewer and shorter than what
 * retrieval returns: a 14-chunk prompt costs about 3,900 tokens, which exceeds
 * the smaller model's 6,000-per-minute budget once the schema and question are
 * added, so every fallback failed too and the user saw "not enough records" when
 * the truth was "prompt too large".
 */
const MAX_SOURCES_IN_PROMPT = 14;
/**
 * Trimmed from 320. Showing more firms per answer meant more sources per prompt,
 * which pushed the fallback model back toward its per-minute ceiling - and a
 * model at its ceiling returns an empty claims array rather than an error, which
 * surfaces to the user as "not enough records" when the records were fine.
 * Fourteen shorter sources cost less than eight long ones.
 */
const MAX_SOURCE_CHARS = 210;

function answerPrompt(question: string, chunks: RetrievedChunk[]): string {
  const sources = chunks
    .slice(0, MAX_SOURCES_IN_PROMPT)
    .map((c) => `[${c.id}] ${c.legal_name} (${c.firm_type})\n    ${c.content.slice(0, MAX_SOURCE_CHARS)}`)
    .join('\n');

  return `Answer a question from an investor relations professional using ONLY the sources below.

QUESTION: ${question}

SOURCES:
${sources}

Write your answer as a list of separate factual claims. For each claim, cite the ids of the sources it rests on.

Rules:
- Every claim must be supported by the sources you cite for it. An unsupported claim will be removed before the user sees it, so writing one only makes your answer shorter.
- One fact per claim. Do not combine several facts into one sentence.
- Never state a number, date, or name that does not appear in your cited sources.
- Do not rank, compare, or infer causes unless a source states it.
- Do not describe the database, your process, or what you were asked. Only state facts about the firms.
- If the sources do not answer the question, return an empty claims array. That is a correct response.

Write for someone deciding whom to contact. Plain sentences, no marketing language.`;
}

export async function answerQuestion(question: string): Promise<AnswerResult> {
  const t0 = Date.now();
  const parsed = await parseQuery(question);

  const filters = {
    firmType: parsed.firmType ?? undefined,
    country: parsed.country ?? undefined,
    requireContact: parsed.requireContact,
    sinceDate: parsed.sinceDate ?? undefined,
  };

  const tRetrieve = Date.now();
  const [vector, totalMatching] = await Promise.all([
    embed(parsed.semanticQuery),
    countMatching(filters).catch(() => 0),
  ]);
  const chunks = await retrieve(
    vector,
    {
      ...filters,
      // Whether a firm is reachable is a property of its profile, not of its
      // filing history. Asked "who can I phone", unrestricted retrieval fills the
      // context with signal chunks about quarterly holdings, and the model then
      // correctly concludes the sources do not answer the question.
      kinds: parsed.requireContact ? ['profile'] : undefined,
    },
    30,
  );
  const retrievalMs = Date.now() - tRetrieve;

  const decline = async (reason: string, serviceError = false): Promise<AnswerResult> => {
    const result: AnswerResult = {
      question,
      parsed,
      answered: false,
      declineReason: reason,
      serviceError,
      claims: [],
      droppedClaims: [],
      firms: [],
      totalMatching,
      timings: { totalMs: Date.now() - t0, retrievalMs, generationMs: 0, auditMs: 0 },
    };
    await logQuery({
      question,
      retrievedIds: chunks.map((c) => c.firm_id),
      claimsMade: 0,
      claimsDropped: 0,
      declined: true,
      declineReason: reason,
      latencyMs: result.timings.totalMs,
    }).catch(() => {});
    return result;
  };

  if (chunks.length === 0) {
    return decline(
      parsed.appliedFilters.length
        ? `No firms in the dataset match those criteria (${parsed.appliedFilters.join(', ')}).`
        : 'No firms in the dataset relate to that question.',
    );
  }

  const nearest = Math.min(...chunks.map((c) => Number(c.distance)));
  if (nearest > MAX_DISTANCE) {
    return decline('Nothing in the dataset is close enough to that question to answer it reliably.');
  }

  const usable = chunks.filter((c) => Number(c.distance) <= MAX_DISTANCE + 0.12);

  // If the question asks for a specific field, check we actually hold it before
  // generating. Without this the model answers a question about sectors with
  // true statements about location - every claim supported, none responsive - and
  // the attribution audit passes them all, because grounding is not relevance.
  if (parsed.requestedField) {
    const held = await fieldIsHeld(parsed.requestedField, [...new Set(usable.map((c) => c.firm_id))], question);
    if (!held) {
      return decline(FIELD_ABSENT[parsed.requestedField]);
    }
  }

  const tGen = Date.now();
  let drafted: { claims: Array<{ text: string; cited_chunk_ids: string[] }> };
  try {
    drafted = await generateJson(answerPrompt(question, usable), ANSWER_SCHEMA);
  } catch (err) {
    console.error('answer generation failed:', err instanceof Error ? err.message : err);
    const unavailable = err instanceof ServiceUnavailable;
    return decline(
      unavailable
        ? 'The answering service is busy right now. This is not a statement about the records - please try again in a moment.'
        : 'Something went wrong composing the answer. The underlying records are unaffected.',
      true,
    );
  }
  const generationMs = Date.now() - tGen;

  const claims: Claim[] = (drafted.claims ?? []).map((c) => ({
    text: c.text,
    citedChunkIds: c.cited_chunk_ids ?? [],
  }));

  if (claims.length === 0) {
    console.error(
      `no claims drafted: ${usable.length} usable chunks, nearest distance ${nearest.toFixed(3)}, question "${question}"`,
    );
    return decline('The records retrieved do not contain enough to answer that question.');
  }

  const tAudit = Date.now();
  const { kept, dropped } = await checkAttribution(
    claims,
    usable.map((c) => ({ id: c.id, content: c.content, firmName: c.legal_name })),
  );
  const auditMs = Date.now() - tAudit;

  if (kept.length === 0) {
    const result = await decline(
      'An answer was drafted but none of it held up against the underlying records, so it was withheld.',
    );
    return { ...result, droppedClaims: dropped, timings: { ...result.timings, generationMs, auditMs } };
  }

  // Only firms actually cited by a surviving claim are shown. Retrieval reaching a
  // firm is not a reason to present it.
  const citedChunkIds = new Set(kept.flatMap((c) => c.citedChunkIds));
  const citedFirmIds = [...new Set(usable.filter((c) => citedChunkIds.has(c.id)).map((c) => c.firm_id))];
  const rows = await getFirms(citedFirmIds);

  const firms: FirmSummary[] = rows.map((row) => {
    const r = row.record;
    const p = r.principals?.[0];
    const s = r.signals?.[0];
    const basis: Record<string, string> = {};
    const note = (label: string, cell?: { evidence?: Array<{ method: string; sourceUrl: string; vendor?: string }> }) => {
      const e = cell?.evidence?.[0];
      if (e) basis[label] = `${e.method}${e.vendor ? ` [via ${e.vendor}]` : ''}`;
    };
    note('type', { evidence: r.classification?.evidence });
    note('phone', p?.phone);
    note('email', p?.email);
    note('website', r.website);
    note('address', r.street);
    if (s) basis.signal = s.evidence.method;

    return {
      id: row.id,
      name: row.legal_name,
      type: row.firm_type,
      typeConfidence: row.type_confidence,
      location: [r.city?.value, r.region?.value, r.country?.value].filter(Boolean).join(', '),
      phone: p?.phone?.value ?? null,
      email: p?.email?.value ?? null,
      website: r.website?.value ?? null,
      principal: p?.fullName?.value ?? null,
      principalTitle: p?.title?.value ?? null,
      principalControl: p?.controlBasis?.value ?? null,
      otherPrincipals: (r.principals ?? []).slice(1, 4).map((x) => ({
        name: x.fullName?.value ?? '',
        title: x.title?.value ?? '',
      })).filter((x) => x.name),
      // Only show an address when there is a street to write to. A lone country
      // is a location, not somewhere a letter can be sent.
      address: r.street?.value
        ? [r.street.value, r.city?.value, r.postcode?.value, r.country?.value].filter(Boolean).join(', ')
        : null,
      latestSignal: s ? { summary: s.summary, date: s.occurredAt } : null,
      basis,
    };
  });

  const totalMs = Date.now() - t0;
  await logQuery({
    question,
    retrievedIds: citedFirmIds,
    claimsMade: claims.length,
    claimsDropped: dropped.length,
    declined: false,
    latencyMs: totalMs,
  }).catch(() => {});

  return {
    question,
    parsed,
    answered: true,
    declineReason: null,
    serviceError: false,
    claims: kept,
    droppedClaims: dropped,
    firms,
    totalMatching,
    timings: { totalMs, retrievalMs, generationMs, auditMs },
  };
}
