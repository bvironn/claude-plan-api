import type { ApiKeyMeta } from "@/lib/api"

/**
 * Shared API-key selector used by the Requests and Sessions telemetry views.
 *
 * A native `<select>` (no shadcn Select primitive exists in this project) whose
 * options are the metadata keys returned by `GET /api/keys`. The empty value is
 * the "All keys" default that preserves unfiltered behavior. Revoked keys
 * (those with `revoked_at`) are still listed — past requests may reference them
 * — but labeled distinctly with a "(revoked)" suffix.
 */
interface ApiKeySelectProps {
  apiKeys: ApiKeyMeta[]
  /** Selected `api_keys.id`, or `undefined` for "All keys". */
  value: number | undefined
  onChange: (next: number | undefined) => void
}

export function ApiKeySelect({ apiKeys, value, onChange }: ApiKeySelectProps) {
  return (
    <select
      className="border-input bg-background ring-offset-background focus-visible:ring-ring h-9 rounded-md border px-3 py-1 text-sm shadow-xs focus-visible:ring-1 focus-visible:outline-none"
      value={value != null ? String(value) : ""}
      onChange={(e) => {
        const v = e.target.value
        onChange(v === "" ? undefined : Number(v))
      }}
      aria-label="Filter by API key"
      data-api-key-select
    >
      <option value="">All keys</option>
      {apiKeys.map((k) => (
        <option key={k.id} value={String(k.id)}>
          {k.label} ({k.prefix}){k.revoked_at ? " (revoked)" : ""}
        </option>
      ))}
    </select>
  )
}
