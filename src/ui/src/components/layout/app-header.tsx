import { Link } from "@tanstack/react-router"
import { ActivityIcon, BarChart3Icon, ListIcon } from "lucide-react"

import { ThemeToggle } from "@/components/layout/theme-toggle"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

interface NavItem {
  to: string
  label: string
  icon: typeof ListIcon
}

const NAV: NavItem[] = [
  { to: "/", label: "Requests", icon: ListIcon },
  { to: "/live", label: "Live", icon: ActivityIcon },
  { to: "/metrics", label: "Metrics", icon: BarChart3Icon },
]

export function AppHeader() {
  return (
    <header className="border-border bg-background/70 sticky top-0 z-30 flex h-14 items-center gap-4 border-b px-4 backdrop-blur-md">
      <Link to="/" className="flex items-center gap-2 font-medium">
        <span className="bg-primary text-primary-foreground flex size-6 items-center justify-center rounded-sm font-semibold">
          c
        </span>
        <span className="hidden sm:inline">claude-plan-api · audit</span>
      </Link>

      <Separator orientation="vertical" className="mx-1 hidden h-6 sm:block" />

      <nav className="flex flex-1 items-center gap-1">
        {NAV.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className={cn(
              "text-muted-foreground hover:text-foreground hover:bg-accent inline-flex h-8 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors",
            )}
            activeProps={{
              className: "text-foreground bg-accent",
            }}
          >
            <item.icon data-icon="inline-start" />
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="flex items-center gap-1">
        <ThemeToggle />
      </div>
    </header>
  )
}
