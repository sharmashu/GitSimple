import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient, createAdminClient } from '@/utils/supabase/server'
import { loadTeamData, ACTIVITY_LABEL, type MemberSummary, type Bucket, type TeamData, type UsageRow } from '@/lib/teamActivity'
import ImpactBadge from '@/components/ImpactBadge'
import { IMPACT_LEVELS } from '@/lib/impact'
import {
  Users, Activity, GitCommit, FileText, MessageSquare, Search, FolderGit2, ArrowLeft, ExternalLink, ShieldCheck, Info,
} from 'lucide-react'

export const dynamic = 'force-dynamic'

type SearchParams = { days?: string; member?: string }
const PERIODS = [7, 30, 90]

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
  })
}
function fmtDay(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
  })
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
}

function status(lastActive: string | null) {
  if (!lastActive) return { text: 'Not active yet', cls: 'text-zinc-400 border-zinc-700 bg-zinc-800/40', dot: 'bg-zinc-500' }
  const days = Math.floor((Date.now() - new Date(lastActive).getTime()) / 86_400_000)
  if (days < 1) return { text: 'Active today', cls: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10', dot: 'bg-emerald-400' }
  if (days < 7) return { text: `Active ${days} day${days > 1 ? 's' : ''} ago`, cls: 'text-sky-300 border-sky-500/30 bg-sky-500/10', dot: 'bg-sky-400' }
  return { text: `Inactive for ${days} days`, cls: 'text-amber-300 border-amber-500/30 bg-amber-500/10', dot: 'bg-amber-400' }
}

function displayName(s: MemberSummary) {
  return s.member.name || s.member.githubLogin || s.member.email.split('@')[0] || 'Member'
}

function Avatar({ s, size = 40 }: { s: MemberSummary; size?: number }) {
  const name = displayName(s)
  return s.member.avatar ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={s.member.avatar} alt="" width={size} height={size} className="rounded-full border border-zinc-700" style={{ width: size, height: size }} />
  ) : (
    <span
      className="rounded-full bg-purple-500/20 text-purple-300 flex items-center justify-center font-semibold border border-purple-500/30"
      style={{ width: size, height: size }}
    >
      {name[0]?.toUpperCase()}
    </span>
  )
}

