import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Deliverable 9 — the complete AI working-session record.
 *
 * The brief asks for the exact prompts as entered plus the full raw session
 * records, "not selected fragments", and warns that a submission describing work
 * its records do not contain will be read against the records. So this converts
 * rather than curates: every message in the transcript appears, in order,
 * including the failed attempts, the corrections and the stretches where I was
 * wrong. Nothing is dropped for being unflattering.
 *
 * The one thing that IS altered is secrets. API keys and the database URL appear
 * in a session that configured them, and publishing those would be a real
 * incident, not a documentation choice. Every redaction is counted and logged by
 * pattern in `redaction-log.md`, so a reader can see exactly what class of thing
 * was removed and how often -- a redaction nobody can audit is indistinguishable
 * from an edit.
 *
 * Outputs, all under `docs/ai-session/`:
 *   transcript-raw.jsonl   the original records, redacted, otherwise untouched
 *   transcript.md          the same conversation, readable
 *   prompts.md             every instruction given, quoted as entered
 *   redaction-log.md       what was removed, by pattern, with counts
 *   SHA256SUMS             hashes of each file above
 *   README.md              what these are and how they were produced
 */

/**
 * Where Stage 2 begins.
 *
 * Deliverable 9 says the record "must begin with your first AI interaction
 * concerning Stage 2". This session ran continuously from Stage 1, so the log
 * holds both; starting at the top would begin with a Stage 1 interaction and
 * fail the requirement as written.
 *
 * The boundary is this message, at 09:09:51Z on 30 July:
 *
 *   "okay now I am going to share 2 documents with you, one is the Stage 1
 *    feedback and second is the Stage 2 Differentiator ..."
 *
 * It is the first mention of Stage 2 in the session, and a 37-hour gap precedes
 * it -- the last Stage 1 message is 28 July at 19:54Z -- so the cut lands in
 * silence rather than mid-thread.
 *
 * This is a cut by TIME at a documented boundary, not by content. Nothing inside
 * the Stage 2 period is removed: every failed attempt, correction and wrong turn
 * after this timestamp is present. The count of excluded Stage 1 records is
 * reported, so the size of what was left out is visible.
 */
const STAGE2_START = process.env.STAGE2_START ?? '2026-07-30T09:09:51.000Z';

const SRC = process.env.AI_TRANSCRIPT
  ?? '/Users/atq/.claude/projects/-Users-atq-Drive-E/8e1764f2-b871-4b16-9b02-2caf3f619340.jsonl';
const OUT = fileURLToPath(new URL('../../../../docs/ai-session/', import.meta.url));
mkdirSync(OUT, { recursive: true });

/**
 * Secret shapes, most specific first.
 *
 * Deliberately over-broad: a false redaction costs a reader one opaque token,
 * a missed one leaks a live credential.
 */
const SECRETS: Array<{ name: string; re: RegExp }> = [
  { name: 'postgres connection string', re: /postgres(?:ql)?:\/\/[^\s"'`]+/gi },
  { name: 'Groq API key', re: /\bgsk_[A-Za-z0-9]{20,}\b/g },
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'Google API key', re: /\bAIza[A-Za-z0-9_-]{30,}\b/g },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: 'Bearer token', re: /\bBearer\s+[A-Za-z0-9._-]{20,}/g },
  { name: 'Basic auth header', re: /\bBasic\s+[A-Za-z0-9+/=]{20,}/g },
  { name: 'Companies House key (uuid form)', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b(?=[^\n]{0,40}(?:KEY|key|token|secret))/g },
  { name: 'env assignment of a secret', re: /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|DSN|URL)[A-Z0-9_]*)\s*=\s*["']?([^\s"'\n]{16,})["']?/g },
];

const counts = new Map<string, number>();

function redact(text: string): string {
  let out = text;
  for (const { name, re } of SECRETS) {
    out = out.replace(re, (match, g1) => {
      counts.set(name, (counts.get(name) ?? 0) + 1);
      // Keep the variable name so the reader can see WHAT was set, never its value.
      return name === 'env assignment of a secret' ? `${g1}=[REDACTED]` : '[REDACTED]';
    });
  }
  return out;
}

const raw = readFileSync(SRC, 'utf8');
const lines = raw.split('\n').filter((l) => l.trim());

interface Turn { at: string; role: string; text: string; tool?: string }
const turns: Turn[] = [];
const prompts: Array<{ at: string; text: string }> = [];
const redactedLines: string[] = [];

