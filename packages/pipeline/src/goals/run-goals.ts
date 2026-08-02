import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Runs the three official goals against PRODUCTION and preserves everything.
 *
 * The brief asks, for each goal: the exact goal given, the output a user would
 * get from the extended retrieval manually, the agent's structured output, and
 * the raw unedited run log. All four are captured here in one pass so the
 * comparison is between what the same deployed system produced at the same
 * moment, not between an agent run and a hand-written "what you'd otherwise
 * get".
 *
 * Nothing is edited afterwards. If the agent abstains, blocks, or gets something
 * wrong, that is what gets saved -- a trace corrected after the fact is not a
 * trace.
 */

const BASE = process.env.GOALS_BASE ?? 'https://fo-intel-web.vercel.app';
const ATTEMPT = process.env.GOALS_ATTEMPT ?? 'attempt-2';
const OUT = fileURLToPath(new URL(`../../../../docs/goals/${ATTEMPT}/`, import.meta.url));
mkdirSync(OUT, { recursive: true });

interface Goal {
  id: string;
  category: string;
  /** The exact wording submitted. Goal 2 is verbatim from the brief. */
  prompt: string;
  /** The closest equivalent a user could run by hand against the retrieval UI. */
  manual: string;
  why: string;
}

const GOALS: Goal[] = [
  {
    id: 'goal-1-multi-step-commercial-search',
    category: 'Goal 1 · Multi-step commercial search',
    prompt:
      'I am raising a fund and need a prioritised outreach list. Which family offices can I ' +
      'reach by phone at a named individual, how many are there in total, and for the ones you ' +
      'return, which have every value traced to a statutory source rather than an aggregator? ' +
      'Tell me which to approach first and what is missing from each.',
    manual: '/api/shortlist?strict=1&tier=1&limit=25',
    why:
      'No single retrieval call answers this: it needs a filtered shortlist, a separate exact ' +
      'count, per-record evidence grading, and a comparison composed into an outreach order.',
  },
  {
    id: 'goal-2-uncertain-data',
    category: 'Goal 2 · Uncertain-data case (verbatim from the brief)',
    prompt:
      'Identify the family offices in the dataset that are the best fit for a lower-middle-market ' +
      'healthcare services fund seeking limited partners, and tell me how confident you are in each.',
    manual: '/api/shortlist?limit=25',
    why:
      'The dataset holds no mandate, sector or AUM evidence. A strong system says so rather than ' +
      'inferring fit from a firm name. This goal exists to see whether it does.',
  },
  {
    id: 'goal-3-paid-tier',
    category: 'Goal 3 · Paid-tier case',
    prompt:
      'I am about to contact BOSTON FAMILY OFFICE LLC. What does the system hold on them, what ' +
      'evidence backs the contact route, and what did the validation gates refuse to publish ' +
      'about them and why?',
    manual: '/api/shortlist?q=Boston%20Family%20Office&limit=5',
    why:
      'A one-time export cannot tell a buyer what was refused and why. The gate outcomes and the ' +
      'evidence span behind each value are the paid-tier product; the record itself is the free part.',
  },
];

async function post(question: string) {
  const started = new Date().toISOString();
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  const body = await res.json();
  return { started, ms: Date.now() - t0, status: res.status, body };
}

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: await res.json() };
}

const summary: Array<Record<string, unknown>> = [];

