import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Export the complete user-visible portion of a Codex Desktop rollout.
 *
 * Codex rollout files contain two copies of most visible messages plus private
 * system instructions, internal reasoning, token telemetry and encrypted
 * compaction state. Those are application internals, not additional user or
 * assistant turns. This exporter keeps one canonical copy of every visible
 * user message, assistant message, tool call, tool result and abort event, in
 * source order. It never exports hidden reasoning or system/developer prompts.
 *
 * Required environment variable:
 *   CODEX_TRANSCRIPT       absolute path to the rollout JSONL
 *
 * Optional environment variables:
 *   CODEX_SESSION_START    inclusive ISO timestamp
 *   CODEX_SESSION_END      inclusive ISO timestamp; omit for the current end
 *   CODEX_SESSION_OUT      output directory relative to this file or absolute
 */

const START = process.env.CODEX_SESSION_START ?? '2026-08-13T08:55:10.049Z';
const END = process.env.CODEX_SESSION_END;
const SRC = process.env.CODEX_TRANSCRIPT;
if (!SRC) throw new Error('CODEX_TRANSCRIPT is required');

const OUT_SPEC = process.env.CODEX_SESSION_OUT ?? '../../../../docs/final-question-codex-session/';
const OUT = OUT_SPEC.startsWith('/')
  ? `${OUT_SPEC.replace(/\/$/, '')}/`
  : fileURLToPath(new URL(OUT_SPEC.endsWith('/') ? OUT_SPEC : `${OUT_SPEC}/`, import.meta.url));
mkdirSync(OUT, { recursive: true });

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = Record<string, any>;

interface VisibleRecord {
  timestamp: string;
  type: 'user' | 'assistant' | 'tool_call' | 'tool_output' | 'event';
  role?: 'user' | 'assistant';
  phase?: string;
  message?: string;
  tool?: string;
  callId?: string;
  input?: Json;
  output?: Json;
  event?: string;
  detail?: Json;
}

const secretPatterns: Array<{ name: string; re: RegExp }> = [
  { name: 'postgres connection string', re: /postgres(?:ql)?:\/\/[^\s"'`]+/gi },
  { name: 'OpenAI-style API key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'Groq API key', re: /\bgsk_[A-Za-z0-9]{20,}\b/g },
  { name: 'Google API key', re: /\bAIza[A-Za-z0-9_-]{30,}\b/g },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: 'Bearer token', re: /\bBearer\s+[A-Za-z0-9._-]{20,}/g },
  { name: 'Basic auth header', re: /\bBasic\s+[A-Za-z0-9+/=]{20,}/g },
  {
    name: 'environment assignment of a secret',
    re: /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|DSN|DATABASE_URL)[A-Z0-9_]*)\s*=\s*["']?([^\s"'\n]{16,})["']?/g,
  },
];

const redactions = new Map<string, number>();

function noteRedaction(name: string): void {
  redactions.set(name, (redactions.get(name) ?? 0) + 1);
}

function redactText(value: string): string {
  // One diagnostic command printed Codex rollout metadata that contains private
  // base/developer instructions. Preserve the rest of that tool result and
  // replace only the affected output lines; hidden instructions must not be
  // republished through a diagnostic log.
  if (/"(?:base_instructions|developer_instructions)"\s*:/.test(value)) {
    const lines = value.split('\n');
    const safeLines = lines.map((line) => {
      if (!/"(?:base_instructions|developer_instructions)"\s*:/.test(line)) return line;
      noteRedaction('tool-output line containing private instruction metadata');
      return '[PRIVATE INSTRUCTION METADATA LINE OMITTED]';
    });
    value = safeLines.join('\n');
  }

  let safe = value;
  for (const { name, re } of secretPatterns) {
    re.lastIndex = 0;
    safe = safe.replace(re, (_match, variableName) => {
      noteRedaction(name);
      return name === 'environment assignment of a secret'
        ? `${String(variableName)}=[REDACTED]`
        : '[REDACTED]';
    });
  }
  return safe;
}

