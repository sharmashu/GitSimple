'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/utils/supabase/server'
import { siteUrl, safeNext } from '@/lib/site'

export async function login(formData: FormData) {
  const supabase = createClient()
  const next = safeNext(formData.get('next'))

  const { error } = await supabase.auth.signInWithPassword({
    email: formData.get('email') as string,
    password: formData.get('password') as string,
  })

  if (error) {
    return redirect(`/login?message=${encodeURIComponent(error.message)}&next=${encodeURIComponent(next)}`)
  }

  revalidatePath('/', 'layout')
  redirect(next)
}

function callbackUrl(formData?: FormData) {
  const next = safeNext(formData?.get('next'))
  return `${siteUrl()}/auth/callback?next=${encodeURIComponent(next)}`
}

export async function signInWithGithub(formData?: FormData) {
  const supabase = createClient()
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'github',
    options: {
      redirectTo: callbackUrl(formData),
      scopes: 'repo read:user user:email', // repo = read private repositories you choose to open
    },
  })
  if (error) redirect(`/login?message=${encodeURIComponent(error.message)}`)
  if (data.url) redirect(data.url)
}

export async function signInWithGoogle(formData?: FormData) {
  const supabase = createClient()
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: callbackUrl(formData) },
  })
  if (error) redirect(`/login?message=${encodeURIComponent(error.message)}`)
  if (data.url) redirect(data.url)
}
