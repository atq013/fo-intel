/**
 * Unattended enrichment run.
 *
 * Establishing a firm's type costs one search, three page fetches and one
 * extraction, so it is slow and entirely I/O bound - the kind of work worth
 * running while nobody is watching. It checkpoints after every firm, so a crash
 * or a closed laptop costs the remainder of the run, not the run.
 *
 * Re-running skips anything already resolved, which makes it safe to start again
 * from wherever it stopped.
 */
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { consolidate } from './classify/consolidate.js';
import { establishType, type TypeFinding } from './enrich/establish-type.js';
import { serperUsage } from './lib/serper.js';
import { dnsStats } from './lib/dns.js';

const OUT = 'data/type-findings.json';
const LOG = 'data/batch.log';
const MAX_FIRMS = Number(process.env.BATCH_MAX ?? 420);
/** Stop before the machine is due to sleep rather than being killed mid-write. */
const DEADLINE_MS = Number(process.env.BATCH_MINUTES ?? 150) * 60_000;

function log(msg: string) {
  const line = `${new Date().toISOString().slice(11, 19)}  ${msg}`;
  console.log(line);
  appendFileSync(LOG, line + '\n');
}

const findings: Record<string, TypeFinding> = existsSync(OUT)
  ? JSON.parse(readFileSync(OUT, 'utf8'))
  : {};

const started = Date.now();

const firms = consolidate();

/**
 * Enrich the firms where establishing a type actually changes the dataset: ones
 * we could not classify, that already carry contact data or dated activity.
 * A firm with no phone and no signals gains little from being classified, and
 * the run has a fixed budget.
 */
const targets = firms
  .filter((f) => !f.classification.qualifies)
  .filter((f) => f.classification.type !== 'advisory_or_wealth_manager')
  /**
   * Two targeting modes.
   *
   * 'phone' prefers SEC firms that already carry a filed phone, because
   * establishing their type turns a half-record into a complete one.
   *
   * 'web' prefers web-discovered firms with a named principal whose type the
   * extraction could not settle. These matter for a different reason: the file is
   * half Companies House, and every web record that qualifies moves it further
   * from reading as one registry copied at scale.
   */
  .filter((f) =>
    (process.env.BATCH_TARGET ?? 'phone') === 'web'
      ? f.principalName && !f.phone && ![...f.channels].some((c) => c.startsWith('sec') || c === 'companies_house')
      : Boolean(f.phone),
  )
  .filter((f) => !findings[f.key])
  .sort((a, b) => {
    const score = (x: typeof a) =>
      (x.phone ? 2 : 0) + Math.min(x.signalCount, 6) + (x.ruleInput.structuralScore ?? 0) / 40 + x.channels.size;
    return score(b) - score(a);
  })
  .slice(0, MAX_FIRMS);

log(`pool ${firms.length} firms; ${Object.keys(findings).length} already resolved; enriching ${targets.length}`);

let done = 0;
const tally: Record<string, number> = {};

for (const firm of targets) {
  if (Date.now() - started > DEADLINE_MS) {
    log(`stopping: reached the ${DEADLINE_MS / 60_000} minute budget`);
    break;
  }

  try {
    const finding = await establishType(firm.name, [firm.city, firm.region].filter(Boolean).join(' '));
    findings[firm.key] = finding;
    tally[finding.type] = (tally[finding.type] ?? 0) + 1;

    if (finding.type !== 'undetermined') {
      log(`  ${finding.type.padEnd(22)} conf ${finding.confidence.toFixed(2)} t${finding.sourceTier}  ${firm.name.slice(0, 44)}`);
    }
  } catch (err) {
    // A single firm failing must not end an unattended run.
    findings[firm.key] = {
      firmName: firm.name,
      type: 'undetermined',
      confidence: 0,
      quote: '',
      sourceUrl: '',
      sourceTier: null,
      website: null,
      claims: [],
      conflicted: false,
      note: `run error: ${err instanceof Error ? err.message : String(err)}`,
    };
    tally.error = (tally.error ?? 0) + 1;
  }

  done++;
  writeFileSync(OUT, JSON.stringify(findings, null, 2));

  if (done % 25 === 0) {
    const mins = ((Date.now() - started) / 60_000).toFixed(1);
    log(`${done}/${targets.length} after ${mins}m  |  ${JSON.stringify(tally)}  |  serper ${serperUsage()}  dns ${JSON.stringify(dnsStats())}`);
  }
}

log(`finished: ${done} firms processed`);
log(`outcomes: ${JSON.stringify(tally)}`);
log(`serper queries used this run: ${serperUsage()}`);
log(`dns: ${JSON.stringify(dnsStats())}`);