function sanitize(value: any): Json {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value !== 'object') return String(value);

  const out: Record<string, Json> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'internal_chat_message_metadata_passthrough') continue;
    out[key] = sanitize(child);
  }
  return out;
}

function inWindow(timestamp: string): boolean {
  if (!timestamp || timestamp < START) return false;
  return !END || timestamp <= END;
}

function visibleRecord(record: Obj): VisibleRecord | undefined {
  const timestamp = String(record.timestamp ?? '');
  if (!inWindow(timestamp)) return undefined;

  const payload = record.payload ?? {};

  // event_msg is the canonical, non-duplicated representation of visible user
  // and assistant messages. response_item contains a second copy.
  if (record.type === 'event_msg' && payload.type === 'user_message') {
    return {
      timestamp,
      type: 'user',
      role: 'user',
      message: redactText(String(payload.message ?? '')),
      detail: sanitize({
        images: payload.images ?? [],
        localImages: payload.local_images ?? [],
        audio: payload.audio ?? [],
        localAudio: payload.local_audio ?? [],
      }),
    };
  }

  if (record.type === 'event_msg' && payload.type === 'agent_message') {
    return {
      timestamp,
      type: 'assistant',
      role: 'assistant',
      phase: String(payload.phase ?? ''),
      message: redactText(String(payload.message ?? '')),
    };
  }

  if (record.type === 'event_msg' && payload.type === 'turn_aborted') {
    return {
      timestamp,
      type: 'event',
      event: 'turn_aborted',
      detail: sanitize(payload),
    };
  }

  if (record.type !== 'response_item') return undefined;

  if (payload.type === 'custom_tool_call') {
    return {
      timestamp,
      type: 'tool_call',
      tool: String(payload.name ?? 'tool'),
      callId: String(payload.call_id ?? ''),
      input: sanitize(payload.input ?? null),
    };
  }

  if (payload.type === 'custom_tool_call_output') {
    return {
      timestamp,
      type: 'tool_output',
      callId: String(payload.call_id ?? ''),
      output: sanitize(payload.output ?? null),
    };
  }

  if (payload.type === 'function_call') {
    return {
      timestamp,
      type: 'tool_call',
      tool: String(payload.name ?? 'function'),
      callId: String(payload.call_id ?? ''),
      input: sanitize(payload.arguments ?? null),
    };
  }

  if (payload.type === 'function_call_output') {
    return {
      timestamp,
      type: 'tool_output',
      callId: String(payload.call_id ?? ''),
      output: sanitize(payload.output ?? null),
    };
  }

  return undefined;
}

const source = readFileSync(SRC, 'utf8');
const sourceLines = source.split('\n').filter((line) => line.trim());
const parsed: Obj[] = sourceLines.map((line, index) => {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`invalid JSONL at source line ${index + 1}: ${String(error)}`);
  }
});

const visible = parsed.map(visibleRecord).filter((record): record is VisibleRecord => Boolean(record));
if (!visible.length) throw new Error(`no visible records found at or after ${START}`);
const firstVisible = visible[0]!;
const lastVisible = visible[visible.length - 1]!;