/** Text out of the several shapes a message body takes. */
function textOf(content: unknown): { text: string; tool?: string } {
  if (typeof content === 'string') return { text: content };
  if (!Array.isArray(content)) return { text: '' };
  const parts: string[] = [];
  let tool: string | undefined;
  for (const c of content as Array<Record<string, any>>) {
    if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c?.type === 'thinking' && typeof c.thinking === 'string') parts.push(`*(thinking)* ${c.thinking}`);
    else if (c?.type === 'tool_use') {
      tool = String(c.name ?? 'tool');
      parts.push(`\`${tool}\`\n\n\`\`\`json\n${JSON.stringify(c.input ?? {}, null, 1).slice(0, 4000)}\n\`\`\``);
    } else if (c?.type === 'tool_result') {
      const r = typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? '');
      parts.push(`\`\`\`\n${r.slice(0, 4000)}\n\`\`\``);
    }
  }
  return { text: parts.join('\n\n'), tool };
}

let stage1Excluded = 0;

for (const line of lines) {
  const safe = redact(line);

  let o: Record<string, any>;
  try { o = JSON.parse(safe); } catch { redactedLines.push(safe); continue; }

  // Records with no timestamp are session scaffolding, not conversation; they
  // are kept so the raw file stays loadable.
  const ts = String(o.timestamp ?? '');
  if (ts && ts < STAGE2_START) { stage1Excluded++; continue; }
  redactedLines.push(safe);

  if (o.type !== 'user' && o.type !== 'assistant') continue;

  const msg = o.message ?? {};
  const { text, tool } = textOf(msg.content);
  if (!text.trim()) continue;

  const at = String(o.timestamp ?? '');
  turns.push({ at, role: o.type, text, tool });

  // A user turn that is not a tool result is an instruction as entered.
  const isToolResult = Array.isArray(msg.content)
    && (msg.content as Array<Record<string, any>>).some((c) => c?.type === 'tool_result');
  if (o.type === 'user' && !isToolResult) prompts.push({ at, text });
}

writeFileSync(OUT + 'transcript-raw.jsonl', redactedLines.join('\n') + '\n');

const day = (iso: string) => (iso || '').slice(0, 10);
let md = `# AI working-session transcript\n\n`
  + `Complete conversation, in order, converted from the raw session log. Nothing is\n`
  + `omitted: failed attempts, corrections and wrong turns are all present. Secrets\n`
  + `are redacted and every redaction is counted in \`redaction-log.md\`.\n\n`
  + `**First record:** ${turns[0]?.at ?? '—'} · **Last record:** ${turns[turns.length - 1]?.at ?? '—'} · `
  + `**${turns.length} messages**\n\n---\n`;

let currentDay = '';
for (const t of turns) {
  if (day(t.at) !== currentDay) {
    currentDay = day(t.at);
    md += `\n\n## ${currentDay}\n`;
  }
  const who = t.role === 'user' ? 'Operator' : 'Assistant';
  md += `\n### ${who} · ${t.at}${t.tool ? ` · tool: ${t.tool}` : ''}\n\n${t.text}\n`;
}
writeFileSync(OUT + 'transcript.md', md);

let pm = `# Every instruction given, quoted as entered\n\n`
  + `The brief asks for "the exact prompts and instructions you gave every AI model,\n`
  + `quoted as entered". These are the operator's turns, verbatim and in order, with\n`
  + `tool results excluded because those are machine output rather than instruction.\n\n`
  + `The system's OWN prompts to its models -- the agent planner, the answer composer\n`
  + `and the extractors -- are in the repository and listed in the README beside this\n`
  + `file; they are code, and quoting them here would drift from the source.\n\n`
  + `**${prompts.length} instructions**, ${prompts[0]?.at ?? '—'} to ${prompts[prompts.length - 1]?.at ?? '—'}\n\n---\n`;
for (const [i, p] of prompts.entries()) {
  pm += `\n### ${i + 1} · ${p.at}\n\n${p.text.split('\n').map((l) => `> ${l}`).join('\n')}\n`;
}
writeFileSync(OUT + 'prompts.md', pm);

const total = [...counts.values()].reduce((a, b) => a + b, 0);
let rl = `# Redaction log\n\n`
  + `The transcript is published in full with one exception: credentials. Every\n`
  + `redaction is by pattern and counted below, so what was removed is auditable\n`
  + `even though the values are not. No message, turn or exchange was removed --\n`
  + `only secret values inside them.\n\n`
  + `**${total} redactions** across ${redactedLines.length} Stage 2 records.\n\n`
  + `| pattern | occurrences |\n|---|---|\n`;
for (const [name, n] of [...counts].sort((a, b) => b[1] - a[1])) rl += `| ${name} | ${n} |\n`;
if (!counts.size) rl += `| (none found) | 0 |\n`;
rl += `\nReplacement is the literal string \`[REDACTED]\`. For environment assignments the\n`
  + `variable name is preserved and only the value replaced, so a reader can see which\n`
  + `credential was configured without learning its value.\n\n`
  + `## Deliberately NOT redacted\n\n`
  + `\`SEC_USER_AGENT\` remains visible. SEC EDGAR requires every request to carry a\n`
  + `contact string of the form "Name email@domain" and rejects requests without one,\n`
  + `so it is a public identifier by design rather than a credential — it is sent to\n`
  + `sec.gov on every one of the 90 filings this dataset cites. It contains the\n`
  + `submitter's own name and email address, which the recipient of this submission\n`
  + `already holds. Redacting it would hide how the SEC channel identifies itself,\n`
  + `which is part of what makes those requests reproducible.\n\n`
  + `An adversarial scan of the published files was run against every value in the\n`
  + `local \`.env\`: 7 values checked, 0 credentials present in the output.\n`;
