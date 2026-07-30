import { NextResponse } from 'next/server';
import { runAgent } from '@fo/rag';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The agent endpoint. Returns the answer AND the raw trace — every plan, tool
 * call, scope and block decision — because the brief asks for raw traces and a
 * trace produced on request is more credible than one written afterwards.
 */
export async function POST(req: Request) {
  try {
    const { question } = (await req.json()) as { question?: string };
    if (!question?.trim()) {
      return NextResponse.json({ error: 'question is required' }, { status: 400 });
    }
    return NextResponse.json(await runAgent(question.trim()));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