const prompts = visible.filter((record) => record.type === 'user');
const models = new Map<string, number>();
const efforts = new Map<string, number>();
for (const record of parsed) {
  const timestamp = String(record.timestamp ?? '');
  if (!inWindow(timestamp) || record.type !== 'turn_context') continue;
  const model = String(record.payload?.model ?? 'unknown');
  const effort = String(
    record.payload?.effort
      ?? record.payload?.collaboration_mode?.settings?.reasoning_effort
      ?? 'unknown',
  );
  models.set(model, (models.get(model) ?? 0) + 1);
  efforts.set(effort, (efforts.get(effort) ?? 0) + 1);
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function block(value: unknown): string {
  const text = typeof value === 'string' ? value : json(value);
  return `~~~~text\n${text}\n~~~~`;
}

writeFileSync(
  `${OUT}transcript-raw.jsonl`,
  `${visible.map((record) => JSON.stringify(record)).join('\n')}\n`,
);

let transcript = '# Codex user-visible working-session transcript\n\n'
  + 'Complete canonical sequence of visible user messages, assistant messages, tool calls and tool\n'
  + 'results in the stated task window. Duplicate transport records, private system/developer\n'
  + 'instructions, hidden reasoning, telemetry and encrypted application state are not conversation\n'
  + 'turns and are not published. No visible exchange is selected out.\n\n'
  + `**First visible record:** ${firstVisible.timestamp}  \n`
  + `**Last visible record:** ${lastVisible.timestamp}  \n`
  + `**Visible records:** ${visible.length}\n\n---\n`;

let currentDay = '';
for (const record of visible) {
  const day = record.timestamp.slice(0, 10);
  if (day !== currentDay) {
    currentDay = day;
    transcript += `\n## ${day}\n`;
  }

  if (record.type === 'user' || record.type === 'assistant') {
    const label = record.type === 'user' ? 'Operator' : 'Codex';
    transcript += `\n### ${label} · ${record.timestamp}`
      + `${record.phase ? ` · ${record.phase}` : ''}\n\n${record.message ?? ''}\n`;
  } else if (record.type === 'tool_call') {
    transcript += `\n### Tool call · ${record.timestamp} · ${record.tool ?? 'tool'}\n\n`
      + `${block(record.input)}\n`;
  } else if (record.type === 'tool_output') {
    transcript += `\n### Tool output · ${record.timestamp} · ${record.callId ?? ''}\n\n`
      + `${block(record.output)}\n`;
  } else {
    transcript += `\n### Event · ${record.timestamp} · ${record.event}\n\n${block(record.detail)}\n`;
  }
}
writeFileSync(`${OUT}transcript.md`, transcript);

let promptDocument = '# Every Codex instruction, quoted as entered\n\n'
  + 'Every operator message in the task window, in chronological order. Tool outputs are preserved in\n'
  + '`transcript-raw.jsonl` and `transcript.md`, not repeated here.\n\n'
  + `**Instructions:** ${prompts.length}  \n`
  + `**First:** ${prompts[0]?.timestamp ?? '—'}  \n`
  + `**Last:** ${prompts.at(-1)?.timestamp ?? '—'}\n\n---\n`;
for (const [index, prompt] of prompts.entries()) {
  promptDocument += `\n### ${index + 1} · ${prompt.timestamp}\n\n`
    + `${String(prompt.message ?? '').split('\n').map((line) => `> ${line}`).join('\n')}\n`;
}
writeFileSync(`${OUT}prompts.md`, promptDocument);

const totalRedactions = [...redactions.values()].reduce((sum, count) => sum + count, 0);
let redactionLog = '# Codex session redaction log\n\n'
  + 'No visible user message, assistant message, tool call or tool result was removed. Secret values\n'
  + 'were replaced in place. Private system/developer instruction metadata accidentally surfaced by\n'
  + 'a diagnostic tool command is also withheld; it is not part of the user/assistant conversation.\n\n'
  + `**Total replacements:** ${totalRedactions}\n\n`
  + '| pattern | occurrences |\n|---|---:|\n';
for (const [name, count] of [...redactions.entries()].sort((a, b) => b[1] - a[1])) {
  redactionLog += `| ${name} | ${count} |\n`;
}
if (!redactions.size) redactionLog += '| none | 0 |\n';
writeFileSync(`${OUT}redaction-log.md`, redactionLog);

const sourceHash = createHash('sha256').update(source).digest('hex');
const typeCounts = visible.reduce<Record<string, number>>((counts, record) => {
  counts[record.type] = (counts[record.type] ?? 0) + 1;
  return counts;
}, {});
const meta = {
  generatedAt: new Date().toISOString(),
  sourceFile: basename(SRC),
  sourceBytes: statSync(SRC).size,
  sourceSha256AtExport: sourceHash,
  startInclusive: START,
  endInclusive: END ?? null,
  firstVisibleRecord: firstVisible.timestamp,
  lastVisibleRecord: lastVisible.timestamp,
  visibleRecordCount: visible.length,
  typeCounts,
  promptCount: prompts.length,
  modelTurnCounts: Object.fromEntries(models),
  reasoningEffortTurnCounts: Object.fromEntries(efforts),
  redactionCount: totalRedactions,
};
writeFileSync(`${OUT}session-meta.json`, `${json(meta)}\n`);

const readme = `# Codex working-session record — Final Question

The complete **user-visible** Codex record for the Final Question task, starting with the first
message concerning Brian's question on 13 August 2026. It preserves every visible user message,
Codex response, tool call, tool result and abort event in source order.

## Boundary

- Start: \`${START}\` — the message attaching \`Final Question Attique.docx\`.
- End: ${END ? `\`${END}\` (explicit inclusive boundary).` : 'the latest complete record present when the exporter was run.'}
- The earlier product-review conversation is outside this task boundary.
- Nothing inside the boundary is selected out for relevance or presentation.

