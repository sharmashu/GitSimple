import { createClient } from '@/utils/supabase/server'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      if ((request.headers.get('content-type') || '').includes('application/json')) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
      return NextResponse.redirect(new URL('/login', request.url), 303)
    }

    const contentType = request.headers.get('content-type') || ''
    
    let userIdToRemove: string
    if (contentType.includes('application/json')) {
      const body = await request.json()
      userIdToRemove = body.userIdToRemove
    } else {
      const formData = await request.formData()
      userIdToRemove = formData.get('userIdToRemove') as string
    }

    if (!userIdToRemove) {
      if (contentType.includes('application/json')) return NextResponse.json({ error: 'Missing userIdToRemove' }, { status: 400 })
      return NextResponse.redirect(new URL('/dashboard?error=Missing+userIdToRemove', request.url), 303)
    }

    const { createAdminClient } = await import('@/utils/supabase/server')
    const adminSupabase = createAdminClient()

    // Verify caller is a manager
    const { data: profile } = await adminSupabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (profile?.role !== 'manager') {
      if (contentType.includes('application/json')) return NextResponse.json({ error: 'Forbidden. Only managers can remove users.' }, { status: 403 })
      return NextResponse.redirect(new URL('/dashboard?error=Forbidden', request.url), 303)
    }

    // Verify the target user is actually managed by this manager
    const { data: targetProfile } = await adminSupabase
      .from('profiles')
      .select('manager_id')
      .eq('id', userIdToRemove)
      .single()

    if (!targetProfile || targetProfile.manager_id !== user.id) {
      return NextResponse.json({ error: 'You are not the manager of this user' }, { status: 403 })
    }

    // 1. Remove the manager_id link
    const { error: updateError } = await adminSupabase
      .from('profiles')
      .update({ manager_id: null })
      .eq('id', userIdToRemove)

    if (updateError) throw updateError

    // 2. Remove all repository assignments for this user granted by this manager
    const { error: unassignError } = await adminSupabase
      .from('user_repositories')
      .delete()
      .eq('user_id', userIdToRemove)
      .eq('assigned_by', user.id)

    if (unassignError) throw unassignError

    if (contentType.includes('application/json')) {
      return NextResponse.json({ success: true, message: 'User removed from team successfully' })
    } else {
      return NextResponse.redirect(new URL('/dashboard?message=User+removed+successfully', request.url), 303)
    }
  } catch (error: any) {
    console.error('Remove team member error:', error)
    const contentType = request.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      return NextResponse.json({ error: error.message || 'Failed to remove user' }, { status: 500 })
    } else {
      return NextResponse.redirect(new URL(`/dashboard?error=${encodeURIComponent(error.message || 'Failed')}`, request.url), 303)
    }
  }
}
