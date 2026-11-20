import { redirect } from 'next/navigation'
import { createClient } from '@/utils/supabase/server'
import Link from 'next/link'
import { fetchUserRepos } from '@/lib/github'

export const dynamic = 'force-dynamic'

export default async function DashboardPage({ searchParams }: { searchParams: { message?: string; error?: string } }) {
  const supabase = createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { createAdminClient } = await import('@/utils/supabase/server')
  const adminSupabase = createAdminClient()

  // Fetch user profile to get their role (bypassing RLS)
  const { data: profile, error } = await adminSupabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  if (error) console.error("Failed to load profile:", error.message)

  const role = profile?.role || 'intern'

  // Fetch GitHub repos for manager
  let githubRepos: any[] = []
  let githubError: string | null = null
  if (role === 'manager' && profile?.github_token) {
    try {
      githubRepos = await fetchUserRepos(profile.github_token)
    } catch (e: any) {
      console.error('Error fetching github repos for dashboard', e)
      githubError = e?.message || 'Unknown error'
    }
  }

  // AI usage over the last 30 days (metering; cached answers cost 0 tokens)
  const since = new Date(Date.now() - 30 * 86400_000).toISOString()
  const { data: usageRows } = await adminSupabase
    .from('ai_usage')
    .select('cached, input_tokens, output_tokens')
    .eq('user_id', user.id)
    .gte('created_at', since)
    .limit(10000)
  const usage = (usageRows || []).reduce(
    (acc: { total: number; cached: number; tokens: number }, r: any) => {
      acc.total++
      if (r.cached) acc.cached++
      acc.tokens += (r.input_tokens || 0) + (r.output_tokens || 0)
      return acc
    },
    { total: 0, cached: 0, tokens: 0 }
  )

  // Fetch assigned repositories (using admin client to bypass any RLS policy misconfigurations)
  const { data: assignedRepos } = await adminSupabase
    .from('user_repositories')
    .select('repository_id, repositories(name, url)')
    .eq('user_id', user.id)

  // Fetch Team Data
  let teamMembers: any[] = [];
  let myManager: any = null;
  let peerMembers: any[] = [];
  
  if (role === 'manager') {
    const { data } = await adminSupabase
      .from('profiles')
      .select('id, email, role, created_at')
      .eq('manager_id', user.id)
      .order('created_at', { ascending: false })
    teamMembers = data || [];
  } else if (profile?.manager_id) {
    const { data: managerData } = await adminSupabase
      .from('profiles')
      .select('id, email, role')
      .eq('id', profile.manager_id)
      .single()
    myManager = managerData;
    
    const { data: peersData } = await adminSupabase
      .from('profiles')
      .select('id, email, role')
      .eq('manager_id', profile.manager_id)
      .neq('id', user.id)
    peerMembers = peersData || [];
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-8">
      <header className="mb-12">
        <h1 className="text-3xl font-bold text-slate-800">GitSimple Dashboard</h1>
        <p className="text-sm text-slate-500 uppercase tracking-wide mt-2">Role: {role}</p>
        <div className="flex flex-wrap gap-3 mt-4">
          <Link href="/dashboard/timeline" className="px-4 py-2 bg-slate-900 text-white rounded-md text-sm font-medium hover:bg-slate-800">
            Commit Timeline &rarr;
          </Link>
          <Link href="/dashboard/ask" className="px-4 py-2 bg-white border border-slate-200 rounded-md text-sm font-medium text-slate-800 hover:bg-slate-100">
            Ask the Repo &rarr;
          </Link>
        </div>
        {searchParams?.message && (
          <p className="mt-4 text-sm text-green-700 bg-green-50 border border-green-100 p-3 rounded-md">{searchParams.message}</p>
        )}
        {searchParams?.error && (
          <p className="mt-4 text-sm text-red-700 bg-red-50 border border-red-100 p-3 rounded-md">{searchParams.error}</p>
        )}
      </header>

      <main className="max-w-4xl mx-auto space-y-8">

        <section className="grid grid-cols-3 gap-3">
          <div className="bg-white p-4 rounded-xl border border-slate-200">
            <p className="text-xs uppercase tracking-wide text-slate-500">AI requests (30 days)</p>
            <p className="text-2xl font-bold text-slate-900 mt-1">{usage.total}</p>
          </div>
          <div className="bg-white p-4 rounded-xl border border-slate-200">
            <p className="text-xs uppercase tracking-wide text-slate-500">Served from cache</p>
            <p className="text-2xl font-bold text-emerald-600 mt-1">
              {usage.total ? Math.round((usage.cached / usage.total) * 100) : 0}%
            </p>
          </div>
          <div className="bg-white p-4 rounded-xl border border-slate-200">
            <p className="text-xs uppercase tracking-wide text-slate-500">Tokens used</p>
            <p className="text-2xl font-bold text-slate-900 mt-1">{usage.tokens.toLocaleString('en-IN')}</p>
          </div>
        </section>

        {/* Manager Section */}
        {role === 'manager' && (
          <section className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
            <h2 className="text-xl font-bold mb-4">Manager Tools</h2>
            <div className="bg-slate-50 p-4 rounded-lg border border-slate-100">
              <h3 className="font-semibold mb-2">Provision Access</h3>
              <p className="text-sm text-slate-600 mb-4">Invite team members and assign them repositories.</p>

              <form className="flex flex-col gap-4" action="/api/auth/invite" method="POST">
                <div className="flex gap-2">
                  <input type="email" name="email" placeholder="email@company.com" className="px-3 py-2 border rounded-md flex-1" required />
                  <select name="role" className="px-3 py-2 border rounded-md bg-white">
                    <option value="employee">Employee</option>
                    <option value="intern">Intern</option>
                    <option value="manager">Manager</option>
                  </select>
                </div>
                
                {githubRepos.length > 0 && (
                  <div className="mt-2">
                    <p className="font-medium text-sm text-slate-700 mb-2">Assign Repositories:</p>
                    <div className="max-h-60 overflow-y-auto border rounded-md bg-white p-2 space-y-2">
                      {githubRepos.map(repo => (
                        <label key={repo.id} className="flex items-start gap-2 p-2 hover:bg-slate-50 rounded cursor-pointer">
                          <input type="checkbox" name="repositoryIds" value={JSON.stringify(repo)} className="mt-1" />
                          <div>
                            <p className="text-sm font-medium">{repo.name} {repo.private && <span className="text-xs bg-slate-200 px-1 rounded">Private</span>}</p>
                            <p className="text-xs text-slate-500">{repo.url}</p>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                {!profile?.github_token && (
                  <p className="text-sm text-amber-600 bg-amber-50 p-2 rounded">
                    You need to log in with GitHub to view and assign your private repositories.
                  </p>
                )}
                {githubError && (
                  <p className="text-sm text-red-600 bg-red-50 p-2 rounded">
                    {githubError}
                  </p>
                )}

                <button type="submit" className="bg-slate-900 text-white px-4 py-2 rounded-md hover:bg-slate-800 transition-colors w-fit">
                  Invite User & Assign Repos
                </button>
              </form>
            </div>

            {githubRepos.length > 0 && (
              <div className="bg-slate-50 p-4 rounded-lg border border-slate-100 mt-4">
                <h3 className="font-semibold mb-2">Track a Repository</h3>
                <p className="text-sm text-slate-600 mb-4">
                  Adds the repo to your Commit Timeline, sets up the GitHub webhook, and imports the latest 10 commits.
                </p>
                <form className="flex flex-col sm:flex-row gap-2" action="/api/repos/track" method="POST">
                  <select name="repo" className="px-3 py-2 border rounded-md bg-white flex-1" required>
                    {githubRepos.map(repo => (
                      <option key={repo.id} value={JSON.stringify(repo)}>
                        {repo.name}{repo.private ? ' (private)' : ''}
                      </option>
                    ))}
                  </select>
                  <button type="submit" className="bg-slate-900 text-white px-4 py-2 rounded-md hover:bg-slate-800 transition-colors">
                    Track Repository
                  </button>
                </form>
              </div>
            )}
          </section>
        )}

        {/* Assigned Repositories Section */}
        <section className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
          <h2 className="text-xl font-bold mb-4">Your Assigned Repositories</h2>

          {assignedRepos && assignedRepos.length > 0 ? (
            <ul className="space-y-3">
              {assignedRepos.map((ar: any) => (
                <li key={ar.repository_id} className="p-4 border border-slate-100 rounded-lg flex justify-between items-center bg-slate-50 hover:bg-slate-100 transition-colors">
                  <div>
                    <h3 className="font-bold text-slate-800">{ar.repositories.name}</h3>
                    <a href={ar.repositories.url} target="_blank" rel="noreferrer" className="text-sm text-blue-600 hover:underline">
                      {ar.repositories.url}
                    </a>
                  </div>
                  <a href={`/?repo=${encodeURIComponent(ar.repositories.url)}`} className="px-4 py-2 bg-white border shadow-sm rounded-md text-sm font-medium hover:bg-slate-50 transition-colors">
                    Analyze Commits &rarr;
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-center py-8 text-slate-500 bg-slate-50 rounded-lg border border-dashed border-slate-200">
              <p>You have not been assigned to any repositories yet.</p>
              <p className="text-sm mt-1">Please contact your manager for access.</p>
            </div>
          )}
        </section>

        {/* Team Management Section (Manager) */}
        {role === 'manager' && (
          <section className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
            <h2 className="text-xl font-bold mb-4">My Team</h2>
            {teamMembers.length > 0 ? (
              <ul className="space-y-3">
                {teamMembers.map((member: any) => (
                  <li key={member.id} className="p-4 border border-slate-100 rounded-lg flex justify-between items-center bg-slate-50">
                    <div>
                      <p className="font-semibold text-slate-800">{member.email}</p>
                      <p className="text-sm text-slate-500 uppercase">{member.role}</p>
                    </div>
                    <form action="/api/team/remove" method="POST">
                      <input type="hidden" name="userIdToRemove" value={member.id} />
                      <button type="submit" className="px-3 py-1 bg-red-50 text-red-600 hover:bg-red-100 rounded-md text-sm font-medium transition-colors">
                        Remove
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-slate-500 text-sm">You have not added any employees to your team yet.</p>
            )}
          </section>
        )}

        {/* Team Directory (Employee/Intern) */}
        {role !== 'manager' && (
          <section className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
            <h2 className="text-xl font-bold mb-4">Team Directory</h2>
            {myManager ? (
              <div className="space-y-6">
                <div>
                  <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">Manager</h3>
                  <div className="p-4 border border-purple-100 rounded-lg bg-purple-50 flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-purple-200 flex items-center justify-center font-bold text-purple-700">
                      {myManager.email[0].toUpperCase()}
                    </div>
                    <div>
                      <p className="font-semibold text-slate-800">{myManager.email}</p>
                      <p className="text-xs text-slate-500 uppercase">{myManager.role}</p>
                    </div>
                  </div>
                </div>
                
                {peerMembers.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">Peers</h3>
                    <ul className="grid gap-3 sm:grid-cols-2">
                      {peerMembers.map((peer: any) => (
                        <li key={peer.id} className="p-3 border border-slate-100 rounded-lg bg-slate-50 flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center font-bold text-slate-600 text-sm">
                            {peer.email[0].toUpperCase()}
                          </div>
                          <div className="truncate">
                            <p className="font-medium text-slate-800 text-sm truncate">{peer.email}</p>
                            <p className="text-xs text-slate-500 uppercase">{peer.role}</p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-slate-500 text-sm">You are not assigned to a manager yet.</p>
            )}
          </section>
        )}

      </main>
    </div>
  )
}
