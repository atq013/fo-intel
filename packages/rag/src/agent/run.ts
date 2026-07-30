import { generateJson } from '../llm.js';
import { TOOLS, TOOL_SCHEMAS, type ToolResult } from './tools.js';

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
}

interface Plan {
  constraints: Array<{ constraint: string; honourable: boolean; why: string }>;
  calls: Array<{ tool: string; input: Record<string, unknown>; because: string }>;
}

const MAX_CALLS = 4;

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

const COMPOSE_PROMPT = (question: string, results: string, unhonoured: string[]) => `Answer the question using ONLY the tool results below.

Question: "${question}"

Tool results:
${results}

${unhonoured.length ? `You could NOT honour these constraints:
${unhonoured.map((c) => `- ${c}`).join('\n')}

You MUST state this plainly in your answer, in the first two sentences, in plain
words. Say which part of the question you could not do and what you did instead.
An answer that quietly ignores these is worse than no answer.` : 'All constraints were honourable.'}

Rules:
- Every firm you name must appear in the tool results. Never name one that does not.
- Never upgrade a label: a company inbox is not a principal's email; "not found" is not "does not exist".
- State the scope: how many were searched, how many MATCHED. Use the "matched"
  number from the tool scope, never the length of the returned data array - the
  array is a truncated page, and reporting its length understates the answer.
- If a firm is missing a field, say it is missing. Do not estimate it.
- Be concise and specific. No preamble.

Return JSON: {"answer":"..."}`;

export async function runAgent(question: string): Promise<AgentAnswer> {
  const trace: AgentTrace[] = [];
  const now = () => new Date().toISOString();
  const push = (kind: AgentTrace['kind'], detail: unknown) =>
    trace.push({ step: trace.length + 1, kind, detail, at: now() });

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

  // ---- act ---------------------------------------------------------------
  const toolsUsed: string[] = [];
  const scope: Record<string, unknown>[] = [];
  const collected: string[] = [];

  for (const call of (plan.calls ?? []).slice(0, MAX_CALLS)) {
    const fn = TOOLS[call.tool];
    if (!fn) {
      push('tool', { tool: call.tool, error: 'no such tool' });
      continue;
    }
    try {
      const r: ToolResult<unknown> = await fn(call.input ?? {});
      toolsUsed.push(call.tool);
      scope.push({ tool: call.tool, ...r.scope });
      push('tool', { tool: call.tool, input: call.input, scope: r.scope, excluded: r.excluded, rows: Array.isArray(r.data) ? r.data.length : 1 });
      collected.push(
        `TOOL ${call.tool}(${JSON.stringify(call.input)})\n` +
        `scope: ${JSON.stringify(r.scope)}\n` +
        `excluded: ${JSON.stringify(r.excluded)}\n` +
        `limits: ${r.limits.join(' | ')}\n` +
        `data: ${JSON.stringify(r.data).slice(0, 4000)}`,
      );
    } catch (err) {
      push('tool', { tool: call.tool, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (!collected.length) {
    const answer =
      'I could not retrieve anything for this question. No tool call succeeded, so I have nothing to base an answer on.';
    push('compose', { answer, reason: 'no tool results' });
    return { answer, unhonouredConstraints: unhonoured, blocked: false, toolsUsed, scope, trace };
  }

  // ---- compose -----------------------------------------------------------
  const composed = await generateJson<{ answer: string }>(
    COMPOSE_PROMPT(question, collected.join('\n\n'), unhonoured),
    { type: 'object', properties: { answer: { type: 'string' } } },
  );
  let answer = composed.answer ?? '';
  push('compose', { answer });

  // ---- the constraint-preservation check, in control flow ----------------
  //
  // Not a prompt instruction and not a suggestion. If the planner recorded a
  // constraint it could not honour, the answer must visibly say so, or it does
  // not ship. This is the check Stage 1 did not have.
  let blocked = false;
  let blockReason: string | undefined;

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

  return { answer, unhonouredConstraints: unhonoured, blocked, blockReason, toolsUsed, scope, trace };
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
