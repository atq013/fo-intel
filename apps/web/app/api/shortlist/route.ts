import { NextResponse } from 'next/server';
import { shortlist, type ShortlistQuery } from '@fo/db';

export const dynamic = 'force-dynamic';

/**
 * The retrieval feature as a tool endpoint.
 *
 * Same function the page renders and the agent calls, so what a reviewer sees in
 * the UI and what the agent reasons over cannot drift apart.
 */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const query: ShortlistQuery = {
    q: p.get('q') || undefined,
    country: p.get('country') || undefined,
    requireStrictReachable: p.get('strict') === '1',
    requireProfileAssisted: p.get('assisted') === '1',
    requiredFields: p.get('fields')?.split(',').filter(Boolean),
    freshWithinDays: p.get('freshDays') ? Number(p.get('freshDays')) : undefined,
    maxSourceTier: p.get('tier') ? (Number(p.get('tier')) as 1 | 2 | 3 | 4) : undefined,
    limit: p.get('limit') ? Number(p.get('limit')) : undefined,
    offset: p.get('offset') ? Number(p.get('offset')) : undefined,
  };
  try {
    return NextResponse.json(await shortlist(query));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
