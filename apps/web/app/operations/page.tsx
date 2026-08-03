import {
  contractStats, gateOutcomes, recentRuns, recentDecisions, recentQuarantines,
} from '@fo/db';

export const dynamic = 'force-dynamic';

/**
 * The operating view.
 *
 * Deliberately not a dashboard of green ticks. The brief asks for evidence that
 * the system ran unattended, handled failure, and detected real change — so the
 * page leads with what was refused and what changed, because those are the
 * numbers that are hard to fake and easy to check.
 *
 * Stage 1's page at `/` is untouched.
 */
export default async function Operations() {
  const [stats, gates, runs, decisions, quarantines] = await Promise.all([
    contractStats(), gateOutcomes(), recentRuns(12), recentDecisions(12), recentQuarantines(12),
  ]);

  const scheduled = runs.filter((r) => r.trigger === 'schedule').length;

  return (
    <div className="wrap">
      <header>
        <h1 className="brand">Sightline · operations</h1>
        <p className="tagline">
          What the pipeline did, what it refused, and why. Every number here is a query
          against the same tables the product reads.
        </p>
      </header>

      <section>
        <h2>Contract</h2>
        <div className="grid">
          <Stat label="entities" value={stats.entities} />
          <Stat label="qualifying" value={stats.qualifying} note="passes the commercial floor" />
          <Stat label="claims released" value={stats.released} />
          <Stat label="quarantined" value={stats.quarantined} note="failed a gate" />
          <Stat label="held" value={stats.held} note="a gate was skipped, so not proven" />
        </div>
        <p className="note">
          Reachability is reported as three separate figures and never merged into one
          (ADR-11, ADR-12). <strong>{stats.strictReachable}</strong> strict — a phone or
          personal email, profiles excluded. <strong>{stats.profileAssistedReachable}</strong>{' '}
          profile-assisted — the above plus a verified personal profile, under assumption A1.{' '}
          <strong>{stats.postalReachable}</strong> postal — an adjudicated statutory service
          address that is neither the company&rsquo;s registered office nor shared with another
          director. A reviewer who rejects A1 should read the first number; one who does not
          accept a postal address as a route to a person should ignore the third.
        </p>
      </section>

      <section>
        <h2>Scheduled operation</h2>
        <p className="note">
          {stats.scheduledRuns} scheduled run{stats.scheduledRuns === 1 ? '' : 's'} recorded
          {stats.windowHours != null && <> · spanning {stats.windowHours}h</>}.
          Manual runs are excluded from the window: a run a human started cannot evidence
          unattended operation.
        </p>
        <table>
          <thead>
            <tr><th>run</th><th>job</th><th>trigger</th><th>status</th><th>touched</th><th>released</th><th>quarantined</th><th>started</th></tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.id.slice(4, 22)}</td>
                <td>{r.job}</td>
                <td>{r.trigger === 'schedule' ? <strong>schedule</strong> : r.trigger}</td>
                <td>{r.status}</td>
                <td>{r.records_touched}</td>
                <td>{r.claims_released}</td>
                <td>{r.claims_quarantined}</td>
                <td className="mono">{new Date(r.started_at).toISOString().slice(0, 16).replace('T', ' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {scheduled === 0 && (
          <p className="note">
            No scheduled run has fired yet. The workflows are configured; the window
            starts at the first one.
          </p>
        )}
      </section>

      <section>
        <h2>What the gates refused</h2>
        <p className="note">
          The part of this that is worth paying for is not the records that passed. It is
          these — specific defects caught before they reached a customer.
        </p>
        <table>
          <thead><tr><th>firm</th><th>field</th><th>value</th><th>gate</th><th>why</th></tr></thead>
          <tbody>
            {quarantines.map((q, i) => (
              <tr key={i}>
                <td>{q.canonical_name}</td>
                <td className="mono">{q.field}</td>
                <td className="mono">{q.value}</td>
                <td>{q.failed}</td>
                <td>{q.reason}</td>
              </tr>
            ))}
            {!quarantines.length && <tr><td colSpan={5}>nothing quarantined yet</td></tr>}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Gate outcomes</h2>
        <p className="note">
          `skipped` is recorded separately from `passed` on purpose: a gate that did not
          run must never be able to look like a gate that agreed (PTC-2).
        </p>
        <table>
          <thead><tr><th>gate</th><th>outcome</th><th>n</th></tr></thead>
          <tbody>
            {gates.map((g, i) => (
              <tr key={i}><td className="mono">{g.gate}</td><td>{g.outcome}</td><td>{g.n}</td></tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Decisions</h2>
        <table>
          <thead><tr><th>when</th><th>kind</th><th>rule</th><th>reason</th></tr></thead>
          <tbody>
            {decisions.map((d, i) => (
              <tr key={i}>
                <td className="mono">{new Date(d.at).toISOString().slice(0, 16).replace('T', ' ')}</td>
                <td>{d.kind}</td>
                <td className="mono">{d.rule}</td>
                <td>{d.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <footer>
        A claim reaches `released` through one function and leaves a decision row naming
        the gates that ran. A released claim without one fails the build.
      </footer>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="stat">
      <div className="statValue">{value}</div>
      <div className="statLabel">{label}</div>
      {note && <div className="statNote">{note}</div>}
    </div>
  );
}
