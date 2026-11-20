"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, MessageSquare, Send, Sparkles, GitCommit, Zap } from "lucide-react";
import Markdown from "@/components/Markdown";

export interface Source {
  sha: string;
  shortSha: string;
  title: string;
  author: string;
  url: string;
  reason?: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  error?: boolean;
  cached?: boolean;
  note?: string;
  needsLogin?: boolean;
}

const SUGGESTIONS = [
  "What changed in the last few commits?",
  "Were there any breaking changes recently?",
  "Give me an overview of how this project is structured",
  "Which parts of the codebase change the most?",
];

export function SourceList({ sources }: { sources: Source[] }) {
  if (!sources?.length) return null;
  return (
    <div className="mt-3 pt-3 border-t border-zinc-800">
      <p className="text-xs text-zinc-500 mb-1.5">Sources</p>
      <ul className="space-y-1">
        {sources.map((s) => (
          <li key={s.sha}>
            <a href={s.url} target="_blank" rel="noreferrer" className="text-xs text-zinc-400 hover:text-white flex items-center gap-1.5">
              <GitCommit className="w-3 h-3 shrink-0" />
              <span className="font-mono text-purple-300">{s.shortSha}</span>
              <span className="truncate">{s.title}</span>
              <span className="text-zinc-600 shrink-0">· {s.author}{s.reason ? ` · ${s.reason}` : ""}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Props =
  | { mode: "list"; repos: { id: string; name: string }[]; initialRepoId?: string }
  | { mode: "url"; repoUrl: string; repoName: string };

export default function AskChat(props: Props) {
  const [repoId, setRepoId] = useState(props.mode === "list" ? props.initialRepoId || props.repos[0]?.id || "" : "");
  const convoKey = props.mode === "list" ? repoId : props.repoUrl;
  const [conversations, setConversations] = useState<Record<string, Message[]>>({});
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messages = conversations[convoKey] || [];
  const isFirstQuestion = messages.length === 0;

  useEffect(() => {
    if (messages.length) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages.length, loading]);

  const ask = async (question: string) => {
    if (!question.trim() || !convoKey || loading) return;
    const history = messages.filter((m) => !m.error).map(({ role, content }) => ({ role, content }));
    const next: Message[] = [...messages, { role: "user", content: question.trim() }];
    setConversations((prev) => ({ ...prev, [convoKey]: next }));
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(props.mode === "list" ? { repoId } : { repoUrl: props.repoUrl }),
          question: question.trim(),
          history,
        }),
      });
      const data = await res.json();
      const reply: Message = res.ok
        ? {
            role: "assistant",
            content: data.answer,
            sources: data.sources,
            cached: data.cached,
            note: data.indexing ? `Answer based on ${data.indexedCommits ?? "a few"} analysed commits. More history is being read in the background, so later answers get more complete.` : undefined,
          }
        : { role: "assistant", content: data.error || "Something went wrong.", error: true, needsLogin: data.needsLogin };
      setConversations((prev) => ({ ...prev, [convoKey]: [...next, reply] }));
    } catch {
      setConversations((prev) => ({ ...prev, [convoKey]: [...next, { role: "assistant", content: "Couldn't reach the server.", error: true }] }));
    } finally {
      setLoading(false);
    }
  };

  if (props.mode === "list" && props.repos.length === 0) {
    return (
      <div className="min-h-full bg-[#0a0a0a] flex items-center justify-center p-8">
        <div className="text-center max-w-md">
          <MessageSquare className="w-10 h-10 text-zinc-600 mx-auto mb-3" />
          <p className="text-white font-medium">No repositories in your workspace yet</p>
          <p className="text-sm text-zinc-500 mt-1">
            Open any repository on the <Link href="/" className="text-purple-400 hover:underline">home page</Link> (public ones need no login),
            or track one from the <Link href="/dashboard" className="text-purple-400 hover:underline">dashboard</Link>.
          </p>
        </div>
      </div>
    );
  }

  const isPage = props.mode === "list";

  return (
    <div className={isPage ? "h-full flex flex-col bg-[#0a0a0a] text-zinc-300" : "flex flex-col bg-[#111111]/80 border border-zinc-800 rounded-2xl text-zinc-300 overflow-hidden"}>
      <header className={`${isPage ? "px-4 md:px-8 py-5" : "px-5 py-4"} border-b border-zinc-800 flex flex-col md:flex-row md:items-center md:justify-between gap-3`}>
        <div>
          <h2 className={`${isPage ? "text-2xl" : "text-lg"} font-bold text-white flex items-center gap-2`}>
            <Sparkles className="w-5 h-5 text-purple-400" /> Ask the Repo
          </h2>
          <p className="text-sm text-zinc-500">
            Answers come from {props.mode === "url" ? props.repoName : "this repository"}&apos;s analysed commit history, with sources.
          </p>
        </div>
        {props.mode === "list" && (
          <select
            value={repoId}
            onChange={(e) => setRepoId(e.target.value)}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white md:w-72"
          >
            {props.repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        )}
      </header>

      <div className={`${isPage ? "flex-1 px-4 md:px-8" : "max-h-[560px] px-5"} overflow-y-auto py-5`}>
        <div className="max-w-3xl mx-auto space-y-5">
          {isFirstQuestion && (
            <div className="text-center py-6">
              <p className="text-zinc-400 mb-4 text-sm">Try one of these (popular questions are answered instantly from cache):</p>
              <div className="grid sm:grid-cols-2 gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => ask(s)}
                    className="text-left text-sm p-3 rounded-lg border border-zinc-800 bg-zinc-900/50 hover:border-purple-500/50 hover:text-white transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
              <div
                className={
                  m.role === "user"
                    ? "max-w-[85%] bg-purple-600 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm"
                    : `max-w-[92%] rounded-2xl rounded-bl-sm px-4 py-3 text-sm border ${m.error ? "bg-red-500/10 border-red-500/30 text-red-300" : "bg-zinc-900 border-zinc-800"}`
                }
              >
                {m.role === "assistant" && !m.error ? <Markdown text={m.content} /> : <div className="whitespace-pre-wrap">{m.content}</div>}
                {m.needsLogin && (
                  <Link href={`/login?next=${encodeURIComponent(typeof window !== "undefined" ? window.location.pathname + window.location.search : "/")}`} className="inline-block mt-2 text-xs font-medium text-white bg-purple-600 hover:bg-purple-500 px-3 py-1.5 rounded-md">
                    Sign in with GitHub
                  </Link>
                )}
                {m.sources && <SourceList sources={m.sources} />}
                {(m.cached || m.note) && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                    {m.cached && <span className="inline-flex items-center gap-1 text-emerald-400"><Zap className="w-3 h-3" /> Instant (cached)</span>}
                    {m.note && <span>{m.note}</span>}
                  </div>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex items-center gap-2 text-sm text-zinc-500">
              <Loader2 className="w-4 h-4 animate-spin" /> {isFirstQuestion ? "Reading the repository's history (first question can take ~20s)…" : "Searching the history…"}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <form onSubmit={(e) => { e.preventDefault(); ask(input); }} className={`border-t border-zinc-800 ${isPage ? "px-4 md:px-8" : "px-5"} py-4`}>
        <div className="max-w-3xl mx-auto flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask anything about this repository's history…"
            maxLength={2000}
            className="flex-1 bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-purple-500/50"
          />
          <button type="submit" disabled={loading || !input.trim()} className="px-4 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white" aria-label="Send">
            <Send className="w-4 h-4" />
          </button>
        </div>
      </form>
    </div>
  );
}