/** Single-series bar chart drawn with CSS. Hover a bar to see its value. */
function Bars({ values, buckets, title, unit, height = 64 }: { values: number[]; buckets: Bucket[]; title: string; unit: string; height?: number }) {
  const max = Math.max(1, ...values)
  const total = values.reduce((a, b) => a + b, 0)
  return (
    <figure className="min-w-0">
      <figcaption className="flex items-baseline justify-between text-xs mb-1.5">
        <span className="text-zinc-400">{title}</span>
        <span className="text-zinc-200 font-medium tabular-nums">{total} {unit}</span>
      </figcaption>
      <div className="flex items-end gap-[2px] border-b border-zinc-700" style={{ height }} role="img" aria-label={`${title}: ${total} ${unit}`}>
        {values.map((v, i) => (
          <div key={i} className="group relative flex-1 h-full flex items-end" title={`${buckets[i].label}: ${v} ${unit}`}>
            <div
              className={`w-full rounded-t-[4px] ${v ? 'bg-purple-500 group-hover:bg-purple-300' : 'bg-transparent'}`}
              style={{ height: v ? `${Math.max(6, (v / max) * 100)}%` : 0 }}
            />
            <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1 whitespace-nowrap rounded bg-zinc-800 border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-100 opacity-0 group-hover:opacity-100 z-10">
              {buckets[i].label}: {v}
            </span>
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
        <span>{buckets[0]?.label}</span>
        <span>{buckets[buckets.length - 1]?.label}</span>
      </div>
    </figure>
  )
}

function Stat({ label, value, icon: Icon, sub }: { label: string; value: string | number; icon: any; sub?: string }) {
  return (
    <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
      <p className="text-xs uppercase tracking-wide text-zinc-500 flex items-center gap-1.5"><Icon className="w-3.5 h-3.5" /> {label}</p>
      <p className="text-2xl font-bold text-white mt-1 tabular-nums">{value}</p>
      {sub && <p className="text-xs text-zinc-500 mt-0.5">{sub}</p>}
    </div>
  )
}

function ImpactChips({ counts }: { counts: Record<string, number> }) {
  const levels = IMPACT_LEVELS.filter((l) => counts[l])
  if (!levels.length) return <span className="text-xs text-zinc-500">No commits in this period</span>
  return (
    <div className="flex flex-wrap gap-1.5">
      {levels.map((l) => (
        <span key={l} className="inline-flex items-center gap-1">
          <ImpactBadge level={l} /><span className="text-xs text-zinc-300 tabular-nums">{counts[l]}</span>
        </span>
      ))}
    </div>
  )
}

function PeriodTabs({ days, member }: { days: number; member?: string }) {
  return (
    <div className="inline-flex rounded-lg border border-zinc-800 p-0.5 bg-zinc-900/60">
      {PERIODS.map((d) => (
        <Link
          key={d}
          href={`/dashboard/team?days=${d}${member ? `&member=${member}` : ''}`}
          className={`px-3 py-1.5 rounded-md text-xs font-medium ${d === days ? 'bg-white text-black' : 'text-zinc-400 hover:text-white'}`}
        >
          Last {d} days
        </Link>
      ))}
    </div>
  )
}

export default async function TeamActivityPage({ searchParams }: { searchParams: SearchParams }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/dashboard/team')

  const { data: profile } = await createAdminClient().from('profiles').select('role').eq('id', user.id).single()
  const days = PERIODS.includes(Number(searchParams.days)) ? Number(searchParams.days) : 30

  if (profile?.role !== 'manager') {
    return (
      <Shell>
        <Header days={days} />
        <Empty icon={ShieldCheck} title="Only managers can see team activity">
          This page shows a manager the activity of the people on their team.
        </Empty>
      </Shell>
    )
  }

  const memberId = typeof searchParams.member === 'string' ? searchParams.member : undefined
  const data = await loadTeamData(user.id, days, memberId)

  if (memberId) {
    const s = data.summaries[0]
    // loadTeamData only returns members whose manager is this user
    if (!s) {
      return (
        <Shell>
          <Header days={days} />
          <Empty icon={Users} title="Member not found">
            This person is not on your team. <Link href="/dashboard/team" className="text-purple-400 hover:underline">Back to your team</Link>
          </Empty>
        </Shell>
      )
    }
    return <MemberDetail s={s} data={data} days={days} />
  }

  return <Overview data={data} days={days} />
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-full bg-[#0a0a0a] text-zinc-300 px-4 md:px-8 py-8">
      <div className="max-w-5xl mx-auto space-y-6">{children}</div>
    </div>
  )
}

function Header({ days, member }: { days: number; member?: string }) {
  return (
    <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
      <div>
        <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
          <Users className="w-7 h-7 text-purple-400" /> Team Activity
        </h1>
        <p className="text-sm text-zinc-500 mt-1">What your team explored in GitSimple, and the work they committed.</p>
      </div>
      <PeriodTabs days={days} member={member} />
    </header>
  )
}

function Empty({ icon: Icon, title, children }: { icon: any; title: string; children: React.ReactNode }) {
  return (
    <div className="text-center py-16 border border-dashed border-zinc-800 rounded-xl">
      <Icon className="w-10 h-10 text-zinc-600 mx-auto mb-3" />
      <p className="text-white font-medium">{title}</p>
      <p className="text-sm text-zinc-500 mt-1 max-w-md mx-auto">{children}</p>
    </div>
  )
}

function PrivacyNote({ data }: { data: TeamData }) {
  return (
    <div className="space-y-2">
      {!data.hasCommitColumn && (
        <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 flex gap-2">
          <Info className="w-4 h-4 shrink-0" />
          Run <code className="px-1 bg-zinc-800 rounded">supabase/migrations/004_team_activity.sql</code> in Supabase to record which commits each person opened.
        </p>
      )}
      <p className="text-xs text-zinc-500 flex gap-2">
        <ShieldCheck className="w-4 h-4 shrink-0 text-zinc-500" />
        GitSimple records which feature was used and on which repository and commit. It never stores the questions people type.
      </p>
    </div>
  )
}

function Overview({ data, days }: { data: TeamData; days: number }) {
  const { summaries, buckets } = data
  const active = summaries.filter((s) => s.actions > 0 || s.authored.length > 0).length
  const opened = summaries.reduce((a, s) => a + s.commitsOpened, 0)
  const shipped = summaries.reduce((a, s) => a + s.authored.length, 0)
  const adds = summaries.reduce((a, s) => a + s.additions, 0)
  const dels = summaries.reduce((a, s) => a + s.deletions, 0)
  const sorted = [...summaries].sort((a, b) => (b.lastActive || '').localeCompare(a.lastActive || ''))

  return (
    <Shell>
      <Header days={days} />
      {summaries.length === 0 ? (
        <Empty icon={Users} title="No team members yet">
          Invite employees and interns from the <Link href="/dashboard" className="text-purple-400 hover:underline">dashboard</Link>, then assign them repositories.
          Their activity and commits will appear here.
        </Empty>
      ) : (
        <>
          <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Team members" value={summaries.length} icon={Users} />
            <Stat label="Active" value={`${active} / ${summaries.length}`} icon={Activity} sub={`in the last ${days} days`} />
            <Stat label="Commits explored" value={opened} icon={Search} sub="explained, chatted or PDF" />
            <Stat label="Commits shipped" value={shipped} icon={GitCommit} sub={`+${adds.toLocaleString('en-IN')} −${dels.toLocaleString('en-IN')} lines`} />
          </section>

          <section className="space-y-3">
            {sorted.map((s) => {
              const st = status(s.lastActive)
              return (
                <article key={s.member.id} className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5 hover:border-zinc-700 transition-colors">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar s={s} />
                      <div className="min-w-0">
                        <p className="text-white font-semibold truncate">
                          {displayName(s)}
                          {s.member.githubLogin && s.member.name && <span className="text-zinc-500 font-normal text-sm"> @{s.member.githubLogin}</span>}
                        </p>
                        <p className="text-xs text-zinc-500 truncate">
                          <span className="uppercase tracking-wide text-zinc-400">{s.member.role}</span> · {s.member.email}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border ${st.cls}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} /> {st.text}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mt-4 text-center">
                    {[
                      ['Commits opened', s.commitsOpened],
                      ['Oracle chats', s.chats],
                      ['PDF reports', s.pdfs],
                      ['Repo questions', s.questions],
                      ['Repos explored', s.reposExplored],
                      ['Commits shipped', s.authored.length],
                    ].map(([label, v]) => (
                      <div key={label as string} className="rounded-lg bg-zinc-950/60 border border-zinc-800 py-2">
                        <p className="text-lg font-semibold text-white tabular-nums">{v}</p>
                        <p className="text-[11px] text-zinc-500">{label}</p>
                      </div>
                    ))}
                  </div>

                  <div className="grid md:grid-cols-2 gap-5 mt-4">
                    <Bars values={s.activitySeries} buckets={buckets} title="Activity in GitSimple" unit="actions" height={48} />
                    <Bars values={s.workSeries} buckets={buckets} title="Commits shipped" unit="commits" height={48} />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 mt-4">
                    <ImpactChips counts={s.impactCounts} />
                    <Link href={`/dashboard/team?member=${s.member.id}&days=${days}`} className="text-sm text-purple-400 hover:text-purple-300 font-medium">
                      View history and progress →
                    </Link>
                  </div>
                </article>
              )
            })}
          </section>
          <PrivacyNote data={data} />
        </>
      )}
    </Shell>
  )
}

function MemberDetail({ s, data, days }: { s: MemberSummary; data: TeamData; days: number }) {
  const { buckets, repoNames, commitTitles } = data
  const st = status(s.lastActive)
  const history = data.usage.filter((u) => u.user_id === s.member.id).slice(0, 300)

  // Group history by day
  const groups: { day: string; rows: UsageRow[] }[] = []
  for (const u of history) {
    const day = fmtDay(u.created_at)
    if (!groups.length || groups[groups.length - 1].day !== day) groups.push({ day, rows: [] })
    groups[groups.length - 1].rows.push(u)
  }

  // Where they worked: activity and commits per repository
  const perRepo = new Map<string, { actions: number; commits: number }>()
  for (const u of history) if (u.repo_id) {
    const r = perRepo.get(u.repo_id) || { actions: 0, commits: 0 }
    r.actions++; perRepo.set(u.repo_id, r)
  }
  for (const c of s.authored) {
    const r = perRepo.get(c.repo_id) || { actions: 0, commits: 0 }
    r.commits++; perRepo.set(c.repo_id, r)
  }
  const repoRows = Array.from(perRepo.entries()).sort((a, b) => (b[1].actions + b[1].commits) - (a[1].actions + a[1].commits))

  const repoLink = (repoId: string | null, sha?: string | null) => {
    const r = repoId ? repoNames.get(repoId) : undefined
    if (!r?.url) return null
    return sha ? `${r.url}/commit/${sha}` : r.url
  }

  return (
    <Shell>
      <Link href={`/dashboard/team?days=${days}`} className="inline-flex items-center gap-1.5 text-sm text-zinc-400 hover:text-white">
        <ArrowLeft className="w-4 h-4" /> All team members
      </Link>

      <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="flex items-center gap-4">
          <Avatar s={s} size={56} />
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">{displayName(s)}</h1>
            <p className="text-sm text-zinc-500">
              <span className="uppercase tracking-wide text-zinc-400">{s.member.role}</span>
              {s.member.githubLogin && <> · @{s.member.githubLogin}</>} · {s.member.email}
            </p>
            <p className="text-xs text-zinc-500 mt-1 flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border ${st.cls}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} /> {st.text}
              </span>
              {s.member.lastSignIn && <span>Last sign-in {fmtDateTime(s.member.lastSignIn)}</span>}
              {s.member.joinedAt && <span>· Joined {fmtDay(s.member.joinedAt)}</span>}
            </p>
          </div>
        </div>
        <PeriodTabs days={days} member={s.member.id} />
      </header>

      <section className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <Stat label="Opened" value={s.commitsOpened} icon={Search} sub="commits" />
        <Stat label="Oracle" value={s.chats} icon={MessageSquare} sub="chats" />
        <Stat label="PDFs" value={s.pdfs} icon={FileText} sub="reports" />
        <Stat label="Ask" value={s.questions} icon={MessageSquare} sub="repo questions" />
        <Stat label="Shipped" value={s.authored.length} icon={GitCommit} sub="commits" />
        <Stat label="Lines" value={`+${s.additions.toLocaleString('en-IN')}`} icon={Activity} sub={`−${s.deletions.toLocaleString('en-IN')} removed`} />
      </section>

      <section className="grid md:grid-cols-2 gap-4">
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
          <Bars values={s.activitySeries} buckets={buckets} title="Activity in GitSimple" unit="actions" height={110} />
        </div>
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
          <Bars values={s.workSeries} buckets={buckets} title="Commits shipped (work progress)" unit="commits" height={110} />
          <div className="mt-3"><ImpactChips counts={s.impactCounts} /></div>
        </div>
      </section>

      {repoRows.length > 0 && (
        <section className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
          <h2 className="text-white font-semibold flex items-center gap-2 mb-3"><FolderGit2 className="w-4 h-4 text-purple-400" /> Where they worked</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-zinc-500 text-left">
                <th className="font-medium pb-2">Repository</th>
                <th className="font-medium pb-2 text-right">Actions in GitSimple</th>
                <th className="font-medium pb-2 text-right">Commits shipped</th>
              </tr>
            </thead>
            <tbody>
              {repoRows.map(([id, r]) => (
                <tr key={id} className="border-t border-zinc-800">
                  <td className="py-2 text-zinc-200">{repoNames.get(id)?.name || 'Repository'}</td>
                  <td className="py-2 text-right tabular-nums">{r.actions}</td>
                  <td className="py-2 text-right tabular-nums">{r.commits}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="grid lg:grid-cols-2 gap-4 items-start">
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
          <h2 className="text-white font-semibold flex items-center gap-2 mb-1"><Activity className="w-4 h-4 text-purple-400" /> History</h2>
          <p className="text-xs text-zinc-500 mb-4">What they opened and used, newest first.</p>
          {groups.length === 0 ? (
            <p className="text-sm text-zinc-500">No activity in the last {days} days.</p>
          ) : (
            <div className="space-y-5 max-h-[640px] overflow-y-auto pr-1">
              {groups.map((g) => (
                <div key={g.day}>
                  <p className="text-xs font-semibold text-zinc-400 mb-2">{g.day}</p>
                  <ol className="relative border-l border-zinc-800 ml-1.5 space-y-3">
                    {g.rows.map((u, i) => {
                      const repo = u.repo_id ? repoNames.get(u.repo_id) : undefined
                      const title = u.commit_sha ? commitTitles.get(u.commit_sha) : undefined
                      const href = repoLink(u.repo_id, u.commit_sha)
                      return (
                        <li key={`${u.created_at}-${i}`} className="ml-4">
                          <span className="absolute -left-[5px] mt-1.5 w-2.5 h-2.5 rounded-full bg-zinc-900 border-2 border-purple-500" />
                          <p className="text-sm text-zinc-200">
                            {ACTIVITY_LABEL[u.kind]}
                            <span className="text-zinc-500 text-xs"> · {fmtTime(u.created_at)}</span>
                          </p>
                          <p className="text-xs text-zinc-500 mt-0.5">
                            {repo?.name || 'Repository'}
                            {u.commit_sha && (
                              <>
                                {' · '}
                                {href ? (
                                  <a href={href} target="_blank" rel="noreferrer" className="font-mono text-purple-400 hover:text-purple-300">{u.commit_sha.slice(0, 7)}</a>
                                ) : (
                                  <span className="font-mono">{u.commit_sha.slice(0, 7)}</span>
                                )}
                                {title && <span className="text-zinc-400"> {title}</span>}
                              </>
                            )}
                          </p>
                        </li>
                      )
                    })}
                  </ol>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-5">
          <h2 className="text-white font-semibold flex items-center gap-2 mb-1"><GitCommit className="w-4 h-4 text-purple-400" /> Commits they shipped</h2>
          <p className="text-xs text-zinc-500 mb-4">Analysed commits by this person in your tracked repositories.</p>
          {s.authored.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No analysed commits by {displayName(s)} in the last {days} days.
              {!s.member.githubLogin && ' Their GitHub username is saved the next time they sign in with GitHub.'}
            </p>
          ) : (
            <ol className="space-y-3 max-h-[640px] overflow-y-auto pr-1">
              {s.authored.slice(0, 100).map((c) => {
                const href = repoLink(c.repo_id, c.commit_sha)
                return (
                  <li key={c.id} className="border border-zinc-800 rounded-lg p-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                      <ImpactBadge level={c.impact_level} />
                      <span>{repoNames.get(c.repo_id)?.name}</span>
                      <span>· {fmtDateTime(c.committed_at)}</span>
                    </div>
                    <p className="text-sm text-white font-medium mt-1.5">
                      {c.title}{' '}
                      {href && (
                        <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-mono text-xs text-purple-400 hover:text-purple-300">
                          {c.short_sha} <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </p>
                    <p className="text-xs text-zinc-400 mt-1 leading-relaxed line-clamp-3">{c.executive_summary}</p>
                    {c.stats && (
                      <p className="text-xs text-zinc-500 mt-1">
                        {c.stats.files_changed} files <span className="text-emerald-500">+{c.stats.additions}</span> <span className="text-red-500">−{c.stats.deletions}</span>
                      </p>
                    )}
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      </section>

      <PrivacyNote data={data} />
    </Shell>
  )
}
