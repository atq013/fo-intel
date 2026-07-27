import { countFirms } from '@fo/db';
import Search from './search';

export const dynamic = 'force-dynamic';

export default async function Page() {
  let coverage = { total: 0, sfo: 0, withContact: 0 };
  try {
    coverage = await countFirms();
  } catch {
    // The page still works if the count query fails; the search does its own error handling.
  }

  return (
    <div className="wrap">
      <header>
        <h1 className="brand">Sightline</h1>
        <p className="tagline">
          Family office intelligence for capital allocators. Ask in plain English.
        </p>
        <p className="coverage">
          {coverage.total} verified firms · {coverage.sfo} single-family offices ·{' '}
          {coverage.withContact} with a confirmed contact route. Every value shows how it was confirmed.
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
