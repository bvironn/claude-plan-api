import { CheckIcon, CopyIcon } from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { toast } from "sonner"

/**
 * Copy-to-clipboard button with a 1.5 s success state (icon swap + tooltip).
 * Sonner toast fires on success for stronger affordance.
 */
export function CopyButton({
  value,
  label = "Copy",
  size = "icon",
}: {
  value: string
  label?: string
  size?: "icon" | "sm" | "default"
}) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      toast.success(`${label === "Copy" ? "Copied" : `${label} copied`}`)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      toast.error(`Failed to copy: ${(err as Error).message}`)
    }
  }

  const Icon = copied ? CheckIcon : CopyIcon

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size={size}
          onClick={handleCopy}
          aria-label={label}
          data-copied={copied ? "true" : undefined}
        >
          <Icon data-icon={size === "icon" ? undefined : "inline-start"} />
          {size !== "icon" && (copied ? "Copied" : label)}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied!" : label}</TooltipContent>
    </Tooltip>
  )
}
