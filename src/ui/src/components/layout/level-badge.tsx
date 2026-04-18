import { Badge } from "@/components/ui/badge"
import type { LogLevel } from "@/lib/types"

const LEVEL_VARIANT: Record<LogLevel, "default" | "secondary" | "destructive" | "outline"> = {
  trace: "outline",
  debug: "outline",
  info: "secondary",
  warn: "default",
  error: "destructive",
  fatal: "destructive",
}

export function LevelBadge({ level }: { level: LogLevel }) {
  return (
    <Badge variant={LEVEL_VARIANT[level]} className="w-14 justify-center font-mono text-[10px] uppercase">
      {level}
    </Badge>
  )
}
