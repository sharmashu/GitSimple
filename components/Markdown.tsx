"use client";

import React from "react";

/**
 * Small, safe Markdown renderer (no innerHTML): headings, bullets, numbered lists,
 * code blocks, inline code, bold and links. Enough for AI answers.
 */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith("`") && p.endsWith("`") && p.length > 2) {
          return <code key={i} className="px-1 py-0.5 rounded bg-zinc-800 text-purple-300 font-mono text-[0.85em]">{p.slice(1, -1)}</code>;
        }
        if (p.startsWith("**") && p.endsWith("**") && p.length > 4) {
          // Bold text can itself contain `code` or links: render its inside the same way
          return <strong key={i} className="text-white font-semibold"><Inline text={p.slice(2, -2)} /></strong>;
        }
        const link = p.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
        if (link) {
          return <a key={i} href={link[2]} target="_blank" rel="noreferrer" className="text-purple-400 underline">{link[1]}</a>;
        }
        return <React.Fragment key={i}>{p}</React.Fragment>;
      })}
    </>
  );
}

export default function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const lines = (text || "").replace(/\r/g, "").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={blocks.length} className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 overflow-x-auto text-xs font-mono text-zinc-300">
          {code.join("\n")}
        </pre>
      );
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const size = h[1].length <= 2 ? "text-base" : "text-sm";
      blocks.push(<p key={blocks.length} className={`${size} font-semibold text-white mt-2`}><Inline text={h[2]} /></p>);
      i++;
      continue;
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
        i++;
      }
      const ListTag = ordered ? "ol" : "ul";
      blocks.push(
        <ListTag key={blocks.length} className={`${ordered ? "list-decimal" : "list-disc"} pl-5 space-y-1`}>
          {items.map((it, j) => <li key={j}><Inline text={it} /></li>)}
        </ListTag>
      );
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*+]|\d+[.)])\s+)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={blocks.length}><Inline text={para.join(" ")} /></p>);
  }

  return <div className={`space-y-2 leading-relaxed ${className}`}>{blocks}</div>;
}
