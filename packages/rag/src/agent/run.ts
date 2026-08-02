import { generateJson } from '../llm.js';
import { TOOLS, TOOL_SCHEMAS, type ToolResult } from './tools.js';
import { resolveNames } from './names.js';
import { newMetrics, recordMetrics, resolveCounts, tokenRoster } from './counts.js';
import { meterSnapshot, resetMeter } from '@fo/core';
import { auditClaims, confidenceBlockMessage, type EvidenceCheck } from './claims-guard.js';

/**
 * The bounded agent (spec §8).
 *
 * The agent decides *how* to answer: which tools, in what order, when it has
 * enough, how to structure the result. It does not decide *what is true* — every
 * fact in the answer comes from a tool reading released claims.
 *
 * ### The rule that is enforced in control flow, not in the prompt
 *
 * Stage 1's live failure was answering a narrower question than the one asked
 * without saying so: asked for principal-owned contact routes excluding shared
 * inboxes, it returned "firms with any populated contact field" and never
 * mentioned the substitution. A prompt instruction would not have prevented
 * that, because the model was not aware it had substituted.
 *
 * So the planner must declare, up front, which of the user's constraints it can
 * honour and which it cannot. If it records an unhonoured constraint and the
 * composed answer does not visibly surface it, **the answer is blocked** and
 * replaced by one that states the limitation. That check is code, below, and it
 * runs after composition. A model cannot talk its way past it.
 */

export interface AgentTrace {
  step: number;
  kind: 'plan' | 'tool' | 'compose' | 'block';
  detail: unknown;
  at: string;
}

export interface AgentAnswer {
  answer: string;
  /** constraints the planner said it could not honour */
  unhonouredConstraints: string[];
  /** true when the composer was blocked and rewritten */
  blocked: boolean;
  blockReason?: string;
  toolsUsed: string[];
  scope: Record<string, unknown>[];
  trace: AgentTrace[];
  /** firm names rewritten to their stored spelling */
  nameCorrections: Array<{ wrote: string; stored: string }>;
  /** every number in the answer, and the tool metric it came from */
  countsResolved: Array<{ token: string; value: number }>;
  /** relevance scores the draft presented as confidence, if any */
  relevanceAsConfidence: Array<{ value: number; context: string }>;
  /** tool internals the draft leaked into prose, if any */
  toolInternalsLeaked: string[];
  /** absence-of-withholding claims with no completed check behind them */
  unsupportedAbsence: string[];
  /** skipped gates presented as checks that cleared the record */
  skippedAsChecked: string[];
  /** the composer's own instructions quoted back to the reader */
  promptLeak: string[];
  /** a refusal asserted where nothing was actually refused */
  unsupportedRefusal: string[];
  /** measured spend and wall time for this answer -- see @fo/core/meter */
  cost: Record<string, unknown>;
}

interface Plan {
  constraints: Array<{ constraint: string; honourable: boolean; why: string }>;
  calls: Array<{ tool: string; input: Record<string, unknown>; because: string }>;
}

const MAX_CALLS = 4;

/** Tools whose input names one entity, so they cannot run before a search. */
const ID_TOOLS = new Set(['get_firm', 'check_evidence']);

/**
 * Pull entityId -> stored legalName out of whatever a tool returned.
 *
 * This map is the ONLY source of firm names in the final answer. If a name is
 * not in here it did not come from the data.
 */
function harvest(data: unknown, into: Map<string, string>): void {
  const add = (id: unknown, name: unknown) => {
    if (typeof id === 'string' && typeof name === 'string' && id && name) into.set(id, name);
  };
  if (Array.isArray(data)) {
    for (const row of data) {
      if (row && typeof row === 'object') add((row as any).entityId, (row as any).name);
    }
  } else if (data && typeof data === 'object') {
    const d = data as any;
    if (d.entity?.canonical_name) {
      // get_firm returns the entity without echoing its id; the caller knows it.
      add(d.entityId ?? d.entity?.id, d.entity.canonical_name);
    }
  }
}

