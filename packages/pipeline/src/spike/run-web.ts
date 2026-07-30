import 'dotenv/config';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { probeLeadershipPage, type ProbeResult } from './web-channels.js';

const LOG = 'data/spike-web.log';
const log = (m: string) => { console.log(m); appendFileSync(LOG, m + '\n'); };

const recs = JSON.parse(readFileSync('data/fo-dataset.json', 'utf8')) as any[];
// stratified: 10 per origin so the comparison is like-for-like
const pick = (pred: (r: any) => boolean, n: number) => recs.filter(pred).slice(0, n);
const ch = (r: any) => r.discoveries?.[0]?.channel ?? '';

const sample = [
  ...pick(r => ch(r) === 'companies_house', 10),
  ...pick(r => ch(r).startsWith('sec'), 6),
  ...pick(r => ['conference_programme','news','job_posting'].includes(ch(r)), 10),
];

log(`leadership-page probe over ${sample.length} firms`);
const out: ProbeResult[] = [];
for (const r of sample) {
  const hint = [r.city?.value, r.country?.value].filter(Boolean).join(' ');
  const res = await probeLeadershipPage(r.legalName, hint);
  out.push(res);
  const mark = res.passesGate5 ? 'PASS' : res.personIdentified ? 'part' : '  - ';
  log(`  ${mark} ${r.legalName.slice(0,34).padEnd(36)}${(res.personIdentified ?? '').slice(0,22).padEnd(24)}${res.routeFound?.value.slice(0,28) ?? ''}`);
  await new Promise(s => setTimeout(s, 1200));
}

writeFileSync('data/spike-leadership.json', JSON.stringify(out, null, 2));
const n = out.length;
const agg = {
  candidatesAttempted: n,
  personIdentified: out.filter(o => o.personIdentified).length,
  routeFound: out.filter(o => o.routeFound).length,
  ownershipEvidenced: out.filter(o => o.ownershipEvidenced).length,
  passesGate5: out.filter(o => o.passesGate5).length,
  apiCalls: out.reduce((a,o)=>a+o.apiCalls,0),
  wallMs: out.reduce((a,o)=>a+o.wallMs,0),
};
log('');
log(`  attempted ${agg.candidatesAttempted} | person ${agg.personIdentified} | route ${agg.routeFound} | ownership ${agg.ownershipEvidenced} | gate5 ${agg.passesGate5}`);
log(`  api calls ${agg.apiCalls} | wall ${Math.round(agg.wallMs/1000)}s | per qualified ${agg.passesGate5 ? Math.round(agg.apiCalls/agg.passesGate5) + ' calls' : 'n/a'}`);
