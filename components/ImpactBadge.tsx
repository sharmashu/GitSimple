export const IMPACT_STYLES: Record<string, string> = {
  Breaking: "bg-red-500/10 text-red-400 border-red-500/30",
  Security: "bg-orange-500/10 text-orange-400 border-orange-500/30",
  Feature: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  Performance: "bg-cyan-500/10 text-cyan-400 border-cyan-500/30",
  Refactor: "bg-violet-500/10 text-violet-400 border-violet-500/30",
  Fix: "bg-blue-500/10 text-blue-400 border-blue-500/30",
};

export default function ImpactBadge({ level }: { level: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-xs font-semibold ${IMPACT_STYLES[level] || "bg-zinc-800 text-zinc-300 border-zinc-700"}`}>
      {level}
    </span>
  );
}
