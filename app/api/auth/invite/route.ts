import { createClient } from '@/utils/supabase/server'
import { NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { trackRepository, backfillRepo } from '@/lib/commitProcessor'
import { isValidFullName, parseGithubRepoUrl } from '@/lib/validation'
import { fetchRepoMeta } from '@/lib/github'

export const maxDuration = 300;

export async function POST(request: Request) {
  const contentType = request.headers.get('content-type') || ''
  try {
    const supabase = createClient()

    // 1. Verify caller is a manager
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      if (contentType.includes('application/json')) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      return NextResponse.redirect(new URL('/login', request.url), 303)
    }

    const { createAdminClient } = await import('@/utils/supabase/server')
    const adminAuthClient = createAdminClient()

    const { data: profile } = await adminAuthClient
      .from('profiles')
      .select('role, github_token')
      .eq('id', user.id)
      .single()

    if (profile?.role !== 'manager') {
      if (contentType.includes('application/json')) return NextResponse.json({ error: 'Forbidden. Only managers can invite.' }, { status: 403 })
      return NextResponse.redirect(new URL('/dashboard?error=Forbidden', request.url), 303)
    }

    // 2. Parse request
    let email: string;
    let role: string;
    let repositoryIds: string[] = [];

    if (contentType.includes('application/json')) {
      const body = await request.json();
      email = body.email;
      role = body.role;
      repositoryIds = body.repositoryIds || [];
    } else {
      const formData = await request.formData();
      email = formData.get('email') as string;
      role = formData.get('role') as string;
      repositoryIds = formData.getAll('repositoryIds') as string[];
    }

    if (!email || !role) {
      if (contentType.includes('application/json')) return NextResponse.json({ error: 'Missing email or role' }, { status: 400 })
      return NextResponse.redirect(new URL('/dashboard?error=Missing+email+or+role', request.url), 303)
    }

    // 3. Admin client to bypass normal auth rules and invite user
    // (Needs SUPABASE_SERVICE_ROLE_KEY to work in prod)

    let invitedUserId: string;
    try {
      const { data: inviteData, error: inviteError } = await adminAuthClient.auth.admin.inviteUserByEmail(email, {
        data: { role: role } // This is passed in raw_user_meta_data and processed by our trigger
      });
      if (inviteError) throw inviteError;
      invitedUserId = inviteData.user.id;
    } catch (inviteErr: any) {
      // If user already exists, Supabase throws an error (often 422). 
      // We can fallback to fetching the existing profile id.
      const { data: existingProfile } = await adminAuthClient
        .from('profiles')
        .select('id')
        .eq('email', email)
        .single();
        
      if (existingProfile) {
        invitedUserId = existingProfile.id;
        console.log(`User ${email} already exists, using existing ID: ${invitedUserId}`);
      } else {
        throw inviteErr;
      }
    }

    // Set the manager_id for the invited user
    const { error: updateManagerError } = await adminAuthClient
      .from('profiles')
      .update({ manager_id: user.id })
      .eq('id', invitedUserId);

    if (updateManagerError) {
      console.error("Failed to set manager_id", updateManagerError);
      // We can continue, but it's good to log
    }

    // 4. Assign repositories if any
    if (repositoryIds && repositoryIds.length > 0) {
      const assignments = [];
      
      for (const repoStr of repositoryIds) {
        let repoObj;
        try {
          repoObj = typeof repoStr === 'string' ? JSON.parse(repoStr) : repoStr;
        } catch (e) {
          console.error("Failed to parse repo string", repoStr);
          continue;
        }

        if (!repoObj || !isValidFullName(repoObj.name) || !parseGithubRepoUrl(repoObj.url)) {
          console.error("Skipping invalid repo", repoStr);
          continue;
        }

        // Use GitHub's real metadata (never trust the browser about whether a repo is private)
        const meta = profile?.github_token ? await fetchRepoMeta(repoObj.name, profile.github_token).catch(() => null) : null;
        if (!meta) {
          console.error("Manager has no GitHub access to", repoObj.name);
          continue;
        }

        // Save the repo, link it to the manager (so it shows in their timeline) and set up the webhook
        const upsertedRepo = await trackRepository(
          { name: meta.full_name, url: meta.html_url, default_branch: meta.default_branch, private: !!meta.private },
          user.id,
          profile?.github_token || null
        );
        if (!upsertedRepo.hasCommits) {
          waitUntil(backfillRepo(upsertedRepo.id, meta.full_name, meta.default_branch || null, 10).then(() => undefined));
        }

        assignments.push({
          user_id: invitedUserId,
          repository_id: upsertedRepo.id,
          assigned_by: user.id
        });
      }

      if (assignments.length > 0) {
        const { error: assignError } = await adminAuthClient
          .from('user_repositories')
          .upsert(assignments, { onConflict: 'user_id,repository_id', ignoreDuplicates: true })

        if (assignError) throw assignError
      }
    }

    if (contentType.includes('application/json')) {
      return NextResponse.json({ success: true, message: `Invited ${email} as ${role}` })
    } else {
      return NextResponse.redirect(new URL('/dashboard?message=User+invited+successfully', request.url), 303)
    }

  } catch (error: any) {
    console.error('Invite error:', error)
    if (contentType.includes('application/json')) {
      return NextResponse.json({ error: error.message || 'Failed to invite user' }, { status: 500 })
    } else {
      return NextResponse.redirect(new URL(`/dashboard?error=${encodeURIComponent(error.message || 'Failed')}`, request.url), 303)
    }
  }
}
