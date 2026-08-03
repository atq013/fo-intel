import { shortlist, type ShortlistQuery } from '@fo/db';

export const dynamic = 'force-dynamic';

/**
 * The retrieval feature, on its own route so it is demonstrable independently of
 * the agent — the brief asks for a link to each.
 *
 * Filters are plain links rather than JS state: the query is in the URL, so any
 * result set a reviewer sees can be copied, shared and reproduced exactly. That
 * matters more here than interactivity.
 */
export default async function Shortlist({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const query: ShortlistQuery = {
    q: sp.q || undefined,
    requireStrictReachable: sp.strict === '1',
    requireProfileAssisted: sp.assisted === '1',
    requiredFields: sp.fields?.split(',').filter(Boolean),
    freshWithinDays: sp.freshDays ? Number(sp.freshDays) : undefined,
    maxSourceTier: sp.tier ? (Number(sp.tier) as 1 | 2 | 3 | 4) : undefined,
    limit: 25,
  };

  const res = await shortlist(query);
  const href = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { ...sp, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    return `/shortlist${p.toString() ? `?${p}` : ''}`;
  };

  return (
    <div className="wrap">
      <header>
        <h1 className="brand">Sightline · shortlist</h1>
        <p className="tagline">
          Filter and rank on fit, evidence grade, freshness and principal-level
          reachability at once and see why each firm matched and what it is missing.
        </p>
      </header>

      <section>
        <h2>Filters</h2>
        <div className="filters">
          {([
            ['all qualifying', href({ strict: undefined, assisted: undefined, fields: undefined, freshDays: undefined, tier: undefined }),
              !sp.strict && !sp.assisted && !sp.fields && !sp.tier && !sp.freshDays],
            ['reachable - strict', href({ strict: '1', assisted: undefined }), sp.strict === '1'],
            ['reachable - incl. profiles', href({ assisted: '1', strict: undefined }), sp.assisted === '1'],
            ['has a principal phone', href({ fields: 'principal.phone' }), sp.fields === 'principal.phone'],
            ['statutory sources only', href({ tier: '1' }), sp.tier === '1'],
            ['observed in last 1d', href({ freshDays: '1' }), sp.freshDays === '1'],
          ] as Array<[string, string, boolean]>).map(([label, url, active]) => (
            <a
              key={label}
              href={url}
              className={active ? 'filter-link is-active' : 'filter-link'}
              aria-current={active ? 'true' : undefined}
            >
              {label}
            </a>
          ))}
        </div>
        <p className="note">
          <strong>Scope.</strong> {res.scope.searched} entities searched ·{' '}
          {res.scope.matched} matched · {res.scope.returned} shown
          {res.scope.appliedFilters.length > 0 && <> · filters: {res.scope.appliedFilters.join('; ')}</>}
        </p>
        {res.scope.excluded.length > 0 && (
          <p className="note">
            <strong>Excluded, with reasons.</strong>{' '}
            {res.scope.excluded.map((e) => `${e.count} - ${e.reason}`).join(' · ')}
          </p>
        )}
      </section>

      <section>
        <h2>Results</h2>
        {res.results.length === 0 && (
          <p className="note">
            Nothing matched. That is an answer, not an error but the exclusion reasons above
            say exactly what was filtered out and why.
          </p>
        )}
        {res.results.map((r) => (
          <div key={r.entityId} className="stat" style={{ marginBottom: '.7rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
              <strong>{r.name}</strong>
              <span className="mono" title="Ranks how well this record matches the filters applied. Not a confidence value.">relevance {r.score.toFixed(3)}</span>
            </div>

            <div className="statNote" style={{ marginTop: '.35rem' }}>
              fit {r.dimensions.fit} · evidence {r.dimensions.evidence} · freshness{' '}
              {r.dimensions.freshness} · reachability {r.dimensions.reachability}
              {r.bestSourceTier != null && <> · best source tier {r.bestSourceTier}</>}
              {r.lastObservedAt && <> · observed {r.lastObservedAt.slice(0, 10)}</>}
            </div>

            {r.contact && (
              <div style={{ marginTop: '.4rem', fontSize: '.84rem' }}>
                <span className="mono">{r.contact.value}</span>{' '}
                <span className="statNote">
                  ({r.contact.channel}, reaches {r.contact.reaches}
                  {r.contact.method && <> - {r.contact.method}</>})
                </span>
              </div>
            )}

            <div className="statNote" style={{ marginTop: '.4rem' }}>
              <strong>why it matched:</strong> {r.matched.join(' · ')}
            </div>
            {r.missing.length > 0 && (
              <div className="statNote" style={{ marginTop: '.2rem' }}>
                <strong>what is missing:</strong> {r.missing.join(' · ')}
              </div>
            )}
          </div>
        ))}
      </section>

      <section>
        <h2>What this cannot do</h2>
        <ul className="note" style={{ paddingLeft: '1.1rem' }}>
          {res.limits.map((l) => (
            <li key={l} style={{ marginBottom: '.3rem' }}>{l}</li>
          ))}
        </ul>
      </section>

      <footer>
        Same function backs <span className="mono">/api/shortlist</span> and the agent&apos;s
        search tool, so the UI and the agent cannot drift apart.
      </footer>
    </div>
  );
}
