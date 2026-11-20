"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, Sparkles, FileText, MessageSquare, Zap, ExternalLink, AlertTriangle } from "lucide-react";
import Markdown from "@/components/Markdown";
import ImpactBadge from "@/components/ImpactBadge";
import { SourceList, Source } from "@/components/AskChat";

export interface CommitItem {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  avatar?: string;
  date: string;
  url: string;
  analysis: null | {
    brief: string;
    impactLevel: string;
    breakingChanges: string[];
    domains: string[];
    stats?: { files_changed: number; additions: number; deletions: number } | null;
    hasReport?: boolean;
  };
}

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  cached?: boolean;
  error?: boolean;
}

const CHAT_SUGGESTIONS = ["What does this change do?", "Could this break anything?", "Why was this change needed?"];

function loginHref() {
  const here = typeof window !== "undefined" ? window.location.pathname + window.location.search : "/";
  return `/login?next=${encodeURIComponent(here)}`;
}

export default function CommitCard({ commit, repoUrl }: { commit: CommitItem; repoUrl: string }) {
  const [analysis, setAnalysis] = useState(commit.analysis);
  const [brief, setBrief] = useState<{ loading: boolean; text?: string; error?: string; needsLogin?: boolean; related?: Source[]; cached?: boolean } | null>(
    commit.analysis ? { loading: false, text: commit.analysis.brief, cached: true } : null
  );
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);

  const title = commit.message.split("\n")[0];

  const explain = async () => {
    setBrief({ loading: true });
    try {
      const res = await fetch("/api/explain/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl, sha: commit.sha }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBrief({ loading: false, error: data.error || "Failed to load explanation.", needsLogin: data.needsLogin });
        return;
      }
      setBrief({ loading: false, text: data.summary, related: data.related, cached: data.cached });
      setAnalysis({
        brief: data.summary,
        impactLevel: data.analysis.impactLevel,
        breakingChanges: data.analysis.breakingChanges,
        domains: data.analysis.domains,
        stats: data.analysis.stats,
        hasReport: analysis?.hasReport,
      });
    } catch {
      setBrief({ loading: false, error: "Couldn't reach the server." });
    }
  };

  const ask = async (question: string) => {
    if (!question.trim() || chatLoading) return;
    const history = messages.filter((m) => !m.error).map(({ role, content }) => ({ role, content }));
    const next: ChatMsg[] = [...messages, { role: "user", content: question.trim() }];
    setMessages(next);
    setInput("");
    setChatLoading(true);
    try {
      const res = await fetch("/api/explain/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl, sha: commit.sha, userMessage: question.trim(), history }),
      });
      const data = await res.json();
      setMessages([
        ...next,
        res.ok
          ? { role: "assistant", content: data.answer, sources: data.sources, cached: data.cached }
          : { role: "assistant", content: data.error || "Sorry, I couldn't answer that.", error: true },
      ]);
    } catch {
      setMessages([...next, { role: "assistant", content: "Couldn't reach the server.", error: true }]);
    } finally {
      setChatLoading(false);
    }
  };

  const pdfHref = `/api/explain/pdf?repoUrl=${encodeURIComponent(repoUrl)}&sha=${commit.sha}`;

  return (
    <div className="bg-[#111111]/80 border border-zinc-800/80 rounded-2xl p-5 transition-colors hover:border-purple-500/30">
      <div className="flex gap-4 items-start">
        {commit.avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={commit.avatar} alt="" className="w-10 h-10 rounded-full border border-zinc-700/50 shrink-0" />
        ) : (
          <div className="w-10 h-10 rounded-full bg-zinc-800 border border-zinc-700/50 flex items-center justify-center shrink-0 text-sm font-bold text-zinc-400">
            {commit.author.substring(0, 2).toUpperCase()}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            {analysis && <ImpactBadge level={analysis.impactLevel} />}
            <h3 className="text-base font-semibold text-zinc-100 truncate">{title}</h3>
          </div>
          <p className="text-sm text-zinc-500 flex items-center gap-2 flex-wrap">
            <span className="font-medium text-zinc-400">{commit.author}</span>
            <span>·</span>
            <span>{new Date(commit.date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</span>
            <a href={commit.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs px-1.5 py-0.5 rounded bg-zinc-800/80 text-zinc-400 hover:text-white">
              {commit.shortSha} <ExternalLink className="w-3 h-3" />
            </a>
            {analysis?.stats && (
              <span className="text-xs">
                {analysis.stats.files_changed} files <span className="text-emerald-500">+{analysis.stats.additions}</span>{" "}
                <span className="text-red-500">-{analysis.stats.deletions}</span>
              </span>
            )}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mt-4 sm:pl-14">
        {!brief && (
          <button onClick={explain} className="flex items-center gap-2 px-4 py-2 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20 border border-purple-500/20 rounded-xl text-sm font-medium">
            <Sparkles className="w-4 h-4" /> Explain briefly
          </button>
        )}
        <a href={pdfHref} className="flex items-center gap-2 px-4 py-2 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20 border border-blue-500/20 rounded-xl text-sm font-medium">
          <FileText className="w-4 h-4" /> {analysis?.hasReport ? "Download PDF (ready)" : "Detailed PDF"}
        </a>
        <button
          onClick={() => setChatOpen(!chatOpen)}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border ${chatOpen ? "bg-zinc-800 text-white border-zinc-600" : "bg-zinc-800/50 text-zinc-400 hover:text-zinc-200 border-zinc-700/50"}`}
        >
          <MessageSquare className="w-4 h-4" /> {chatOpen ? "Close Oracle" : "Ask Oracle"}
        </button>
      </div>

      {brief && (
        <div className="mt-4 sm:ml-14 p-4 bg-zinc-900/80 rounded-xl border border-zinc-800/80 text-zinc-300 text-sm">
          {brief.loading ? (
            <div className="flex items-center gap-2 text-zinc-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Analysing this commit and its history…
            </div>
          ) : brief.error ? (
            <div className="text-red-300">
              {brief.error}
              {brief.needsLogin && (
                <Link href={loginHref()} className="ml-2 text-white underline">Sign in with GitHub</Link>
              )}
            </div>
          ) : (
            <>
              <Markdown text={brief.text || ""} />
              {analysis && analysis.breakingChanges.length > 0 && (
                <div className="mt-3 bg-red-500/5 border border-red-500/20 rounded-lg p-3">
                  <p className="text-xs font-semibold text-red-400 flex items-center gap-1 mb-1"><AlertTriangle className="w-3 h-3" /> Breaking changes</p>
                  <ul className="list-disc list-inside text-red-200/80 space-y-0.5">
                    {analysis.breakingChanges.map((b, i) => <li key={i}>{b}</li>)}
                  </ul>
                </div>
              )}
              {brief.related && brief.related.length > 0 && <SourceList sources={brief.related} />}
              {brief.cached && (
                <p className="mt-2 text-[11px] text-emerald-400 inline-flex items-center gap-1"><Zap className="w-3 h-3" /> Instant: already analysed</p>
              )}
            </>
          )}
        </div>
      )}

      {chatOpen && (
        <div className="mt-4 sm:ml-14 border border-zinc-800/80 bg-zinc-900/50 rounded-xl overflow-hidden">
          <div className="max-h-80 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && (
              <div className="space-y-2">
                <p className="text-zinc-500 text-sm">Ask what this commit does, why it was made, or how it fits the project. Answers use the project&apos;s history too.</p>
                <div className="flex flex-wrap gap-2">
                  {CHAT_SUGGESTIONS.map((s) => (
                    <button key={s} onClick={() => ask(s)} className="text-xs px-3 py-1.5 rounded-full border border-zinc-700 text-zinc-300 hover:border-purple-500/50 hover:text-white">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                className={`p-3 rounded-xl text-sm ${
                  m.role === "user"
                    ? "bg-zinc-800 text-zinc-200 ml-auto max-w-[85%] border border-zinc-700"
                    : m.error
                      ? "bg-red-500/10 border border-red-500/30 text-red-300 mr-auto max-w-[95%]"
                      : "bg-purple-900/20 text-purple-50 border border-purple-500/20 mr-auto max-w-[95%]"
                }`}
              >
                {m.role === "assistant" && !m.error ? <Markdown text={m.content} /> : m.content}
                {m.sources && <SourceList sources={m.sources} />}
                {m.cached && <p className="mt-2 text-[11px] text-emerald-400 inline-flex items-center gap-1"><Zap className="w-3 h-3" /> Instant (cached)</p>}
              </div>
            ))}
            {chatLoading && <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" /> Thinking…</div>}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); ask(input); }} className="flex gap-2 p-3 bg-zinc-900 border-t border-zinc-800/80">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              maxLength={4000}
              placeholder="Ask the Oracle…"
              className="flex-1 bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-sm text-zinc-100 outline-none focus:border-purple-500/50 placeholder:text-zinc-600"
            />
            <button type="submit" disabled={chatLoading || !input.trim()} className="bg-purple-600 hover:bg-purple-500 text-white px-5 py-2.5 rounded-xl text-sm font-medium disabled:opacity-50">
              Send
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