for (const g of GOALS) {
  console.log(`\n=== ${g.category} ===`);
  const manual = await get(g.manual);
  const agent = await post(g.prompt);
  const b = agent.body as Record<string, any>;

  // Entity ids the agent actually touched, pulled from the trace rather than
  // from the prose, so the record is of what ran and not what was said.
  const entityIds = new Set<string>();
  for (const t of (b.trace ?? []) as Array<Record<string, any>>) {
    const id = t?.detail?.input?.entityId ?? t?.detail?.scope?.entityId;
    if (typeof id === 'string' && id.startsWith('ent_')) entityIds.add(id);
  }

  const record = {
    goal: g.category,
    goalId: g.id,
    submittedPrompt: g.prompt,
    productionUrl: `${BASE}/api/agent`,
    agentUiUrl: `${BASE}/agent`,
    submittedAtUtc: agent.started,
    latencyMs: agent.ms,
    httpStatus: agent.status,
    whyThisGoal: g.why,

    manualRetrievalEquivalent: {
      url: `${BASE}${g.manual}`,
      httpStatus: manual.status,
      scope: (manual.body as any)?.scope ?? null,
      limits: (manual.body as any)?.limits ?? null,
      results: ((manual.body as any)?.results ?? []).map((r: any) => ({
        entityId: r.entityId, name: r.name, score: r.score,
        contact: r.contact ?? null, matched: r.matched, missing: r.missing,
      })),
    },

    agentAnswer: b.answer ?? null,
    blocked: b.blocked ?? false,
    blockReason: b.blockReason ?? null,
    unhonouredConstraints: b.unhonouredConstraints ?? [],
    abstained: (b.unhonouredConstraints ?? []).length > 0 || b.blocked === true,
    nameCorrections: b.nameCorrections ?? [],
    relevanceAsConfidence: b.relevanceAsConfidence ?? [],
    toolInternalsLeaked: b.toolInternalsLeaked ?? [],
    unsupportedAbsence: b.unsupportedAbsence ?? [],
    skippedAsChecked: b.skippedAsChecked ?? [],
    promptLeak: b.promptLeak ?? [],
    // Measured spend for THIS answer, so the cost figures in the architecture
    // notes come from the same run the trace records rather than an average.
    cost: b.cost ?? null,
    countsResolvedFromToolOutput: b.countsResolved ?? [],
    toolsUsed: b.toolsUsed ?? [],
    scopePerTool: b.scope ?? [],
    entityIdsUsed: [...entityIds],
    rawTrace: b.trace ?? [],
    error: b.error ?? null,
  };

  writeFileSync(OUT + g.id + '.json', JSON.stringify(record, null, 2));

  console.log(`  submitted   : ${agent.started}  (${agent.ms}ms, HTTP ${agent.status})`);
  console.log(`  blocked     : ${record.blocked}   abstained: ${record.abstained}`);
  console.log(`  relevance-as-confidence: ${JSON.stringify(record.relevanceAsConfidence)}`);
  console.log(`  internals leaked       : ${JSON.stringify(record.toolInternalsLeaked)}`);
  console.log(`  unhonoured  : ${JSON.stringify(record.unhonouredConstraints)}`);
  console.log(`  tools       : ${JSON.stringify(record.toolsUsed)}`);
  console.log(`  entity ids  : ${record.entityIdsUsed.length}`);
  console.log(`  trace steps : ${record.rawTrace.length}`);
  const c = (b.cost ?? {}) as Record<string, any>;
  console.log(`  cost        : ${c.totals?.modelCalls ?? 0} model calls, ` +
    `${(c.totals?.promptTokens ?? 0) + (c.totals?.completionTokens ?? 0)} tokens, ` +
    `$${c.estimatedUsd?.total ?? 0}, ${c.wallMs ?? 0}ms`);
  console.log(`  manual scope: ${JSON.stringify(record.manualRetrievalEquivalent.scope)}`);
  console.log(`  answer      : ${String(record.agentAnswer ?? '').slice(0, 300)}`);

  summary.push({
    goal: g.category, file: `docs/goals/${ATTEMPT}/${g.id}.json`,
    submittedAtUtc: agent.started, blocked: record.blocked,
    abstained: record.abstained, tools: record.toolsUsed,
    traceSteps: record.rawTrace.length,
  });
}

writeFileSync(OUT + 'index.json', JSON.stringify({
  attempt: ATTEMPT,
  producedAtUtc: new Date().toISOString(),
  productionBase: BASE,
  note: 'Unedited production output. Nothing was corrected after execution.',
  goals: summary,
}, null, 2));
console.log(`\nwritten: docs/goals/${ATTEMPT}/*.json`);
