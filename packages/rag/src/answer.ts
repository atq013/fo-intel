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
import { retrieve, getFirms, logQuery, type RetrievedChunk } from '@fo/db';
import { checkAttribution, type Claim, type CheckedClaim } from './attribution.js';
import { parseQuery, type ParsedQuery } from './query.js';
import { embed, generateJson } from './llm.js';

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
  latestSignal: { summary: string; date: string } | null;
  /** How each shown value was confirmed, keyed by field. */
  basis: Record<string, string>;
}

export interface AnswerResult {
  question: string;
  parsed: ParsedQuery;
  answered: boolean;
  declineReason: string | null;
  claims: CheckedClaim[];
  droppedClaims: CheckedClaim[];
  firms: FirmSummary[];
  timings: { totalMs: number; retrievalMs: number; generationMs: number; auditMs: number };
}

/**
 * Cosine distance above this means the best match is not about the question.
 * Tuned on the adversarial query set - see docs/RAG_NOTES.md.
 */
const MAX_DISTANCE = 0.62;

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

function answerPrompt(question: string, chunks: RetrievedChunk[]): string {
  const sources = chunks
    .map((c) => `[${c.id}] ${c.legal_name} (${c.firm_type}) — ${c.field_path}\n    ${c.content}`)
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

  const tRetrieve = Date.now();
  const vector = await embed(parsed.semanticQuery);
  const chunks = await retrieve(
    vector,
    {
      firmType: parsed.firmType ?? undefined,
      country: parsed.country ?? undefined,
      requireContact: parsed.requireContact,
      sinceDate: parsed.sinceDate ?? undefined,
    },
    14,
  );
  const retrievalMs = Date.now() - tRetrieve;

  const decline = async (reason: string): Promise<AnswerResult> => {
    const result: AnswerResult = {
      question,
      parsed,
      answered: false,
      declineReason: reason,
      claims: [],
      droppedClaims: [],
      firms: [],
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

  const tGen = Date.now();
  let drafted: { claims: Array<{ text: string; cited_chunk_ids: string[] }> };
  try {
    drafted = await generateJson(answerPrompt(question, usable), ANSWER_SCHEMA);
  } catch {
    return decline('The answering service is temporarily unavailable. The underlying records are unaffected.');
  }
  const generationMs = Date.now() - tGen;

  const claims: Claim[] = (drafted.claims ?? []).map((c) => ({
    text: c.text,
    citedChunkIds: c.cited_chunk_ids ?? [],
  }));

  if (claims.length === 0) {
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
    claims: kept,
    droppedClaims: dropped,
    firms,
    timings: { totalMs, retrievalMs, generationMs, auditMs },
  };
}