## Model

Session metadata records **GPT-5.6 Sol** (\`gpt-5.6-sol\`) with reasoning effort **\`xhigh\`**
("extra high") for the turns in this export. Codex was used as an additional reviewer: it assessed
earlier candidates, explained and separately re-ran checks of the operating-log issue after Claude
found it, and audited the final evidence and documents. That review came after Claude's work and
with sight of it, so it is a second pass rather than an independent one. Claude found and
implemented the selected fix.

## Files

| file | purpose |
|---|---|
| \`transcript-raw.jsonl\` | canonical user-visible records, one JSON object per line |
| \`transcript.md\` | the same records in readable chronological form |
| \`prompts.md\` | every operator message quoted as entered |
| \`session-meta.json\` | boundary, source hash, counts, model and effort metadata |
| \`redaction-log.md\` | every credential/internal-metadata replacement by class |
| \`CONTRIBUTION_INDEX.md\` | short navigation summary; not a replacement for the transcript |
| \`SHA256SUMS\` | integrity hashes for the exported files |

## What “user-visible” means

The Codex rollout stores duplicate message transports plus private system/developer instructions,
hidden reasoning, token telemetry and encrypted compaction state. Those are not AI responses shown
to the operator and are not exported. One canonical copy of every visible exchange and tool event
is included. Secret values are replaced in place; no visible exchange is deleted.

Verify from this directory with:

\`shasum -a 256 -c SHA256SUMS\`
`;
writeFileSync(`${OUT}README.md`, readme);

const hashFiles = [
  'transcript-raw.jsonl',
  'transcript.md',
  'prompts.md',
  'session-meta.json',
  'redaction-log.md',
  'CONTRIBUTION_INDEX.md',
].filter((file) => existsSync(`${OUT}${file}`));
const hashes = hashFiles.map((file) => {
  const value = readFileSync(`${OUT}${file}`);
  return `${createHash('sha256').update(value).digest('hex')}  ${file}`;
});
writeFileSync(`${OUT}SHA256SUMS`, `${hashes.join('\n')}\n`);

// Defence-in-depth scan for common credential shapes after redaction.
const published = hashFiles.map((file) => readFileSync(`${OUT}${file}`, 'utf8')).join('\n');
const leakedPatterns = [
  /postgres(?:ql)?:\/\/[^\s"'`]+/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgsk_[A-Za-z0-9]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
];
if (leakedPatterns.some((pattern) => pattern.test(published))) {
  throw new Error('credential-shaped value survived the Codex session export');
}

console.log(`source records      : ${sourceLines.length}`);
console.log(`visible records     : ${visible.length}`);
console.log(`operator messages   : ${prompts.length}`);
console.log(`first visible       : ${firstVisible.timestamp}`);
console.log(`last visible        : ${lastVisible.timestamp}`);
console.log(`models              : ${json(Object.fromEntries(models))}`);
console.log(`reasoning efforts   : ${json(Object.fromEntries(efforts))}`);
console.log(`redactions          : ${totalRedactions}`);
console.log(`output              : ${OUT}`);
