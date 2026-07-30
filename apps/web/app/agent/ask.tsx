'use client';

import { useState } from 'react';

interface Trace { step: number; kind: string; detail: unknown; at: string }
interface AgentAnswer {
  answer: string;
  unhonouredConstraints: string[];
  blocked: boolean;
  blockReason?: string;
  toolsUsed: string[];
  scope: Record<string, unknown>[];
  trace: Trace[];
  nameCorrections?: Array<{ wrote: string; stored: string }>;
  error?: string;
}

const EXAMPLES = [
  'Which family offices can I reach by phone at a named individual?',
  'How many firms have a principal phone number, and how many do not?',
  'List family offices with assets under management over $1bn',
  'What evidence backs the contact route for Boston Family Office?',
];

export default function Ask() {
  const [question, setQuestion] = useState('');
  const [res, setRes] = useState<AgentAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [showTrace, setShowTrace] = useState(false);

  async function ask(q: string) {
    if (!q.trim() || busy) return;
    setBusy(true);
    setRes(null);
    setShowTrace(false);
    try {
      const r = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      setRes(await r.json());
    } catch (err) {
      setRes({
        answer: '', unhonouredConstraints: [], blocked: false, toolsUsed: [], scope: [], trace: [],
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section>
        <form
          onSubmit={(e) => { e.preventDefault(); void ask(question); }}
          style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}
        >
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask about the family office dataset"
            style={{
              flex: '1 1 320px', padding: '.55rem .7rem', fontSize: '.9rem',
              background: 'transparent', color: 'inherit',
              border: '1px solid var(--line, #2a2a2a)', borderRadius: '6px',
            }}
          />
          <button
            type="submit"
            disabled={busy}
            style={{
              padding: '.55rem 1rem', fontSize: '.9rem', borderRadius: '6px', cursor: 'pointer',
              border: '1px solid var(--line, #2a2a2a)', background: 'transparent', color: 'inherit',
            }}
          >
            {busy ? 'working…' : 'ask'}
          </button>
        </form>

        <p className="note" style={{ marginTop: '.6rem' }}>
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => { setQuestion(ex); void ask(ex); }}
              style={{
                display: 'block', textAlign: 'left', marginBottom: '.25rem', padding: 0,
                background: 'none', border: 'none', color: 'inherit', opacity: 0.75,
                cursor: 'pointer', fontSize: '.82rem', textDecoration: 'underline',
              }}
            >
              {ex}
            </button>
          ))}
        </p>
        <p className="note">
          The third example is deliberate: the dataset holds no AUM claim, so the agent
          must say so rather than answer a different question. That refusal is the
          feature.
        </p>
      </section>

      {res && (
        <section>
          <h2>Answer</h2>
          {res.error && <p className="note">Error: {res.error}</p>}

          {res.blocked && (
            <p className="note" style={{ borderLeft: '2px solid currentColor', paddingLeft: '.6rem' }}>
              <strong>Answer was blocked and rewritten.</strong> {res.blockReason}. The composer
              produced text that did not surface a constraint the planner had already recorded as
              unhonourable, so control flow replaced it. This check is code, not a prompt.
            </p>
          )}

          {res.answer && (
            <p style={{ whiteSpace: 'pre-wrap', fontSize: '.92rem', lineHeight: 1.6 }}>{res.answer}</p>
          )}

          {(res.nameCorrections?.length ?? 0) > 0 && (
            <p className="note">
              <strong>Firm names corrected to their stored spelling:</strong>{' '}
              {res.nameCorrections!.map((c) => `"${c.wrote}" → ${c.stored}`).join(' · ')}.
              Names are resolved server-side from the entity id, so the model cannot
              invent one.
            </p>
          )}

          {res.unhonouredConstraints.length > 0 && (
            <p className="note">
              <strong>Constraints it could not honour:</strong>{' '}
              {res.unhonouredConstraints.join(' · ')}
            </p>
          )}

          {res.toolsUsed.length > 0 && (
            <p className="note">
              <strong>Tools used:</strong> {res.toolsUsed.join(', ')}
              {res.scope.map((s, i) => (
                <span key={i} className="mono" style={{ display: 'block', marginTop: '.2rem' }}>
                  {JSON.stringify(s)}
                </span>
              ))}
            </p>
          )}

          <p className="note">
            <button
              onClick={() => setShowTrace((v) => !v)}
              style={{
                background: 'none', border: 'none', color: 'inherit', padding: 0,
                cursor: 'pointer', textDecoration: 'underline', fontSize: '.82rem',
              }}
            >
              {showTrace ? 'hide' : 'show'} raw trace ({res.trace.length} steps)
            </button>
          </p>

          {showTrace && (
            <pre
              className="mono"
              style={{
                overflowX: 'auto', fontSize: '.7rem', lineHeight: 1.5, padding: '.6rem',
                border: '1px solid var(--line, #2a2a2a)', borderRadius: '6px',
              }}
            >
              {res.trace.map((t) => `#${t.step} ${t.kind} @${t.at}\n${JSON.stringify(t.detail, null, 2)}`).join('\n\n')}
            </pre>
          )}
        </section>
      )}
    </>
  );
}
