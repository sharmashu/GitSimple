import { NextResponse } from 'next/server'
import { createClient } from '@/utils/supabase/server'
import { safeNext } from '@/lib/site'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = safeNext(searchParams.get('next'))
  const base = (process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || origin).replace(/\/+$/, '')

  if (code) {
    const supabase = createClient()
    const { data, error } = await supabase.auth.exchangeCodeForSession(code)

    if (!error && data?.session) {
      // If they logged in with GitHub, save the provider token to their profile
      // so we can access their private repositories later.
      const providerToken = data.session.provider_token;
      const { createAdminClient } = await import('@/utils/supabase/server')
      const adminAuthClient = createAdminClient()
      const sessionUser = data.session.user

      // Recreate the profile if it was deleted (the login account still exists)
      const { data: existing } = await adminAuthClient
        .from('profiles').select('id').eq('id', sessionUser.id).maybeSingle()
      if (!existing) {
        const metaRole = sessionUser.user_metadata?.role
        const role = ['manager', 'employee', 'intern'].includes(metaRole) ? metaRole : 'manager'
        await adminAuthClient.from('profiles')
          .upsert({ id: sessionUser.id, email: sessionUser.email, role }, { onConflict: 'id' })
      }

      // Save the GitHub username, so a manager's Team Activity page can match their commits
      const githubLogin = sessionUser.user_metadata?.user_name || sessionUser.user_metadata?.preferred_username
      if (githubLogin) {
        await adminAuthClient.from('profiles').update({ github_login: githubLogin }).eq('id', sessionUser.id)
      }

      if (providerToken) {
        await adminAuthClient
          .from('profiles')
          .update({ github_token: providerToken })
          .eq('id', sessionUser.id);
      }

      return NextResponse.redirect(`${base}${next}`)
    }
  }

  // return the user to an error page with instructions
  return NextResponse.redirect(`${base}/login?message=Could not authenticate with provider`)
}
