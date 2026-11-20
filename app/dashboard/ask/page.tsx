import { redirect } from 'next/navigation'
import { createClient } from '@/utils/supabase/server'
import { getAccessibleRepos } from '@/lib/auth'
import AskChat from '@/components/AskChat'

export const dynamic = 'force-dynamic'

export default async function AskPage({ searchParams }: { searchParams: { repo?: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/dashboard/ask')

  const repos = await getAccessibleRepos(user.id)
  const initialRepo = repos.some((r) => r.id === searchParams.repo) ? searchParams.repo! : repos[0]?.id

  return <AskChat mode="list" repos={repos.map((r) => ({ id: r.id, name: r.name }))} initialRepoId={initialRepo} />
}
