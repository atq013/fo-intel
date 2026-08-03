import { countFirms, contractStats } from '@fo/db';
import Search from './search';

export const dynamic = 'force-dynamic';

export default async function Page() {
  // Two datasets, and the front page was quietly reporting the smaller one.
  //
  // `countFirms` counts the Stage 1 corpus -- 50 records -- which is what the
  // plain-English answerer below is embedded over. The product now holds 603
  // qualifying records, served by the shortlist and the agent. Showing "50
  // verified firms" on the front door understated the file by an order of
  // magnitude; showing 603 above a search that only reaches 50 would have been
  // the opposite error. Both are shown, each labelled with what it covers.
  let corpus = { total: 0, sfo: 0, withContact: 0 };
  let dataset = { qualifying: 0, strictReachable: 0, profileAssistedReachable: 0, postalReachable: 0 };
  try {
    [corpus, dataset] = await Promise.all([countFirms(), contractStats()]);
  } catch {
    // The page still works if a count query fails; search handles its own errors.
  }

  return (
    <div className="wrap">
      <header>
        <h1 className="brand">Sightline</h1>
        <p className="tagline">
          Family office intelligence for capital allocators. Ask in plain English.
        </p>
        <p className="coverage">
          <strong>{dataset.qualifying}</strong> qualifying firms, every value carrying the
          evidence that established it. Reachable at a named individual:{' '}
          <strong>{dataset.strictReachable}</strong> by phone or personal email,{' '}
          <strong>{dataset.profileAssistedReachable}</strong> counting verified personal
          profiles, <strong>{dataset.postalReachable}</strong> by adjudicated service address.
          These three are reported separately and never added together.
        </p>
        <p className="coverage">
          The plain-English search below answers over the original {corpus.total}-record
          corpus. To search all {dataset.qualifying}, use{' '}
          <a href="/shortlist">Shortlist</a> for filters or <a href="/agent">Agent</a> for
          multi-step questions.
        </p>
      </header>
      <Search />
      <footer>
        Records are included only where evidence establishes what the firm is. Where a
        value could not be confirmed it is left blank rather than estimated, and where
        sources disagreed the claim is withheld.
      </footer>
    </div>
  );
}
