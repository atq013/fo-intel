/**
 * The grounding control.
 *
 * The brief is explicit that prompt instructions are not enough - telling a model
 * to use only the provided data does not prove it will. So the answer is never
 * generated as prose. The model must emit discrete claims, each citing the chunk
 * ids it rests on, and every claim is then checked here before anything reaches
 * the user.
 *
 * Two checks, in order of cost:
 *
 *   1. Lexical. The claim's content words must actually occur in the chunks it
 *      cites. Cheap, deterministic, and catches the common failure where a model
 *      cites a real chunk for a fact that chunk does not contain.
 *
 *   2. Entailment, on a different provider from the one that wrote the claim.
 *      A model asked to check its own output shares its own blind spots.
 *
 * A claim that fails is dropped, not flagged. Rendering an unsupported claim with
 * a warning still puts it in front of the user.
 */
import { verifyJson } from './llm.js';

export interface Claim {
  text: string;
  citedChunkIds: string[];
}

export interface SourceChunk {
  id: string;
  content: string;
  firmName: string;
}

export interface CheckedClaim extends Claim {
  supported: boolean;
  reason: string;
}

export interface AttributionResult {
  kept: CheckedClaim[];
  dropped: CheckedClaim[];
}

const STOP = new Set([
  'the','a','an','and','or','of','in','on','at','to','for','with','is','are','was','were','be','been','has','have',
  'had','it','its','this','that','these','those','their','they','which','as','by','from','also','more','than','who',
]);

function contentWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s.]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * Numbers, dates and proper nouns are where fabrication actually shows up, so
 * they are required to appear verbatim rather than merely being similar.
 */
function hardTokens(s: string): string[] {
  return (s.match(/\b\d[\d,./-]*\b|\b[A-Z][a-zA-Z&.'-]{2,}\b/g) ?? []).map((t) => t.toLowerCase().replace(/[.,]$/, ''));
}

function lexicalSupport(claim: string, corpus: string): { ok: boolean; missing: string[] } {
  const hay = corpus.toLowerCase();

  const missingHard = hardTokens(claim).filter((t) => !hay.includes(t));
  if (missingHard.length > 0) return { ok: false, missing: missingHard.slice(0, 4) };

  const words = contentWords(claim);
  if (words.length === 0) return { ok: false, missing: ['claim has no content words'] };
  const present = words.filter((w) => hay.includes(w)).length;
  const coverage = present / words.length;

  return coverage >= 0.6 ? { ok: true, missing: [] } : { ok: false, missing: [`only ${Math.round(coverage * 100)}% of terms appear in the cited sources`] };
}

interface EntailmentResponse {
  results: Array<{ index: number; supported: boolean; reason: string }>;
}

async function entailmentCheck(claims: Claim[], corpusFor: (c: Claim) => string): Promise<Map<number, { supported: boolean; reason: string }>> {
  const out = new Map<number, { supported: boolean; reason: string }>();
  if (claims.length === 0) return out;

  const body = claims
    .map((c, i) => `[${i}] CLAIM: ${c.text}\n    SOURCES: ${corpusFor(c).slice(0, 1200)}`)
    .join('\n\n');

  try {
    const res = await verifyJson<EntailmentResponse>(
      `You are auditing claims against the source text each one cites. You did not write these claims.

For each numbered claim decide whether the cited sources FULLY support it.

Mark supported=false if the claim:
- states anything the sources do not say, however plausible
- is more specific than the sources (an exact figure where sources give a range)
- asserts a relationship, cause, or ranking the sources do not state
- generalises from one source to a broader population

Mark supported=true only if every part of the claim is directly stated in its sources.

${body}

Return JSON only, in this shape, covering every claim:
{"results":[{"index":0,"supported":true,"reason":"..."}]}`,
    );
    for (const r of res.results ?? []) {
      out.set(r.index, { supported: Boolean(r.supported), reason: r.reason ?? '' });
    }
  } catch (err) {
    // Fail closed: a claim the auditor never saw is not a verified claim.
    const why = err instanceof Error ? err.message.slice(0, 90) : 'unknown error';
    for (let i = 0; i < claims.length; i++) {
      out.set(i, { supported: false, reason: `independent verification unavailable (${why})` });
    }
  }
  return out;
}

export async function checkAttribution(claims: Claim[], chunks: SourceChunk[]): Promise<AttributionResult> {
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const corpusFor = (c: Claim) =>
    c.citedChunkIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((s) => `${s!.firmName}: ${s!.content}`)
      .join('\n');

  const kept: CheckedClaim[] = [];
  const dropped: CheckedClaim[] = [];
  const needEntailment: Claim[] = [];
  const lexicalPassIndex: number[] = [];

  claims.forEach((claim) => {
    if (claim.citedChunkIds.length === 0) {
      dropped.push({ ...claim, supported: false, reason: 'claim cites no source' });
      return;
    }
    const corpus = corpusFor(claim);
    if (!corpus) {
      dropped.push({ ...claim, supported: false, reason: 'cited sources were not among those retrieved' });
      return;
    }
    const lex = lexicalSupport(claim.text, corpus);
    if (!lex.ok) {
      dropped.push({ ...claim, supported: false, reason: `not found in cited sources: ${lex.missing.join(', ')}` });
      return;
    }
    lexicalPassIndex.push(needEntailment.length);
    needEntailment.push(claim);
  });

  const entail = await entailmentCheck(needEntailment, corpusFor);

  needEntailment.forEach((claim, i) => {
    const verdict = entail.get(i) ?? { supported: false, reason: 'not audited' };
    if (verdict.supported) kept.push({ ...claim, supported: true, reason: 'verified against cited sources' });
    else dropped.push({ ...claim, supported: false, reason: verdict.reason || 'not entailed by cited sources' });
  });

  return { kept, dropped };
}
