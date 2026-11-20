import { NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { createAdminClient } from '@/utils/supabase/server'
import { requireUser } from '@/lib/auth'
import { isValidFullName } from '@/lib/validation'
import { trackRepository, backfillRepo } from '@/lib/commitProcessor'

export const maxDuration = 300;

/**
 * POST /api/repos/track  (form field `repo` = JSON from the dashboard, or JSON body { name })
 * Starts tracking a GitHub repo: saves it, links it to the user, creates the webhook,
 * and imports the latest commits in the background.
 */
export async function POST(request: Request) {
  const isJson = (request.headers.get('content-type') || '').includes('application/json')
  const fail = (msg: string, status: number) =>
    isJson
      ? NextResponse.json({ error: msg }, { status })
      : NextResponse.redirect(new URL(`/dashboard?error=${encodeURIComponent(msg)}`, request.url), 303)

  const auth = await requireUser({ limit: 10, bucket: 'track' })
  if (auth.error) {
    return isJson ? auth.error : NextResponse.redirect(new URL('/login', request.url), 303)
  }
  const user = auth.user

  let name: unknown
  try {
    if (isJson) {
      name = (await request.json()).name
    } else {
      const raw = (await request.formData()).get('repo') as string | null
      name = raw ? JSON.parse(raw).name : null
    }
  } catch {
    return fail('Invalid repository', 400)
  }
  if (!isValidFullName(name)) return fail('Invalid repository name', 400)

  const admin = createAdminClient()
  const { data: profile } = await admin.from('profiles').select('github_token').eq('id', user.id).single()
  if (!profile?.github_token) return fail('Log in with GitHub first so we can read this repository.', 400)

  // Confirm the user can actually read the repo, and get its real metadata from GitHub
  const ghRes = await fetch(`https://api.github.com/repos/${name}`, {
    headers: {
      Authorization: `Bearer ${profile.github_token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'GitSimple-App',
    },
  })
  if (!ghRes.ok) return fail('You do not have access to that repository on GitHub.', 403)
  const gh = await ghRes.json()

  try {
    const tracked = await trackRepository(
      { name: gh.full_name, url: gh.html_url, default_branch: gh.default_branch, private: !!gh.private },
      user.id,
      profile.github_token
    )

    if (!tracked.hasCommits) {
      waitUntil(backfillRepo(tracked.id, gh.full_name, gh.default_branch, 10).then(() => undefined))
    }

    const note =
      tracked.webhook === 'created' || tracked.webhook === 'exists'
        ? 'New pushes will appear automatically.'
        : 'Webhook could not be set up (needs admin access to the repo and WEBHOOK_PROXY_URL); new pushes will not appear automatically.'
    const message = `Tracking ${gh.full_name}. ${tracked.hasCommits ? '' : 'Importing the latest 10 commits, give it a minute. '}${note}`

    if (isJson) return NextResponse.json({ success: true, repositoryId: tracked.id, message })
    return NextResponse.redirect(
      new URL(`/dashboard/timeline?repo=${tracked.id}&message=${encodeURIComponent(message)}`, request.url),
      303
    )
  } catch (e: any) {
    console.error('Track repository error:', e)
    return fail(e?.message || 'Failed to track repository', 500)
  }
}
