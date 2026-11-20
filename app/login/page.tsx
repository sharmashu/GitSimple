import { login, signInWithGithub, signInWithGoogle } from './actions'
import { Github } from 'lucide-react'

export default function LoginPage({
  searchParams,
}: {
  searchParams: { message?: string; next?: string }
}) {
  return (
    <div className="flex-1 flex flex-col w-full px-8 sm:max-w-md justify-center gap-2 mx-auto pt-20">
      <div className="animate-in flex-1 flex flex-col w-full justify-center gap-2 text-zinc-100">
        <p className="text-center text-sm text-zinc-400 -mt-2 mb-4">Public repositories work without an account. Sign in with <strong>GitHub</strong> to open your private repositories.</p>
        <h2 className="text-2xl font-bold mb-4 text-center order-first">Log in to GitSimple</h2>
        
        <form action={signInWithGithub}>
          <input type="hidden" name="next" value={searchParams?.next || ''} />
          <button className="w-full flex items-center justify-center gap-2 bg-purple-600 text-white rounded-md px-4 py-2 mb-2 hover:bg-purple-500 transition-colors">
            <Github className="w-4 h-4" />
            Continue with GitHub
          </button>
        </form>
        
        <form action={signInWithGoogle}>
          <input type="hidden" name="next" value={searchParams?.next || ''} />
          <button className="w-full flex items-center justify-center gap-2 bg-white text-slate-700 border border-slate-300 rounded-md px-4 py-2 mb-6 hover:bg-slate-50 transition-colors">
            Continue with Google
          </button>
        </form>

        <div className="relative flex py-2 items-center">
          <div className="flex-grow border-t border-slate-300"></div>
          <span className="flex-shrink-0 mx-4 text-slate-400 text-sm">Or with email</span>
          <div className="flex-grow border-t border-slate-300"></div>
        </div>

        <form className="flex flex-col w-full gap-2" action={login}>
        <input type="hidden" name="next" value={searchParams?.next || ''} />
        <label className="text-md" htmlFor="email">
          Email
        </label>
        <input
          className="rounded-md px-4 py-2 bg-inherit border border-zinc-700 mb-6 text-white"
          name="email"
          placeholder="you@example.com"
          required
        />
        <label className="text-md" htmlFor="password">
          Password
        </label>
        <input
          className="rounded-md px-4 py-2 bg-inherit border border-zinc-700 mb-6 text-white"
          type="password"
          name="password"
          placeholder="••••••••"
          required
        />
        <button className="bg-white text-black font-medium rounded-md px-4 py-2 mb-2 hover:bg-zinc-200">
          Sign In
        </button>
        {searchParams?.message && (
          <p className="mt-4 p-4 bg-zinc-800 text-zinc-100 rounded-md text-center">
            {searchParams.message}
          </p>
        )}
        </form>
      </div>
    </div>
  )
}
