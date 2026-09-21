"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, Github, Sparkles, FileText, MessageSquare } from "lucide-react";

function HomeContent() {
  const searchParams = useSearchParams();
  const initialRepo = searchParams.get("repo");

  const [repoUrl, setRepoUrl] = useState(initialRepo || "");
  const [loading, setLoading] = useState(false);
  const [commits, setCommits] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  // States for individual commits
  const [briefs, setBriefs] = useState<Record<string, { loading: boolean, text: string | null }>>({});
  const [activeChat, setActiveChat] = useState<string | null>(null); // commit sha
  const [chatMessages, setChatMessages] = useState<Record<string, { role: string, content: string }[]>>({});
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);

  const fetchCommitsData = async (url: string) => {
    if (!url) return;

    setLoading(true);
    setError(null);
    setCommits([]);

    try {
      const res = await fetch(`/api/commits?repo=${encodeURIComponent(url)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to fetch commits");

      setCommits(data.commits);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initialRepo) {
      fetchCommitsData(initialRepo);
    }
  }, [initialRepo]);

  const fetchCommits = async (e: React.FormEvent) => {
    e.preventDefault();
    fetchCommitsData(repoUrl);
  };

  const getBriefExplanation = async (commit: any) => {
    if (briefs[commit.sha]) return; // already loaded or loading

    setBriefs(prev => ({ ...prev, [commit.sha]: { loading: true, text: null } }));

    try {
      const res = await fetch("/api/explain/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diffUrl: commit.diffUrl, repoUrl: repoUrl, sha: commit.sha })
      });
      const data = await res.json();
      setBriefs(prev => ({ ...prev, [commit.sha]: { loading: false, text: data.summary } }));
    } catch (err) {
      setBriefs(prev => ({ ...prev, [commit.sha]: { loading: false, text: "Failed to load explanation." } }));
    }
  };

  const handleChat = async (commit: any, e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;

    const userMessage = chatInput.trim();
    setChatInput("");

    const history = chatMessages[commit.sha] || [];
    const updatedHistory = [...history, { role: "user", content: userMessage }];

    setChatMessages(prev => ({ ...prev, [commit.sha]: updatedHistory }));
    setChatLoading(true);

    try {
      const res = await fetch("/api/explain/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          diffUrl: commit.diffUrl,
          repoUrl: repoUrl,
          sha: commit.sha,
          userMessage: userMessage,
          history: history
        })
      });
      const data = await res.json();
      setChatMessages(prev => ({
        ...prev,
        [commit.sha]: [...updatedHistory, { role: "assistant", content: data.answer }]
      }));
    } catch (err) {
      setChatMessages(prev => ({
        ...prev,
        [commit.sha]: [...updatedHistory, { role: "assistant", content: "Sorry, I couldn't connect to the Oracle." }]
      }));
    } finally {
      setChatLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-zinc-300 font-sans selection:bg-purple-500/30">
      <div className="py-12 px-4">
        {/* Header */}
        <div className="max-w-4xl mx-auto flex flex-col items-center text-center space-y-4 mb-12">
          <div className="w-14 h-14 bg-gradient-to-br from-indigo-500 to-purple-500 rounded-2xl flex items-center justify-center shadow-lg shadow-purple-500/20">
            <Github className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-white mt-4">
            Analyze <span className="text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-indigo-500">Public Git Profiles</span>
          </h1>
          <p className="text-lg text-zinc-400 max-w-2xl mx-auto">
            Paste any public GitHub repository URL to understand its commits, architecture, and logic simply in seconds.
          </p>

        <form onSubmit={fetchCommits} className="w-full max-w-xl mt-6 flex gap-2">
          <input
            type="url"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/"
            className="flex-1 bg-[#111111] border border-zinc-800 text-zinc-100 px-4 py-3 rounded-xl outline-none focus:border-purple-500"
            required
          />
          <button
            type="submit"
            disabled={loading || !repoUrl}
            className="bg-zinc-100 hover:bg-white text-zinc-900 font-semibold px-6 py-3 rounded-xl transition-all disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : "Fetch"}
          </button>
        </form>
        {error && <p className="text-red-400 mt-2">{error}</p>}
      </div>

      {/* Commits List */}
      {commits.length > 0 && (
        <div className="max-w-4xl mx-auto mb-10">
          <div className="flex items-center gap-4 mb-8">
            <div className="h-px bg-gradient-to-r from-transparent to-zinc-800 flex-1"></div>
            <h2 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-purple-500 animate-pulse"></span>
              Latest Commits
            </h2>
            <div className="h-px bg-gradient-to-l from-transparent to-zinc-800 flex-1"></div>
          </div>
          <div className="space-y-5">
            {commits.slice(0, 15).map((commit) => {
              const isChatOpen = activeChat === commit.sha;
              const brief = briefs[commit.sha];
              const hasBrief = !!brief;

              return (
                <div key={commit.sha} className="bg-[#111111]/80 backdrop-blur-md border border-zinc-800/80 rounded-2xl p-5 shadow-xl transition-all duration-300 hover:border-purple-500/30 hover:bg-[#141414] hover:shadow-purple-500/5 group">
                  <div className="flex gap-4 items-start mb-5">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-zinc-800 to-zinc-900 border border-zinc-700/50 flex items-center justify-center shrink-0 shadow-inner">
                      <span className="text-sm font-bold text-zinc-400 group-hover:text-purple-400 transition-colors">
                        {commit.author.substring(0, 2).toUpperCase()}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 flex-wrap mb-1">
                        <h3 className="text-base font-semibold text-zinc-100 truncate group-hover:text-white transition-colors">
                          {commit.message.split('\n')[0]}
                        </h3>
                        <span className="px-2 py-0.5 rounded-md bg-zinc-800/80 border border-zinc-700/50 text-xs font-mono text-zinc-400">
                          {commit.shortSha}
                        </span>
                      </div>
                      <p className="text-sm text-zinc-500 flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-zinc-400">{commit.author}</span>
                        <span>committed on</span>
                        <span className="text-zinc-400">
                          {new Date(commit.date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                        </span>
                      </p>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex flex-wrap gap-3 pl-14">
                    {!hasBrief && (
                      <button
                        onClick={() => getBriefExplanation(commit)}
                        className="flex items-center gap-2 px-4 py-2 bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 hover:text-purple-300 border border-purple-500/20 rounded-xl text-sm font-medium transition-all"
                      >
                        <Sparkles className="w-4 h-4" />
                        Explain Simply
                      </button>
                    )}

                    <a
                      href={`/api/explain/pdf?diffUrl=${encodeURIComponent(commit.diffUrl)}&repoUrl=${encodeURIComponent(repoUrl)}&sha=${commit.sha}`}
                      target="_blank"
                      className="flex items-center gap-2 px-4 py-2 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 hover:text-blue-300 border border-blue-500/20 rounded-xl text-sm font-medium transition-all"
                    >
                      <FileText className="w-4 h-4" />
                      Detailed PDF
                    </a>

                    <button
                      onClick={() => setActiveChat(isChatOpen ? null : commit.sha)}
                      className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all border ${
                        isChatOpen 
                          ? "bg-zinc-800 text-white border-zinc-600" 
                          : "bg-zinc-800/50 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 border-zinc-700/50 hover:border-zinc-700"
                      }`}
                    >
                      <MessageSquare className="w-4 h-4" />
                      {isChatOpen ? "Close Chat" : "Ask Oracle"}
                    </button>
                  </div>

                  {/* Brief Summary */}
                  {brief && (
                    <div className="mt-5 ml-14 p-4 bg-zinc-900/80 rounded-xl border border-zinc-800/80 text-zinc-300 text-sm leading-relaxed relative">
                      <div className="absolute -left-2 top-4 w-2 h-2 rotate-45 bg-zinc-900/80 border-l border-b border-zinc-800/80"></div>
                      {brief.loading ? (
                        <div className="flex items-center gap-2 text-zinc-500">
                          <Loader2 className="w-4 h-4 animate-spin" /> Analyzing commit...
                        </div>
                      ) : (
                        brief.text
                      )}
                    </div>
                  )}

                  {/* Chatbot Area */}
                  {isChatOpen && (
                    <div className="mt-5 ml-14 border border-zinc-800/80 bg-zinc-900/50 rounded-xl overflow-hidden shadow-inner">
                      <div className="h-56 overflow-y-auto p-4 space-y-4 flex flex-col custom-scrollbar">
                        {(!chatMessages[commit.sha] || chatMessages[commit.sha].length === 0) && (
                          <div className="flex-1 flex flex-col items-center justify-center text-center opacity-50 space-y-2">
                            <MessageSquare className="w-8 h-8 text-zinc-500 mb-2" />
                            <p className="text-zinc-400 text-sm max-w-[250px]">
                              Ask me what a functionality does, or what this commit means!
                            </p>
                          </div>
                        )}
                        {chatMessages[commit.sha]?.map((msg, i) => (
                          <div key={i} className={`p-3.5 rounded-xl text-sm shadow-sm ${
                            msg.role === 'user' 
                              ? 'bg-zinc-800 text-zinc-200 ml-auto max-w-[85%] rounded-tr-sm border border-zinc-700' 
                              : 'bg-gradient-to-br from-purple-900/30 to-purple-800/10 text-purple-100 border border-purple-500/20 mr-auto max-w-[95%] rounded-tl-sm'
                          }`}>
                            {msg.content}
                          </div>
                        ))}
                      </div>
                      <form onSubmit={(e) => handleChat(commit, e)} className="flex gap-2 p-3 bg-zinc-900 border-t border-zinc-800/80">
                        <input
                          type="text"
                          value={chatInput}
                          onChange={(e) => setChatInput(e.target.value)}
                          placeholder="Ask the Oracle..."
                          className="flex-1 bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-sm text-zinc-100 outline-none focus:border-purple-500/50 focus:ring-1 focus:ring-purple-500/50 transition-all placeholder:text-zinc-600"
                        />
                        <button 
                          type="submit" 
                          disabled={chatLoading || !chatInput.trim()} 
                          className="bg-purple-600 hover:bg-purple-500 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-50 disabled:hover:bg-purple-600 flex items-center justify-center min-w-[80px] shadow-lg shadow-purple-500/20"
                        >
                          {chatLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Send"}
                        </button>
                      </form>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      </div>
    </main>
  );
}

export default function Home() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-purple-500 animate-spin" />
      </div>
    }>
      <HomeContent />
    </Suspense>
  );
}