const PLAN_PROMPT = (question: string) => `You are planning how to answer a question about a family-office dataset.

You may ONLY use these tools. They read released, gate-passed claims:
${TOOL_SCHEMAS.map((t) => `- ${t.name}: ${t.description}\n  input: ${JSON.stringify(t.input_schema.properties)}`).join('\n')}

Question: "${question}"

First, break the question into its explicit constraints. For EACH, say whether the
tools can honour it exactly.

Mark honourable=false when the dataset cannot express the constraint. Examples of
constraints that are NOT honourable: filtering by assets under management, by
investment sector or mandate, by number of employees, by founding family surname,
by anything requiring semantic similarity rather than a name substring.

Being honest that a constraint cannot be honoured is CORRECT and expected. Do not
claim you can honour something to look capable.

Then list up to ${MAX_CALLS} tool calls.

Return JSON:
{"constraints":[{"constraint":"...","honourable":true,"why":"..."}],
 "calls":[{"tool":"search_firms","input":{...},"because":"..."}]}`;

const COMPOSE_PROMPT = (question: string, results: string, unhonoured: string[], roster: string, counts: string) => `Answer the question using ONLY the tool results below.

Question: "${question}"

Tool results:
${results}

${unhonoured.length ? `You could NOT honour these constraints:
${unhonoured.map((c) => `- ${c}`).join('\n')}

You MUST state this plainly in your answer, in the first two sentences, in plain
words. Say which part of the question you could not do and what you did instead.
An answer that quietly ignores these is worse than no answer.` : 'All constraints were honourable.'}

Rules:
- NEVER write a firm's name. Refer to each firm by its exact token from this
  roster, copied character for character:
${roster || '  (no firms were returned)'}
  The server substitutes the stored legal name. Do not invent a token, do not
  write the words "entityId", and do not type a firm name yourself — you will get
  its spelling wrong, and a misspelled firm name is a fabricated value.
- Never upgrade a label: a company inbox is not a principal's email; "not found" is not "does not exist".
- State the scope: how many were searched, how many MATCHED. Use the "matched"
  number from the tool scope, never the length of the returned data array - the
  array is a truncated page, and reporting its length understates the answer.
- NEVER type a number for how many firms matched, were searched, were excluded,
  are reachable, or how many claims or evidence rows exist. Use these tokens,
  copied exactly:
${counts || '  (no counts available)'}
  The server substitutes the figure the tool actually returned. A number you type
  yourself is a guess, and a wrong count is a fabricated fact.
- Numbers that are NOT dataset counts — phone numbers, postcodes, dates, values
  quoted inside evidence — you may write normally.
- relevanceScore is a RANKING WEIGHT over the filters applied. NEVER call it
  confidence, probability, certainty, likelihood or evidence strength, and never
  convert it to a percentage and present it as one.
- If asked how confident you are, confidence comes from whether the fields THAT
  QUESTION needs are present. If the evidence for the specific question is absent
  — no mandate, sector, allocation, cheque size or LP data — say confidence is
  low, or that fit cannot be confidently determined, and say which evidence is
  missing. Do not invent a percentage.
- You may offer a narrowed proxy shortlist ONLY after stating plainly what was
  unavailable and which narrower criteria you actually used instead.
- Write for a non-technical buyer. Never expose tool internals: no "rows",
  "dataLength", "entityId", "null", "0 data" or similar.
- If a firm is missing a field, say it is missing. Do not estimate it.
- Be concise and specific. No preamble.

Return JSON: {"answer":"..."}`;

