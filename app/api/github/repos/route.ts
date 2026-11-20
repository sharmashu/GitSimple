import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/utils/supabase/server'
import { fetchUserRepos, fetchPublicReposForUser } from '@/lib/github'

const USERNAME_RE = /^[A-Za-z0-9-]{1,39}$/

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const targetUrl = searchParams.get('url')
    let username = searchParams.get('username')

    // If a URL is provided, try to extract the GitHub username from it
    if (targetUrl) {
      try {
        const urlObj = new URL(targetUrl.startsWith('http') ? targetUrl : `https://${targetUrl}`)
        if (urlObj.hostname === 'github.com' || urlObj.hostname === 'www.github.com') {
          const pathParts = urlObj.pathname.split('/').filter(Boolean)
          if (pathParts.length > 0) username = pathParts[0]
        }
      } catch {
        // Invalid URL, ignore and proceed
      }
    }

    // IF username/url is provided, fetch public repos for that specific user
    if (username) {
      if (!USERNAME_RE.test(username)) {
        return NextResponse.json({ error: 'Invalid GitHub username' }, { status: 400 })
      }
      try {
        return NextResponse.json({ repositories: await fetchPublicReposForUser(username) })
      } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: e.status || 502 })
      }
    }

    // IF NO username/url is provided, require login and fetch their own repos
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Please provide a GitHub URL or log in to view your repositories.' }, { status: 401 })
    }

    const { data: profile } = await createAdminClient()
      .from('profiles')
      .select('github_token')
      .eq('id', user.id)
      .single()

    if (!profile?.github_token) {
      return NextResponse.json({ error: 'GitHub token not found. Please log in with GitHub again.' }, { status: 400 })
    }

    try {
      return NextResponse.json({ repositories: await fetchUserRepos(profile.github_token) })
    } catch (e: any) {
      console.error('GitHub API error:', e)
      return NextResponse.json({ error: 'Failed to fetch repositories from GitHub' }, { status: 502 })
    }
  } catch (error: any) {
    console.error('Error fetching GitHub repos:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
