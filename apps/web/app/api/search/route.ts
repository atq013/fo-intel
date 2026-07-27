import { NextResponse } from 'next/server';
import { answerQuestion } from '@fo/rag';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
  let question: string;
  try {
    ({ question } = await req.json());
  } catch {
    return NextResponse.json({ error: 'malformed request' }, { status: 400 });
  }

  if (typeof question !== 'string' || question.trim().length < 3) {
    return NextResponse.json({ error: 'Please enter a question.' }, { status: 400 });
  }

  try {
    const result = await answerQuestion(question.trim().slice(0, 400));
    return NextResponse.json(result);
  } catch (err) {
    console.error('search failed', err);
    // The user sees a readable sentence, never a stack trace or raw error.
    return NextResponse.json(
      { error: 'Something went wrong while searching. The records themselves are unaffected — please try again.' },
      { status: 500 },
    );
  }
}