export async function runAgent(question: string): Promise<AgentAnswer> {
  // Per-answer, so a goal trace carries what that goal actually cost rather than
  // a share of some daily total. Reset first: the process is long-lived on
  // Vercel and would otherwise accumulate across unrelated questions.
  resetMeter();
  const startedAt = Date.now();
  const trace: AgentTrace[] = [];
  const now = () => new Date().toISOString();
  const push = (kind: AgentTrace['kind'], detail: unknown) =>
    trace.push({ step: trace.length + 1, kind, detail, at: now() });
  const cost = () => ({ ...meterSnapshot(), wallMs: Date.now() - startedAt });

  // ---- plan --------------------------------------------------------------
  const plan = await generateJson<Plan>(PLAN_PROMPT(question), {
    type: 'object',
    properties: {
      constraints: { type: 'array', items: { type: 'object' } },
      calls: { type: 'array', items: { type: 'object' } },
    },
  });
  push('plan', plan);

  const unhonoured = (plan.constraints ?? [])
    .filter((c) => !c.honourable)
    .map((c) => `${c.constraint} — ${c.why}`);

  // ---- act, in two phases ------------------------------------------------
  //
  // The planner runs once, before any tool has executed, so it cannot know an
  // entityId that only exists after a search. In production it filled the gap
  // with the literal string "<firm_id>" and both ID-dependent calls returned
  // nothing. A tool call with a placeholder argument is not a call, it is a
  // wasted round trip that can be misread as "this firm has no data".
  //
  // So discovery tools run first, real ids are harvested from what they return,
  // and ID-dependent tools run only afterwards and only with an id that exists.
  const toolsUsed: string[] = [];
  const scope: Record<string, unknown>[] = [];
  const collected: string[] = [];
  const canonical = new Map<string, string>();
  const metrics = newMetrics();
  const relevanceScores: number[] = [];
  // What check_evidence actually managed to check. A call that returned a
  // validation error checked nothing, and the difference decides whether the
  // answer may say anything about what was withheld.
  const evidenceChecks: Array<EvidenceCheck & { collectedAt?: number }> = [];
  // Only get_firm knows what was quarantined or held for an entity, and that
  // is what decides whether a refusal claim is supportable.
  const withheldByEntity = new Map<string, number>();
  let callIndex = 0;

  const runTool = async (tool: string, input: Record<string, unknown>) => {
    const fn = TOOLS[tool];
    if (!fn) { push('tool', { tool, error: 'no such tool' }); return; }
    try {
      const r: ToolResult<unknown> = await fn(input);
      toolsUsed.push(tool);
      scope.push({ tool, ...r.scope });
      push('tool', { tool, input, scope: r.scope, excluded: r.excluded, rows: Array.isArray(r.data) ? r.data.length : 1 });
      harvest(r.data, canonical);
      if (tool === 'check_evidence') {
        evidenceChecks.push({
          entityId: String(input.entityId ?? ''),
          field: input.field === undefined ? undefined : String(input.field),
          completed: (r.scope as Record<string, unknown>).validationError !== true,
          // Where this call's text lands in `collected`, so a superseded failure
          // can be withdrawn from what the composer reads.
          collectedAt: collected.length,
        });
      }
      recordMetrics(metrics, tool, ++callIndex, r.scope, r.excluded, r.data);
      if (Array.isArray(r.data)) {
        for (const row of r.data as Array<Record<string, unknown>>) {
          if (typeof row?.relevanceScore === 'number') relevanceScores.push(row.relevanceScore);
        }
      }
      collected.push(
        `TOOL ${tool}(${JSON.stringify(input)})\n` +
        `scope: ${JSON.stringify(r.scope)}\n` +
        `excluded: ${JSON.stringify(r.excluded)}\n` +
        `limits: ${r.limits.join(' | ')}\n` +
        `data: ${JSON.stringify(r.data).slice(0, 4000)}`,
      );
    } catch (err) {
      push('tool', { tool, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const calls = (plan.calls ?? []).slice(0, MAX_CALLS);
  const discovery = calls.filter((c) => !ID_TOOLS.has(c.tool));
  const needsId = calls.filter((c) => ID_TOOLS.has(c.tool));

  for (const call of discovery) await runTool(call.tool, (call.input ?? {}) as Record<string, unknown>);

  // The sequence has to be guaranteed, not merely policed. A plan can consist
  // entirely of ID-dependent calls with a firm NAME where an id belongs, in
  // which case refusing them all leaves nothing to answer from. Seeding the
  // search the planner omitted turns a dead run into a correct one, and the
  // seeded call is recorded in the trace like any other.
  if (!discovery.length && needsId.length) {
    const hint = needsId
      .map((c) => String((c.input as Record<string, unknown> | undefined)?.entityId ?? ''))
      .find((v) => v && !v.startsWith('ent_') && !v.startsWith('<'));
    if (hint) {
      push('plan', { seeded: 'search_firms', reason: 'plan had no discovery call; ID-dependent tools cannot run without one', q: hint });
      await runTool('search_firms', { q: hint, limit: 5 });
    }
  }

  for (const call of needsId) {
    const asked = String((call.input as Record<string, unknown> | undefined)?.entityId ?? '');
    // Accept only an id the tools actually returned. Otherwise fall back to the
    // top discovery result, and if there is none, skip and say so in the trace.
    const entityId = canonical.has(asked) ? asked : [...canonical.keys()][0];
    if (!entityId) {
      push('tool', { tool: call.tool, skipped: 'no real entity id available; refused to call with a placeholder', asked });
      continue;
    }
    if (entityId !== asked) {
      push('tool', { tool: call.tool, rebound: { from: asked || '(none)', to: entityId }, why: 'planner supplied a placeholder or unknown id' });
    }
    await runTool(call.tool, { ...(call.input as Record<string, unknown>), entityId });
  }

  // A check_evidence call that failed validation left a hole where a real check
  // should be, and every remaining defence only *stops* the composer answering
  // past it. Repairing the call is what lets the question actually be answered:
  // the field was invented, so the call is re-run without one, which is the
  // supported way to ask "what did the gates record for this firm". Same pattern
  // as seeding the discovery call the planner omitted -- fix the plan, in the
  // trace, rather than compose around the gap.
  for (const c of evidenceChecks.filter((x) => !x.completed)) {
    if (evidenceChecks.some((x) => x.entityId === c.entityId && x.completed)) continue;
    push('tool', {
      tool: 'check_evidence',
      repaired: { from: c.field ?? '(none)', to: '(all fields)' },
      why: 'the requested field does not exist, so nothing was checked; re-running the supported form',
    });
    await runTool('check_evidence', { entityId: c.entityId });
  }

  // Withdraw superseded failures from what the composer reads.
  //
  // A failed call's text is emphatic by design -- "this result says NOTHING
  // about whether values were withheld" -- and it appeared once per invented
  // field. Against two of those, the single repaired result lost: the composer
  // reported "I could not determine what the gates refused, the dataset does not
  // support those fields" while holding 54 real gate outcomes it had just been
  // handed. Honest, and wrong about what it knew.
  //
  // A superseded failure is not a finding. It stays in the trace, which is the
  // audit record; `collected` is the working set, and a question that was
  // answered on the second attempt was answered.
  const superseded = new Set<number>();
  for (const c of evidenceChecks) {
    if (c.completed || c.collectedAt === undefined) continue;
    if (evidenceChecks.some((x) => x.entityId === c.entityId && x.completed)) {
      superseded.add(c.collectedAt);
    }
  }
  if (superseded.size) {
    const withdrawn = [...superseded].sort((a, b) => b - a);
    for (const i of withdrawn) collected.splice(i, 1);
    push('compose', {
      withdrewSupersededResults: withdrawn.length,
      why: 'a failed check that was repaired is not a finding; it stays in the trace, not in the answer',
    });
  }

  if (!collected.length) {
    const answer =
      'I could not retrieve anything for this question. No tool call succeeded, so I have nothing to base an answer on.';
    push('compose', { answer, reason: 'no tool results' });
    return { answer, unhonouredConstraints: unhonoured, blocked: false, toolsUsed, scope, trace, nameCorrections: [], countsResolved: [], relevanceAsConfidence: [], toolInternalsLeaked: [], unsupportedAbsence: [], skippedAsChecked: [], promptLeak: [], unsupportedRefusal: [], cost: cost() };
  }

  // ---- compose -----------------------------------------------------------
  // The exact tokens, so the model copies rather than composes them. Given only
  // a format example it wrote the literal string "[[entityId]]".
  const roster = [...canonical.entries()]
    .slice(0, 40)
    .map(([id, name]) => `  [[${id}]] = ${name}`)
    .join('\n');

  // Kept so the guard can compare the answer against what was asked of the
  // model. A leak is only detectable against the actual prompt text.
  const composePrompt = COMPOSE_PROMPT(
    question, collected.join('\n\n'), unhonoured, roster, tokenRoster(metrics));
  const composed = await generateJson<{ answer: string }>(
    composePrompt,
    { type: 'object', properties: { answer: { type: 'string' } } },
  );
  const rawAnswer = composed.answer ?? '';
  push('compose', { answer: rawAnswer });

  // ---- firm names become non-generative -----------------------------------
  const counts = resolveCounts(rawAnswer, metrics);
  const resolved = resolveNames(counts.text, canonical);
  let answer = resolved.text;
  const nameCorrections = resolved.corrected;
  const countsResolved = counts.resolved;
  if (counts.unresolvedTokens.length || counts.unsupported.length) {
    push('block', {
      stage: 'count-resolution',
      unresolvedTokens: counts.unresolvedTokens,
      unsupported: counts.unsupported,
    });
  }
  if (resolved.corrected.length || resolved.fabricated.length || resolved.unresolvedTokens.length) {
    push('block', {
      stage: 'name-resolution',
      corrected: resolved.corrected,
      fabricated: resolved.fabricated,
      unresolvedTokens: resolved.unresolvedTokens,
    });
  }

  // ---- claims audit: relevance-as-confidence, and leaked internals --------
  // The answer must restate the unhonourable constraints and may restate the
  // question; neither counts as quoting its instructions.
  // What the answer is SUPPOSED to reproduce, and therefore cannot be leaking:
  // the tool results it exists to convey, the constraints it must state, and the
  // question. Comparing against the whole prompt flagged an answer for quoting
  // its own retrieved data, which is the opposite of a leak. What is left to
  // match against is the instruction scaffolding -- the only part addressed to
  // the system rather than the reader.
  const claims = auditClaims(
    answer, relevanceScores,
    evidenceChecks.map((c) => ({ ...c, withheldForEntity: withheldByEntity.get(c.entityId) ?? 0 })),
    composePrompt, [...unhonoured, question, ...collected]);
  const relevanceAsConfidence = claims.relevanceAsConfidence;
  const toolInternalsLeaked = claims.internals;
  const unsupportedAbsence = claims.unsupportedAbsence;
  const skippedAsChecked = claims.skippedAsChecked;
  const promptLeak = claims.promptLeak;
  const unsupportedRefusal = claims.unsupportedRefusal;
  if (relevanceAsConfidence.length || toolInternalsLeaked.length || unsupportedAbsence.length || skippedAsChecked.length || promptLeak.length || unsupportedRefusal.length) {
    push('block', {
      stage: 'claims-audit',
      relevanceAsConfidence, toolInternalsLeaked, unsupportedAbsence, skippedAsChecked, promptLeak, unsupportedRefusal,
    });
  }

  // ---- the constraint-preservation check, in control flow ----------------
  //
  // Not a prompt instruction and not a suggestion. If the planner recorded a
  // constraint it could not honour, the answer must visibly say so, or it does
  // not ship. This is the check Stage 1 did not have.
  let blocked = false;
  let blockReason: string | undefined;

  // A ranking weight presented as confidence is a fabricated certainty, and
  // tool internals are unreadable to a buyer. Either blocks the answer.
  if (relevanceAsConfidence.length || toolInternalsLeaked.length || unsupportedAbsence.length || skippedAsChecked.length || promptLeak.length || unsupportedRefusal.length) {
    blocked = true;
    blockReason =
      (relevanceAsConfidence.length ? 'composer presented a relevance score as a confidence value' : '') +
      (relevanceAsConfidence.length && toolInternalsLeaked.length ? '; ' : '') +
      (toolInternalsLeaked.length ? 'composer exposed internal tool output in customer-facing prose' : '') +
      ((relevanceAsConfidence.length || toolInternalsLeaked.length) && unsupportedAbsence.length ? '; ' : '') +
      (unsupportedAbsence.length ? 'composer asserted nothing was withheld with no completed evidence check behind it' : '') +
      ((relevanceAsConfidence.length || toolInternalsLeaked.length || unsupportedAbsence.length) && skippedAsChecked.length ? '; ' : '') +
      (skippedAsChecked.length ? 'composer counted gates that did not run as checks that cleared the record' : '') +
      ((relevanceAsConfidence.length || toolInternalsLeaked.length || unsupportedAbsence.length || skippedAsChecked.length) && promptLeak.length ? '; ' : '') +
      (promptLeak.length ? 'composer quoted its own instructions into the answer' : '') +
      (promptLeak.length && unsupportedRefusal.length ? '; ' : '') +
      (unsupportedRefusal.length ? 'composer said values were refused when nothing was refused' : '');
    answer = confidenceBlockMessage(claims);
    return { answer, unhonouredConstraints: unhonoured, blocked, blockReason, toolsUsed, scope, trace,
      nameCorrections, countsResolved, relevanceAsConfidence, toolInternalsLeaked, unsupportedAbsence, skippedAsChecked, promptLeak, unsupportedRefusal, cost: cost() };
  }

  // A dataset count the tools did not produce is a fabricated fact.
  if (counts.unresolvedTokens.length || counts.unsupported.length) {
    blocked = true;
    blockReason =
      `composer stated ${counts.unsupported.length} dataset count(s) no tool produced` +
      (counts.unresolvedTokens.length ? ` and ${counts.unresolvedTokens.length} unresolved count token(s)` : '');
    answer =
      'I cannot give this answer. The draft stated ' +
      [...counts.unsupported.map(String), ...counts.unresolvedTokens].map((c) => `"${c}"`).join(', ') +
      ' as a figure from the data, but no tool returned it. Rather than show you a ' +
      'number I cannot trace, I am declining the answer.';
    return { answer, unhonouredConstraints: unhonoured, blocked, blockReason, toolsUsed, scope, trace, nameCorrections, countsResolved, relevanceAsConfidence, toolInternalsLeaked, unsupportedAbsence, skippedAsChecked, promptLeak, unsupportedRefusal, cost: cost() };
  }

  // A firm-like name with no counterpart in the tool output is a fabricated
  // value. It does not ship, even if everything around it is correct.
  if (resolved.fabricated.length || resolved.unresolvedTokens.length) {
    blocked = true;
    blockReason =
      `composer produced ${resolved.fabricated.length} firm name(s) and ` +
      `${resolved.unresolvedTokens.length} entity reference(s) that no tool returned`;
    answer =
      'I cannot give this answer. The draft named ' +
      [...resolved.fabricated, ...resolved.unresolvedTokens].map((f) => `"${f}"`).join(', ') +
      ', which does not appear in the data I retrieved. Rather than show you a firm ' +
      'that may not exist, I am declining the answer.';
    return { answer, unhonouredConstraints: unhonoured, blocked, blockReason, toolsUsed, scope, trace, nameCorrections, countsResolved, relevanceAsConfidence, toolInternalsLeaked, unsupportedAbsence, skippedAsChecked, promptLeak, unsupportedRefusal, cost: cost() };
  }

  if (unhonoured.length) {
    const surfaced = surfacesLimitation(answer, unhonoured);
    if (!surfaced) {
      blocked = true;
      blockReason =
        'composer produced an answer that did not surface a constraint the planner could not honour';
      push('block', { blockReason, unhonoured });
      answer =
        `I could not fully answer this as asked. ` +
        `${unhonoured.map((u) => u.split(' — ')[0]).join('; ')} — the dataset does not hold that, so I did not filter on it.\n\n` +
        `What I can tell you, on the part I could answer:\n\n${answer}`;
    }
  }

  return { answer, unhonouredConstraints: unhonoured, blocked, blockReason, toolsUsed, scope, trace, nameCorrections, countsResolved, relevanceAsConfidence, toolInternalsLeaked, unsupportedAbsence, skippedAsChecked, promptLeak, unsupportedRefusal, cost: cost() };
}

/**
 * Does the answer actually tell the reader about the limitation?
 *
 * Deliberately lexical rather than a model judgement: asking a model whether an
 * answer is honest enough reintroduces exactly the failure mode this guards. A
 * cheap check that is occasionally over-strict is the right trade — a false
 * block prepends a caveat, while a false pass ships a silently narrowed answer.
 */
export function surfacesLimitation(answer: string, unhonoured: string[]): boolean {
  const a = answer.toLowerCase();

  const admits = [
    'could not', "couldn't", 'cannot', "can't", 'unable', 'do not hold', "don't hold",
    'not available', 'no data', 'does not contain', "doesn't contain", 'not held',
    'did not filter', "didn't filter", 'no claim', 'not recorded', 'unavailable',
    'i have no', 'the dataset does not', 'not something',
  ].some((p) => a.includes(p));
  if (!admits) return false;

  // It must also point at the right subject, not merely sound apologetic.
  return unhonoured.some((u) => {
    const subject = u.split(' — ')[0]!.toLowerCase();
    const words = subject.split(/[^a-z]+/).filter((w) => w.length > 4);
    return words.length === 0 || words.some((w) => a.includes(w));
  });
}
