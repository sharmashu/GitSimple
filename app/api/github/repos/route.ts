import { NextResponse } from 'next/server'
import { createClient } from '@/utils/supabase/server'
import { createAdminClient } from '@/utils/supabase/server'

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const targetUrl = searchParams.get('url')
    let username = searchParams.get('username')

    // If a URL is provided, try to extract the GitHub username from it
    if (targetUrl) {
      try {
        const urlObj = new URL(targetUrl.startsWith('http') ? targetUrl : `https://${targetUrl}`)
        if (urlObj.hostname.includes('github.com')) {
          const pathParts = urlObj.pathname.split('/').filter(Boolean)
          if (pathParts.length > 0) {
            username = pathParts[0] // The first part of the path is usually the username/org
          }
        }
      } catch (e) {
        // Invalid URL, ignore and proceed
      }
    }

    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()

    // IF username/url is provided, fetch public repos for that specific user
    if (username) {
      const githubResponse = await fetch(`https://api.github.com/users/${username}/repos?per_page=100`, {
        headers: {
          Accept: 'application/vnd.github.v3+json'
        }
      })

      if (!githubResponse.ok) {
        return NextResponse.json({ error: 'Failed to fetch public repositories for this user' }, { status: githubResponse.status })
      }

      const repos = await githubResponse.json()
      
      const formattedRepos = repos.map((repo: any) => ({
        id: repo.id.toString(),
        name: repo.full_name,
        private: repo.private,
        url: repo.html_url,
        default_branch: repo.default_branch
      }))

      return NextResponse.json({ repositories: formattedRepos })
    }

    // IF NO username/url is provided, require login and fetch their own repos
    if (!user) {
      return NextResponse.json({ error: 'Please provide a GitHub URL or log in to view your repositories.' }, { status: 401 })
    }

    const adminClient = createAdminClient()
    const { data: profile } = await adminClient
      .from('profiles')
      .select('github_token')
      .eq('id', user.id)
      .single()

    if (!profile?.github_token) {
      return NextResponse.json({ error: 'GitHub token not found. Please log in with GitHub again.' }, { status: 400 })
    }

    const githubResponse = await fetch('https://api.github.com/user/repos?per_page=100&affiliation=owner,collaborator,organization_member', {
      headers: {
        Authorization: `Bearer ${profile.github_token}`,
        Accept: 'application/vnd.github.v3+json'
      }
    })

    if (!githubResponse.ok) {
      console.error('GitHub API error:', await githubResponse.text())
      return NextResponse.json({ error: 'Failed to fetch repositories from GitHub' }, { status: 502 })
    }

    const repos = await githubResponse.json()
    
    // Format the response to be cleaner
    const formattedRepos = repos.map((repo: any) => ({
      id: repo.id.toString(),
      name: repo.full_name,
      private: repo.private,
      url: repo.html_url,
      default_branch: repo.default_branch
    }))

    return NextResponse.json({ repositories: formattedRepos })

  } catch (error: any) {
    console.error('Error fetching GitHub repos:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
