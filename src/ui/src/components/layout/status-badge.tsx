import { Badge } from "@/components/ui/badge"

/** Colour-by-status-class badge with a numeric label. Uses shadcn Badge variants only. */
export function StatusBadge({ status }: { status: number | null | undefined }) {
  if (status == null) {
    return <Badge variant="outline">—</Badge>
  }
  if (status >= 500) {
    return <Badge variant="destructive">{status}</Badge>
  }
  if (status >= 400) {
    return <Badge variant="destructive">{status}</Badge>
  }
  if (status >= 300) {
    return <Badge variant="secondary">{status}</Badge>
  }
  // 2xx (and any other success-ish) — use default variant.
  return <Badge>{status}</Badge>
}

/** Small pill for a model identifier (truncated on narrow screens). */
export function ModelBadge({ model }: { model: string | null | undefined }) {
  if (!model) {
    return <Badge variant="outline" className="font-mono text-xs">—</Badge>
  }
  return (
    <Badge variant="secondary" className="font-mono text-xs">
      {model}
    </Badge>
  )
}
