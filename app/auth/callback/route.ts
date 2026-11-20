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

      if (providerToken) {
        const { createAdminClient } = await import('@/utils/supabase/server')
        const adminAuthClient = createAdminClient()

        await adminAuthClient
          .from('profiles')
          .update({ github_token: providerToken })
          .eq('id', data.session.user.id);
      }

      return NextResponse.redirect(`${base}${next}`)
    }
  }

  // return the user to an error page with instructions
  return NextResponse.redirect(`${base}/login?message=Could not authenticate with provider`)
}
