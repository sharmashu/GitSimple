import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { waitUntil } from '@vercel/functions'
import { createAdminClient } from '@/utils/supabase/server'
import { getTokenForTrackedRepo } from '@/lib/github'
import { processCommits, enqueueBackground } from '@/lib/commitProcessor'

// Allow background processing to keep running after we reply to GitHub (Vercel)
export const maxDuration = 300;

// Verify the GitHub webhook signature in constant time.
function verifySignature(reqBody: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const digest = 'sha256=' + crypto.createHmac('sha256', secret).update(reqBody).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(digest);
  // timingSafeEqual throws if lengths differ, so check first
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    // Never accept unsigned webhooks: anyone could post fake commits
    console.error('GITHUB_WEBHOOK_SECRET is not set; refusing webhook.');
    return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 });
  }

  const rawBody = await request.text();
  if (!verifySignature(rawBody, request.headers.get('x-hub-signature-256'), secret)) {
    return NextResponse.json({ error: 'Unauthorized: Invalid signature' }, { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const eventType = request.headers.get('x-github-event');
  if (eventType === 'ping') {
    return NextResponse.json({ message: 'pong' });
  }
  if (eventType !== 'push') {
    return NextResponse.json({ message: 'Ignored non-push event' });
  }

  const repoFullName: string | undefined = payload.repository?.full_name;
  const branch: string = (payload.ref || '').replace('refs/heads/', '') || 'main';
  const commits: any[] = Array.isArray(payload.commits) ? payload.commits : [];

  if (!repoFullName || payload.deleted || commits.length === 0) {
    return NextResponse.json({ message: 'No commits in push event' });
  }

  try {
    const adminSupabase = createAdminClient();
    const { data: repository } = await adminSupabase
      .from('repositories')
      .select('id')
      .eq('name', repoFullName)
      .maybeSingle();

    if (!repository) {
      return NextResponse.json({ message: 'Repository not tracked' });
    }

    // Reply to GitHub right away (it gives up after 10s) and do the AI work in the background.
    const shas = commits.slice(0, 50).map((c) => c.id).filter(Boolean);
    const work = (async () => {
      const token = await getTokenForTrackedRepo(repository.id);
      await enqueueBackground(() => processCommits(repository.id, repoFullName, branch, shas, token));
    })().catch((e) => console.error('Background commit processing failed:', e));
    waitUntil(work);

    return NextResponse.json({ accepted: true, message: `Processing ${shas.length} commits` }, { status: 202 });
  } catch (error: any) {
    console.error('Webhook error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
