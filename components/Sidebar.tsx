"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, LayoutDashboard, Github, Activity, MessageSquare, Users } from "lucide-react";

export default function Sidebar() {
  const pathname = usePathname();

  const navItems = [
    { name: "Home", href: "/", icon: Home },
    { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    { name: "Timeline", href: "/dashboard/timeline", icon: Activity },
    { name: "Ask the Repo", href: "/dashboard/ask", icon: MessageSquare },
    { name: "Team Activity", href: "/dashboard/team", icon: Users },
  ];

  return (
    <aside className="w-64 bg-[#111111] border-r border-zinc-800 flex flex-col hidden md:flex">
      <div className="p-6 flex items-center gap-2">
        <Github className="w-6 h-6 text-purple-500" />
        <span className="text-xl font-bold text-white tracking-tight">GitSimple</span>
      </div>
      
      <nav className="flex-1 px-4 space-y-2 mt-4">
        {navItems.map((item) => {
          const isActive = pathname === item.href;
          const Icon = item.icon;
          
          return (
            <Link
              key={item.name}
              href={item.href}
              className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${
                isActive 
                  ? "bg-purple-500/10 text-purple-400 font-medium" 
                  : "text-zinc-400 hover:text-white hover:bg-zinc-800/50"
              }`}
            >
              <Icon className="w-5 h-5" />
              {item.name}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
