"use client";

import { useEffect, useState, Suspense, useCallback } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { Loader2, Github, Lock, Globe, Sparkles, GitCommit, Zap, FileText, MessageSquare } from "lucide-react";
import CommitCard, { CommitItem } from "@/components/CommitCard";
import AskChat from "@/components/AskChat";

interface RepoInfo {
  id: string;
  name: string;
  url: string;
  private: boolean;
}

const EXAMPLES = ["vercel/swr", "facebook/react", "supabase/supabase"];

/** Accepts "owner/repo", "github.com/owner/repo" or a full URL. */
function normalizeRepoInput(v: string): string {
  const s = v.trim().replace(/\/+$/, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return `https://github.com/${s}`;
  if (s.startsWith("github.com/")) return `https://${s}`;
  return s;
}

function HomeContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialRepo = searchParams.get("repo") || "";

  const [repoInput, setRepoInput] = useState(initialRepo);
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [commits, setCommits] = useState<CommitItem[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<{ message: string; needsLogin?: boolean; needsGithub?: boolean } | null>(null);
  const [tab, setTab] = useState<"commits" | "ask">("commits");

  const load = useCallback(async (url: string, pageNum = 1) => {
    if (!url) return;
    pageNum === 1 ? setLoading(true) : setLoadingMore(true);
    setError(null);
    try {
      const res = await fetch(`/api/commits?repo=${encodeURIComponent(url)}&page=${pageNum}`);
      const data = await res.json();
      if (!res.ok) {
        setError({ message: data.error || "Failed to fetch commits", needsLogin: data.needsLogin, needsGithub: data.needsGithub });
        if (pageNum === 1) { setRepo(null); setCommits([]); }
        return;
      }
      setRepo(data.repo);
      setCommits((prev) => (pageNum === 1 ? data.commits : [...prev, ...data.commits]));
      setPage(pageNum);
      setHasMore(data.hasMore);
    } catch {
      setError({ message: "Couldn't reach the server." });
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    if (initialRepo) {
      setRepoInput(initialRepo);
      setTab("commits");
      load(normalizeRepoInput(initialRepo));
    }
  }, [initialRepo, load]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const url = normalizeRepoInput(repoInput);
    if (!url) return;
    // Put the repo in the URL so the page can be shared / bookmarked
    router.push(`/?repo=${encodeURIComponent(url)}`);
  };

  const loginNext = `/login?next=${encodeURIComponent(`/?repo=${encodeURIComponent(normalizeRepoInput(repoInput))}`)}`;

  return (
    <main className="min-h-full bg-[#0a0a0a] text-zinc-300 font-sans selection:bg-purple-500/30">
      <div className="py-12 px-4">
        <div className="max-w-4xl mx-auto flex flex-col items-center text-center space-y-4 mb-10">
          <div className="w-14 h-14 bg-gradient-to-br from-indigo-500 to-purple-500 rounded-2xl flex items-center justify-center shadow-lg shadow-purple-500/20">
            <Github className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-white mt-4">
            Understand any <span className="text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-indigo-500">GitHub repository</span>
          </h1>
          <p className="text-lg text-zinc-400 max-w-2xl mx-auto">
            Plain-English commit explanations, an AI Oracle that knows the project&apos;s history, and PDF reports.
          </p>

          <form onSubmit={submit} className="w-full max-w-xl mt-6 flex gap-2">
            <input
              type="text"
              value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)}
              placeholder="https://github.com/owner/repo  or  owner/repo"
              className="flex-1 bg-[#111111] border border-zinc-800 text-zinc-100 px-4 py-3 rounded-xl outline-none focus:border-purple-500"
              required
            />
            <button type="submit" disabled={loading || !repoInput.trim()} className="bg-zinc-100 hover:bg-white text-zinc-900 font-semibold px-6 py-3 rounded-xl disabled:opacity-50">
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : "Open"}
            </button>
          </form>

          <div className="flex flex-wrap justify-center items-center gap-2 text-xs text-zinc-500">
            <span>Try:</span>
            {EXAMPLES.map((ex) => (
              <button key={ex} onClick={() => router.push(`/?repo=${encodeURIComponent(`https://github.com/${ex}`)}`)} className="px-2.5 py-1 rounded-full border border-zinc-800 hover:border-zinc-600 hover:text-zinc-300">
                {ex}
              </button>
            ))}
          </div>

          <div className="grid sm:grid-cols-2 gap-3 w-full max-w-xl pt-4 text-left">
            <div className="p-3 rounded-xl border border-zinc-800 bg-zinc-900/40">
              <p className="text-sm text-white font-medium flex items-center gap-2"><Globe className="w-4 h-4 text-emerald-400" /> Public repos</p>
              <p className="text-xs text-zinc-500 mt-1">No account needed. Just paste the link.</p>
            </div>
            <div className="p-3 rounded-xl border border-zinc-800 bg-zinc-900/40">
              <p className="text-sm text-white font-medium flex items-center gap-2"><Lock className="w-4 h-4 text-amber-400" /> Private repos</p>
              <p className="text-xs text-zinc-500 mt-1">
                <Link href="/login" className="text-purple-400 hover:underline">Sign in with GitHub</Link> and open any repo you have access to.
              </p>
            </div>
          </div>

          {error && (
            <div className="w-full max-w-xl mt-2 p-4 rounded-xl border border-red-500/30 bg-red-500/5 text-left">
              <p className="text-red-300 text-sm">{error.message}</p>
              {(error.needsLogin || error.needsGithub) && (
                <Link href={loginNext} className="inline-flex items-center gap-2 mt-3 text-sm font-medium text-white bg-purple-600 hover:bg-purple-500 px-4 py-2 rounded-lg">
                  <Github className="w-4 h-4" /> Sign in with GitHub
                </Link>
              )}
            </div>
          )}
        </div>

        {!repo && !loading && !error && (
          <div className="max-w-4xl mx-auto grid md:grid-cols-3 gap-4 pb-8">
            {[
              { icon: Sparkles, title: "Explain briefly", text: "Each commit summarised in plain English, with the earlier commits it builds on." },
              { icon: MessageSquare, title: "Oracle chat", text: "Ask about a commit or the whole repo. Answers cite the commits they come from." },
              { icon: FileText, title: "PDF reports", text: "A detailed engineering report per commit, including how it fits the project history." },
            ].map((f) => (
              <div key={f.title} className="p-5 rounded-2xl border border-zinc-800 bg-[#111111]/60">
                <f.icon className="w-5 h-5 text-purple-400" />
                <p className="text-white font-medium mt-3">{f.title}</p>
                <p className="text-sm text-zinc-500 mt-1">{f.text}</p>
              </div>
            ))}
            <p className="md:col-span-3 text-center text-xs text-zinc-600 flex items-center justify-center gap-1">
              <Zap className="w-3 h-3" /> Results are shared and cached: if anyone has analysed a commit before, you get it instantly.
            </p>
          </div>
        )}

        {repo && (
          <div className="max-w-4xl mx-auto mb-10">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
              <div className="flex items-center gap-3">
                <a href={repo.url} target="_blank" rel="noreferrer" className="text-xl font-bold text-white hover:underline">{repo.name}</a>
                <span className={`text-xs px-2 py-0.5 rounded-full border ${repo.private ? "border-amber-500/30 text-amber-300 bg-amber-500/10" : "border-emerald-500/30 text-emerald-300 bg-emerald-500/10"}`}>
                  {repo.private ? "Private" : "Public"}
                </span>
              </div>
              <div className="flex bg-zinc-900 border border-zinc-800 rounded-xl p-1 w-fit">
                <button onClick={() => setTab("commits")} className={`px-4 py-1.5 rounded-lg text-sm font-medium flex items-center gap-2 ${tab === "commits" ? "bg-zinc-100 text-zinc-900" : "text-zinc-400 hover:text-white"}`}>
                  <GitCommit className="w-4 h-4" /> Commits
                </button>
                <button onClick={() => setTab("ask")} className={`px-4 py-1.5 rounded-lg text-sm font-medium flex items-center gap-2 ${tab === "ask" ? "bg-zinc-100 text-zinc-900" : "text-zinc-400 hover:text-white"}`}>
                  <Sparkles className="w-4 h-4" /> Ask the Repo
                </button>
              </div>
            </div>

            {tab === "commits" ? (
              <div className="space-y-4">
                {commits.length === 0 && <p className="text-center text-zinc-500 py-10">This repository has no commits yet.</p>}
                {commits.map((c) => <CommitCard key={c.sha} commit={c} repoUrl={repo.url} />)}
                {hasMore && (
                  <div className="text-center pt-2">
                    <button
                      onClick={() => load(repo.url, page + 1)}
                      disabled={loadingMore}
                      className="px-5 py-2 rounded-xl border border-zinc-700 text-sm text-zinc-300 hover:text-white hover:border-zinc-500 disabled:opacity-50"
                    >
                      {loadingMore ? <Loader2 className="w-4 h-4 animate-spin inline" /> : "Load older commits"}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <AskChat key={repo.url} mode="url" repoUrl={repo.url} repoName={repo.name} />
            )}
          </div>
        )}
      </div>
    </main>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<div className="min-h-full bg-[#0a0a0a]" />}>
      <HomeContent />
    </Suspense>
  );
}
