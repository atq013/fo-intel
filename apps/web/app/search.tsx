'use client';

import { useState } from 'react';

interface Firm {
  id: string;
  name: string;
  type: string;
  typeConfidence: number;
  location: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  principal: string | null;
  principalTitle: string | null;
  principalControl: string | null;
  otherPrincipals: Array<{ name: string; title: string }>;
  address: string | null;
  latestSignal: { summary: string; date: string } | null;
  basis: Record<string, string>;
}

interface Result {
  answered: boolean;
  declineReason: string | null;
  claims: Array<{ text: string }>;
  droppedClaims: Array<{ text: string; reason: string }>;
  firms: Firm[];
  totalMatching: number;
  parsed: { appliedFilters: string[] };
  error?: string;
}

const EXAMPLES = [
  'Single-family offices in the United Kingdom',
  'Which firms have filed recently?',
  'Family offices I can actually reach by phone',
  'Who runs Duquesne Family Office?',
];

const TYPE_LABEL: Record<string, string> = {
  single_family_office: 'Single-family office',
  multi_family_office: 'Multi-family office',
};

function formatDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function Search() {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);

  async function run(q: string) {
    if (!q.trim() || loading) return;
    setQuestion(q);
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      setResult(await res.json());
    } catch {
      setResult({
        answered: false,
        declineReason: null,
        claims: [],
        droppedClaims: [],
        firms: [],
        totalMatching: 0,
        parsed: { appliedFilters: [] },
        error: 'Could not reach the search service. Please try again.',
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(question);
        }}
      >
        <input
          type="search"
          value={question}
          placeholder="e.g. single-family offices in the UK"
          onChange={(e) => setQuestion(e.target.value)}
          aria-label="Ask about family offices"
        />
        <button type="submit" disabled={loading}>
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>

      <div className="examples">
        {EXAMPLES.map((e) => (
          <button key={e} type="button" onClick={() => void run(e)}>
            {e}
          </button>
        ))}
      </div>

      {loading && <p style={{ color: 'var(--ink-faint)' }}>Checking records and verifying the answer…</p>}

      {result?.error && (
        <div className="notice">
          <strong>Search unavailable</strong>
          {result.error}
        </div>
      )}

      {result && !result.error && (
        <>
          {result.parsed.appliedFilters.length > 0 && (
            <div className="filters">
              {result.parsed.appliedFilters.map((f) => (
                <span className="filter" key={f}>
                  {f}
                </span>
              ))}
            </div>
          )}

          {!result.answered && (
            <div className="notice">
              <strong>No answer from the records</strong>
              {result.declineReason ??
                'There is not enough in the dataset to answer that reliably.'}
              {result.droppedClaims.length > 0 && (
                <p style={{ marginBottom: 0, marginTop: 10 }}>
                  {result.droppedClaims.length} draft statement
                  {result.droppedClaims.length === 1 ? ' was' : 's were'} removed for not being
                  supported by the underlying records.
                </p>
              )}
            </div>
          )}

          {result.answered && (
            <>
              <div className="answer">
                <ul>
                  {result.claims.map((c, i) => (
                    <li key={i}>{c.text}</li>
                  ))}
                </ul>
              </div>

              {/* Only meaningful when a structured filter ran. Without one the
                  count is every firm in the file, which reads as a total for the
                  question the user actually asked. */}
              {result.parsed.appliedFilters.length > 0 &&
                result.totalMatching > result.firms.length && (
                  <p className="more">
                    Showing {result.firms.length} of {result.totalMatching} firms matching{' '}
                    {result.parsed.appliedFilters.join(' and ')}. Narrow the question to see others.
                  </p>
                )}

              {result.firms.map((f) => (
                <article className="card" key={f.id}>
                  <div className="card-top">
                    <h3>{f.name}</h3>
                    <span className="type">{TYPE_LABEL[f.type] ?? f.type}</span>
                  </div>
                  {f.location && <p className="loc">{f.location}</p>}

                  <div className="rows">
                    {f.principal && (
                      <div className="row">
                        <span className="k">Principal</span>
                        <span className="v">
                          {f.principal}
                          {f.principalTitle ? ` — ${f.principalTitle}` : ''}
                          {f.principalControl && (
                            <span style={{ display: 'block', color: 'var(--ink-faint)', fontSize: 13 }}>
                              {f.principalControl}
                            </span>
                          )}
                        </span>
                      </div>
                    )}
                    {f.otherPrincipals.length > 0 && (
                      <div className="row">
                        <span className="k">Also</span>
                        <span className="v">
                          {f.otherPrincipals.map((o) => (
                            <span key={o.name} style={{ display: 'block' }}>
                              {o.name}
                              {o.title ? ` — ${o.title}` : ''}
                            </span>
                          ))}
                        </span>
                      </div>
                    )}
                    {f.address && (
                      <div className="row">
                        <span className="k">Address</span>
                        <span className="v">{f.address}</span>
                      </div>
                    )}
                    {f.phone && (
                      <div className="row">
                        <span className="k">Phone</span>
                        <span className="v">
                          <a href={`tel:${f.phone.replace(/[^\d+]/g, '')}`}>{f.phone}</a>
                        </span>
                      </div>
                    )}
                    {f.email && (
                      <div className="row">
                        <span className="k">Email</span>
                        <span className="v">
                          <a href={`mailto:${f.email}`}>{f.email}</a>
                        </span>
                      </div>
                    )}
                    {f.website && (
                      <div className="row">
                        <span className="k">Website</span>
                        <span className="v">
                          <a href={f.website} target="_blank" rel="noreferrer noopener">
                            {f.website.replace(/^https?:\/\//, '')}
                          </a>
                        </span>
                      </div>
                    )}
                    {!f.phone && !f.email && (
                      <div className="row">
                        <span className="k">Direct line</span>
                        <span className="v" style={{ color: 'var(--ink-faint)' }}>
                          No phone or email published for this firm. Reachable at the
                          registered address above.
                        </span>
                      </div>
                    )}
                  </div>

                  {f.latestSignal && (
                    <div className="signal">
                      {f.latestSignal.summary}
                      <div className="when">{formatDate(f.latestSignal.date)}</div>
                    </div>
                  )}

                  {Object.keys(f.basis).length > 0 && (
                    <details className="basis">
                      <summary>How this was confirmed</summary>
                      <dl>
                        {Object.entries(f.basis).map(([field, how]) => (
                          <div key={field}>
                            <dt>{field}</dt>
                            <dd>{how}</dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                  )}
                </article>
              ))}

              {result.droppedClaims.length > 0 && (
                <div className="audit">
                  {result.droppedClaims.length} draft statement
                  {result.droppedClaims.length === 1 ? '' : 's'} did not survive verification
                  against the records and {result.droppedClaims.length === 1 ? 'was' : 'were'} removed
                  before this answer was shown.
                </div>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