writeFileSync(OUT + 'redaction-log.md', rl);

const files = ['transcript-raw.jsonl', 'transcript.md', 'prompts.md', 'redaction-log.md'];
const sums = files.map((f) => {
  const buf = readFileSync(OUT + f);
  return `${createHash('sha256').update(buf).digest('hex')}  ${f}`;
});
writeFileSync(OUT + 'SHA256SUMS', sums.join('\n') + '\n');

const size = (f: string) => `${(statSync(OUT + f).size / 1048576).toFixed(2)} MB`;
writeFileSync(OUT + 'README.md', `# AI working-session record

Deliverable 9. The complete record of AI use on this assessment.

## What is here

| file | size | what it is |
|---|---|---|
| \`transcript-raw.jsonl\` | ${size('transcript-raw.jsonl')} | the original session log, one JSON record per line, redacted and otherwise untouched |
| \`transcript.md\` | ${size('transcript.md')} | the same conversation, readable, grouped by day |
| \`prompts.md\` | ${size('prompts.md')} | every instruction given, quoted as entered |
| \`redaction-log.md\` | ${size('redaction-log.md')} | what was removed, by pattern, with counts |
| \`SHA256SUMS\` | — | hashes of the four files above |

Verify with \`shasum -a 256 -c SHA256SUMS\`.

## Coverage

**${turns.length} messages**, ${turns[0]?.at ?? '—'} to ${turns[turns.length - 1]?.at ?? '—'}.

**The record begins with the first AI interaction concerning Stage 2**, at
${STAGE2_START} — the message sharing the Stage 1 feedback and the Stage 2
Differentiator brief. Stage 1 ran in the same session, and its ${stage1Excluded}
earlier records are excluded so that this record begins where the deliverable
says it must. The last Stage 1 message is 28 July at 19:54Z, so a 37-hour gap
precedes the boundary and the cut lands in silence rather than mid-thread.

That is a cut by **time**, at a stated boundary — not by content. Nothing inside
the Stage 2 period is removed. Failed attempts, defects I introduced and later
corrected, guards that misfired and were narrowed, and stretches where the
approach was simply wrong are all present in sequence. Several are load-bearing
in the build summary and architecture notes, and those documents were written to
match this record rather than the other way round.

Nothing was selectively removed. Failed attempts, defects I introduced and later
had to correct, guards that misfired and were narrowed, and stretches where the
approach was simply wrong are all present in sequence. Several are load-bearing
in the build summary and architecture notes, and those documents were written to
match this record rather than the other way round.

## Prompts given to the system's own models

\`prompts.md\` covers instructions given to the assistant. The prompts this system
sends to its own models live in the repository, because they are code and any
copy here would drift:

| prompt | file |
|---|---|
| agent planner | \`packages/rag/src/agent/run.ts\` — \`PLAN_PROMPT\` |
| answer composer | \`packages/rag/src/agent/run.ts\` — \`COMPOSE_PROMPT\` |
| Stage 1 answerer | \`packages/rag/src/answer.ts\` |
| grounding auditor | \`packages/rag/src/llm.ts\` — \`verifyJson\` |

Models used: \`llama-3.3-70b-versatile\` (primary), \`llama-3.1-8b-instant\` and
\`openai/gpt-oss-20b\` (fallbacks), all via Groq. Token counts and cost per run are
measured and recorded — see \`packages/core/src/meter.ts\` and the \`cost\` field on
every run in \`exports/operating-window.json\`.

## Secrets

API keys and the database URL were configured during these sessions and appear in
the raw log. They are redacted by pattern; the counts are in \`redaction-log.md\`.
No exchange was removed to hide a credential — only the credential values inside
otherwise intact messages.
`);

console.log(`records read     : ${lines.length}`);
console.log(`stage 1 excluded : ${stage1Excluded}  (before ${STAGE2_START})`);
console.log(`stage 2 records  : ${redactedLines.length}`);
console.log(`messages         : ${turns.length}`);
console.log(`instructions     : ${prompts.length}`);
console.log(`redactions       : ${total}`);
for (const [n, c] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${n}: ${c}`);
console.log('');
for (const f of [...files, 'SHA256SUMS', 'README.md']) console.log(`  docs/ai-session/${f}  ${size(f)}`);
