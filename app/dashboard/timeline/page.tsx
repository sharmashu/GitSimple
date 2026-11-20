import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient, createAdminClient } from '@/utils/supabase/server'
import { getAccessibleRepos } from '@/lib/auth'
import { IMPACT_LEVELS } from '@/lib/impact'
import ImpactBadge from '@/components/ImpactBadge'
import { GitCommit, AlertTriangle, Users, Activity, ExternalLink, MessageSquare } from 'lucide-react'

export const dynamic = 'force-dynamic'

type SearchParams = { repo?: string; impact?: string; author?: string; q?: string; message?: string }

function buildHref(current: SearchParams, patch: Partial<SearchParams>) {
  const params = new URLSearchParams()
  const merged = { ...current, ...patch, message: undefined }
  Object.entries(merged).forEach(([k, v]) => v && params.set(k, v))
  const qs = params.toString()
  return `/dashboard/timeline${qs ? `?${qs}` : ''}`
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
  })
}

export default async function TimelinePage({ searchParams }: { searchParams: SearchParams }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const repos = await getAccessibleRepos(user.id)
  const repoById = new Map(repos.map((r) => [r.id, r]))

  const selectedRepo = searchParams.repo && repoById.has(searchParams.repo) ? searchParams.repo : undefined
  const impact = IMPACT_LEVELS.includes(searchParams.impact as any) ? searchParams.impact : undefined
  const author = searchParams.author?.slice(0, 200) || undefined
  // Strip characters that have meaning in PostgREST filter syntax
  const q = searchParams.q?.replace(/[,()*%\\]/g, ' ').trim().slice(0, 100) || undefined

  const repoIds = selectedRepo ? [selectedRepo] : repos.map((r) => r.id)

  let commits: any[] = []
  let statsRows: { impact_level: string; author_name: string }[] = []

  if (repoIds.length > 0) {
    const admin = createAdminClient()

    let query = admin
      .from('commits')
      .select('id, repo_id, commit_sha, short_sha, branch, author_name, author_avatar, title, executive_summary, architectural_impact, breaking_changes, affected_domains, impact_level, stats, committed_at')
      .in('repo_id', repoIds)
      .order('committed_at', { ascending: false })
      .limit(100)
    if (impact) query = query.eq('impact_level', impact)
    if (author) query = query.eq('author_name', author)
    if (q) query = query.or(`title.ilike.%${q}%,executive_summary.ilike.%${q}%`)

    const [{ data: commitData }, { data: statData }] = await Promise.all([
      query,
      admin.from('commits').select('impact_level, author_name').in('repo_id', repoIds).limit(5000),
    ])
    commits = commitData || []
    statsRows = statData || []
  }

  const impactCounts: Record<string, number> = {}
  const authorCounts: Record<string, number> = {}
  statsRows.forEach((r) => {
    impactCounts[r.impact_level] = (impactCounts[r.impact_level] || 0) + 1
    authorCounts[r.author_name] = (authorCounts[r.author_name] || 0) + 1
  })
  const authors = Object.keys(authorCounts).sort()
  const filtersActive = !!(impact || author || q)

  return (
    <div className="min-h-full bg-[#0a0a0a] text-zinc-300 px-4 md:px-8 py-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
              <Activity className="w-7 h-7 text-purple-400" /> Commit Timeline
            </h1>
            <p className="text-sm text-zinc-500 mt-1">
              Every push to your tracked repositories, analysed by AI.
            </p>
          </div>
          <Link
            href={selectedRepo ? `/dashboard/ask?repo=${selectedRepo}` : '/dashboard/ask'}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium w-fit"
          >
            <MessageSquare className="w-4 h-4" /> Ask about this history
          </Link>
        </header>

        {searchParams.message && (
          <p className="text-sm text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3">
            {searchParams.message}
          </p>
        )}

        {repos.length === 0 ? (
          <div className="text-center py-16 border border-dashed border-zinc-800 rounded-xl">
            <GitCommit className="w-10 h-10 text-zinc-600 mx-auto mb-3" />
            <p className="text-white font-medium">No tracked repositories yet</p>
            <p className="text-sm text-zinc-500 mt-1">
              Managers can track a repository from the{' '}
              <Link href="/dashboard" className="text-purple-400 hover:underline">dashboard</Link>.
              Interns see repositories their manager assigns.
            </p>
          </div>
        ) : (
          <>
            {/* Stats */}
            <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
                <p className="text-xs uppercase tracking-wide text-zinc-500">Commits analysed</p>
                <p className="text-2xl font-bold text-white mt-1">{statsRows.length}</p>
              </div>
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
                <p className="text-xs uppercase tracking-wide text-zinc-500 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> Breaking
                </p>
                <p className="text-2xl font-bold text-red-400 mt-1">{impactCounts.Breaking || 0}</p>
              </div>
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
                <p className="text-xs uppercase tracking-wide text-zinc-500">Security</p>
                <p className="text-2xl font-bold text-orange-400 mt-1">{impactCounts.Security || 0}</p>
              </div>
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
                <p className="text-xs uppercase tracking-wide text-zinc-500 flex items-center gap-1">
                  <Users className="w-3 h-3" /> Contributors
                </p>
                <p className="text-2xl font-bold text-white mt-1">{authors.length}</p>
              </div>
            </section>

            {/* Impact chips */}
            <section className="flex flex-wrap gap-2">
              <Link
                href={buildHref(searchParams, { impact: undefined })}
                className={`px-3 py-1 rounded-full text-xs font-medium border ${!impact ? 'bg-white text-black border-white' : 'border-zinc-700 text-zinc-400 hover:text-white'}`}
              >
                All
              </Link>
              {IMPACT_LEVELS.map((level) => (
                <Link
                  key={level}
                  href={buildHref(searchParams, { impact: impact === level ? undefined : level })}
                  className={`px-3 py-1 rounded-full text-xs font-medium border ${impact === level ? 'bg-white text-black border-white' : 'border-zinc-700 text-zinc-400 hover:text-white'}`}
                >
                  {level} <span className="opacity-60">{impactCounts[level] || 0}</span>
                </Link>
              ))}
            </section>

            {/* Filters */}
            <form method="GET" className="flex flex-col md:flex-row gap-2">
              {impact && <input type="hidden" name="impact" value={impact} />}
              <select name="repo" defaultValue={selectedRepo || ''} className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white">
                <option value="">All repositories</option>
                {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <select name="author" defaultValue={author || ''} className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white">
                <option value="">All authors</option>
                {authors.map((a) => <option key={a} value={a}>{a} ({authorCounts[a]})</option>)}
              </select>
              <input
                name="q"
                defaultValue={q || ''}
                placeholder="Search summaries…"
                className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white placeholder:text-zinc-600"
              />
              <button type="submit" className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white text-sm font-medium">
                Filter
              </button>
              {filtersActive && (
                <Link href={buildHref({ repo: selectedRepo }, {})} className="px-4 py-2 rounded-lg text-sm text-zinc-400 hover:text-white text-center">
                  Clear
                </Link>
              )}
            </form>

            {/* Timeline */}
            {commits.length === 0 ? (
              <div className="text-center py-16 border border-dashed border-zinc-800 rounded-xl">
                <p className="text-white font-medium">{filtersActive ? 'No commits match these filters' : 'No commits analysed yet'}</p>
                <p className="text-sm text-zinc-500 mt-1">
                  {filtersActive
                    ? 'Try clearing a filter.'
                    : 'Commits appear here after the next push, or a minute after you start tracking a repository. Refresh to check.'}
                </p>
              </div>
            ) : (
              <ol className="relative border-l border-zinc-800 ml-3 space-y-6">
                {commits.map((c) => {
                  const repo = repoById.get(c.repo_id)
                  const breaking: string[] = c.breaking_changes || []
                  const domains: string[] = c.affected_domains || []
                  return (
                    <li key={c.id} className="ml-6">
                      <span className="absolute -left-[7px] mt-5 w-3.5 h-3.5 rounded-full bg-zinc-900 border-2 border-purple-500" />
                      <article className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5 hover:border-zinc-700 transition-colors">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                          <ImpactBadge level={c.impact_level} />
                          {!selectedRepo && repo && <span className="text-zinc-400">{repo.name}</span>}
                          <span className="font-mono">{c.short_sha}</span>
                          <span>· {c.branch}</span>
                          <span>· {formatDate(c.committed_at)}</span>
                        </div>

                        <h3 className="text-white font-semibold mt-2">{c.title}</h3>

                        <div className="flex items-center gap-2 mt-2 text-sm text-zinc-400">
                          {c.author_avatar ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={c.author_avatar} alt="" className="w-5 h-5 rounded-full" />
                          ) : (
                            <span className="w-5 h-5 rounded-full bg-zinc-800 flex items-center justify-center text-[10px] text-zinc-400">
                              {c.author_name?.[0]?.toUpperCase()}
                            </span>
                          )}
                          <Link href={buildHref(searchParams, { author: c.author_name })} className="hover:text-white">
                            {c.author_name}
                          </Link>
                          {c.stats && (
                            <span className="text-xs text-zinc-500">
                              · {c.stats.files_changed} files
                              <span className="text-emerald-500 ml-1">+{c.stats.additions}</span>
                              <span className="text-red-500 ml-1">-{c.stats.deletions}</span>
                            </span>
                          )}
                        </div>

                        <p className="text-sm text-zinc-300 mt-3 leading-relaxed">{c.executive_summary}</p>

                        {c.architectural_impact && c.architectural_impact.trim().toLowerCase() !== 'none' && (
                          <p className="text-sm text-zinc-400 mt-2">
                            <span className="text-zinc-500 font-medium">Architecture: </span>{c.architectural_impact}
                          </p>
                        )}

                        {breaking.length > 0 && (
                          <div className="mt-3 bg-red-500/5 border border-red-500/20 rounded-lg p-3">
                            <p className="text-xs font-semibold text-red-400 flex items-center gap-1 mb-1">
                              <AlertTriangle className="w-3 h-3" /> Breaking changes
                            </p>
                            <ul className="list-disc list-inside text-sm text-red-200/80 space-y-0.5">
                              {breaking.map((b, i) => <li key={i}>{b}</li>)}
                            </ul>
                          </div>
                        )}

                        <div className="flex flex-wrap items-center justify-between gap-2 mt-4">
                          <div className="flex flex-wrap gap-1.5">
                            {domains.map((d) => (
                              <span key={d} className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-400">{d}</span>
                            ))}
                          </div>
                          {repo && (
                            <div className="flex gap-3 text-xs">
                              <a href={`/?repo=${encodeURIComponent(repo.url)}`} className="text-purple-400 hover:text-purple-300">
                                Deep dive
                              </a>
                              <a
                                href={`${repo.url}/commit/${c.commit_sha}`}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-zinc-400 hover:text-white"
                              >
                                GitHub <ExternalLink className="w-3 h-3" />
                              </a>
                            </div>
                          )}
                        </div>
                      </article>
                    </li>
                  )
                })}
              </ol>
            )}
          </>
        )}
      </div>
    </div>
  )
}
