import { BotIcon, CpuIcon, UserIcon, WrenchIcon } from "lucide-react"

import { cn } from "@/lib/utils"

type Role = "user" | "assistant" | "system" | "tool"

const CONFIG: Record<Role, { Icon: typeof UserIcon; className: string; label: string }> = {
  user: {
    Icon: UserIcon,
    label: "User",
    className: "bg-primary text-primary-foreground",
  },
  assistant: {
    Icon: BotIcon,
    label: "Assistant",
    className: "bg-secondary text-secondary-foreground border-border border",
  },
  system: {
    Icon: CpuIcon,
    label: "System",
    className: "bg-muted text-muted-foreground border-border border",
  },
  tool: {
    Icon: WrenchIcon,
    label: "Tool",
    className: "bg-accent text-accent-foreground border-border border",
  },
}

export function RoleAvatar({ role, size = "sm" }: { role: Role; size?: "sm" | "md" }) {
  const cfg = CONFIG[role]
  const sizeClass = size === "sm" ? "size-7" : "size-9"
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full",
        sizeClass,
        cfg.className,
      )}
      aria-label={cfg.label}
      title={cfg.label}
    >
      <cfg.Icon className={size === "sm" ? "size-4" : "size-5"} />
    </div>
  )
}

export type { Role }
