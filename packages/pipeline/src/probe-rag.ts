import 'dotenv/config';
import { answerQuestion } from '@fo/rag';

const questions = [
  'Who runs Duquesne Family Office?',
  'Single-family offices in the United Kingdom',
  'Which family offices are based in the United States?',
];

for (const q of questions) {
  const r = await answerQuestion(q);
  console.log(`\n=== ${q}`);
  console.log(`  filters: ${r.parsed.appliedFilters.join(' | ') || 'none'}  semantic: "${r.parsed.semanticQuery}"`);
  console.log(`  answered: ${r.answered}  kept ${r.claims.length}  dropped ${r.droppedClaims.length}  firms ${r.firms.length}`);
  if (r.declineReason) console.log(`  declined: ${r.declineReason}`);
  for (const c of r.claims.slice(0, 3)) console.log(`    KEPT: ${c.text.slice(0, 100)}`);
  for (const c of r.droppedClaims.slice(0, 4)) console.log(`    DROP: ${c.text.slice(0, 78)}\n          reason: ${c.reason.slice(0, 90)}`);
}
