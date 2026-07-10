import { createFileRoute } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  KeyRoundIcon,
  PlusIcon,
  ShieldOffIcon,
} from "lucide-react"
import { useMemo, useState, type FormEvent } from "react"

import {
  createApiKey,
  getUsageByApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyMeta,
  type CreatedApiKey,
  type UsageByKey,
} from "@/lib/api"
import { isStoredKeyPrefix } from "@/lib/auth"
import { formatRelativeTime, formatTokens } from "@/lib/format"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CopyButton } from "@/components/layout/copy-button"
import { RouteError } from "@/components/layout/route-error"

// ---------------------------------------------------------------------------
// Live-view auth gap (out-of-scope follow-up — see design.md "File Changes")
// ---------------------------------------------------------------------------
// The Live view's `EventSource` on the gated `/api/telemetry/stream` cannot
// carry an `Authorization` header (browser API limitation), so that view stays
// 401 under `REQUIRE_API_KEY=true`. The correct fix is a query-param /
// short-lived stream token accepted by the stream route (a security-sensitive
// backend change), deliberately deferred out of this slice. It fails soft via
// useEventStream's backoff-reconnect. Documented here so the gap is not hidden.

export const Route = createFileRoute("/keys")({
  component: KeysPage,
  errorComponent: RouteError,
})

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function KeysPage() {
  const keysQuery = useQuery({
    queryKey: ["keys"],
    queryFn: listApiKeys,
    refetchInterval: 15_000,
  })
  const usageQuery = useQuery({
    queryKey: ["keys-usage"],
    queryFn: getUsageByApiKey,
    refetchInterval: 15_000,
  })

  // Index usage rows by their attributed api_key_id so each key row can look
  // up its totals in O(1). Rows without an api_key_id are unattributed and not
  // matchable to a key.
  const usageByKeyId = useMemo(() => {
    const map = new Map<number, UsageByKey>()
    for (const row of usageQuery.data?.keys ?? []) {
      if (row.api_key_id != null) map.set(row.api_key_id, row)
    }
    return map
  }, [usageQuery.data])

  const [createOpen, setCreateOpen] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyMeta | null>(null)

  const keys = keysQuery.data?.keys ?? []

  return (
    <div className="container mx-auto flex flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <KeyRoundIcon data-icon="inline-start" />
          API keys
        </h1>
        <p className="text-muted-foreground text-sm">
          Create, inspect, and revoke the keys that authenticate clients against
          this gateway. The full key is shown only once, at creation.
        </p>
      </header>

      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs">
          {keysQuery.data ? `${keys.length} key${keys.length === 1 ? "" : "s"}` : "\u00a0"}
        </span>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <PlusIcon data-icon="inline-start" />
          Create key
        </Button>
      </div>

      {keysQuery.isError && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>Couldn't load keys</AlertTitle>
          <AlertDescription>{(keysQuery.error as Error).message}</AlertDescription>
        </Alert>
      )}

      {keysQuery.isPending ? (
        <KeysSkeleton />
      ) : keys.length === 0 ? (
        <KeysEmpty onCreate={() => setCreateOpen(true)} />
      ) : (
        <KeysTable
          keys={keys}
          usageByKeyId={usageByKeyId}
          onRevoke={setRevokeTarget}
        />
      )}

      <CreateKeyDialog open={createOpen} onOpenChange={setCreateOpen} />
      <RevokeKeyDialog target={revokeTarget} onClose={() => setRevokeTarget(null)} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

function KeysTable({
  keys,
  usageByKeyId,
  onRevoke,
}: {
  keys: ApiKeyMeta[]
  usageByKeyId: Map<number, UsageByKey>
  onRevoke: (key: ApiKeyMeta) => void
}) {
  return (
    <div className="border-border overflow-hidden rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Prefix</TableHead>
            <TableHead>Label</TableHead>
            <TableHead className="w-[130px]">Created</TableHead>
            <TableHead className="w-[170px] text-right">Usage</TableHead>
            <TableHead className="w-[90px]">Status</TableHead>
            <TableHead className="w-[110px] text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.map((k) => (
            <KeyRow
              key={k.id}
              apiKey={k}
              usage={usageByKeyId.get(k.id)}
              onRevoke={onRevoke}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function KeyRow({
  apiKey,
  usage,
  onRevoke,
}: {
  apiKey: ApiKeyMeta
  usage: UsageByKey | undefined
  onRevoke: (key: ApiKeyMeta) => void
}) {
  const revoked = apiKey.revoked_at != null
  const totalTokens = usage ? usage.tokens_in + usage.tokens_out : 0
  const isCurrent = isStoredKeyPrefix(apiKey.prefix)

  return (
    <TableRow className={revoked ? "opacity-60" : undefined}>
      <TableCell className="font-mono text-xs">
        <div className="flex items-center gap-1.5">
          {apiKey.prefix}
          {apiKey.is_admin === 1 && (
            <Badge className="font-normal">Admin</Badge>
          )}
          {isCurrent && (
            <Badge variant="outline" className="font-normal">
              this session
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="text-sm">{apiKey.label}</TableCell>
      <TableCell className="text-muted-foreground text-xs">
        {formatRelativeTime(apiKey.created_at)}
      </TableCell>
      <TableCell className="text-right font-mono text-xs">
        {usage ? (
          <>
            <span>{usage.requests} req</span>
            <span className="text-muted-foreground ml-1">
              · {formatTokens(totalTokens)} tok
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        {revoked ? (
          <Badge variant="destructive" className="font-normal">
            Revoked
          </Badge>
        ) : (
          <Badge variant="secondary" className="font-normal">
            Active
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-right">
        <Button
          variant="ghost"
          size="sm"
          disabled={revoked}
          onClick={() => onRevoke(apiKey)}
        >
          <ShieldOffIcon data-icon="inline-start" />
          Revoke
        </Button>
      </TableCell>
    </TableRow>
  )
}

// ---------------------------------------------------------------------------
// Create dialog — plaintext shown ONCE
// ---------------------------------------------------------------------------

function CreateKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [label, setLabel] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [created, setCreated] = useState<CreatedApiKey | null>(null)
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setLabel("")
    setSubmitting(false)
    setCreated(null)
    setError(null)
  }

  function handleOpenChange(next: boolean) {
    // When a key was just created, refetch the list on close so the new row
    // appears. Reset local state either way so a reopened dialog starts clean.
    if (!next && created) {
      void queryClient.invalidateQueries({ queryKey: ["keys"] })
      void queryClient.invalidateQueries({ queryKey: ["keys-usage"] })
    }
    if (!next) reset()
    onOpenChange(next)
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const trimmed = label.trim()
    if (!trimmed) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await createApiKey(trimmed)
      setCreated(result)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRoundIcon />
            Create API key
          </DialogTitle>
          <DialogDescription>
            {created
              ? "Copy your key now. This is the only time it is shown."
              : "Give the key a label so you can recognize it later."}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="flex flex-col gap-3">
            <Alert>
              <AlertTriangleIcon />
              <AlertTitle>Save this key now</AlertTitle>
              <AlertDescription>
                The full key is shown only once. Store it somewhere safe — you
                can't retrieve it again, only revoke it and create a new one.
              </AlertDescription>
            </Alert>
            <div className="bg-muted flex items-center gap-2 rounded-md p-2">
              <code className="flex-1 overflow-x-auto font-mono text-xs">
                {created.full}
              </code>
              <CopyButton value={created.full} label="Copy key" />
            </div>
            <DialogFooter>
              <Button onClick={() => handleOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="create-key-label">Label</Label>
              <Input
                id="create-key-label"
                autoFocus
                autoComplete="off"
                placeholder="e.g. ci-pipeline"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertTitle>Couldn't create key</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="submit" disabled={!label.trim() || submitting}>
                {submitting ? "Creating…" : "Create key"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Revoke confirm dialog — with self-lockout warning
// ---------------------------------------------------------------------------

function RevokeKeyDialog({
  target,
  onClose,
}: {
  target: ApiKeyMeta | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reuse the null-guarded self-lockout compare from auth.ts (never derives the
  // prefix inline). True only when the row matches the currently-stored key.
  const selfLockout = target != null && isStoredKeyPrefix(target.prefix)

  function handleOpenChange(open: boolean) {
    if (!open) {
      setError(null)
      setSubmitting(false)
      onClose()
    }
  }

  async function handleRevoke() {
    if (!target) return
    setSubmitting(true)
    setError(null)
    try {
      await revokeApiKey(target.id)
      await queryClient.invalidateQueries({ queryKey: ["keys"] })
      await queryClient.invalidateQueries({ queryKey: ["keys-usage"] })
      setSubmitting(false)
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={target != null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldOffIcon className="text-destructive" />
            Revoke this key?
          </DialogTitle>
          <DialogDescription>
            {target ? (
              <>
                Revoking <span className="font-mono">{target.prefix}</span> (
                {target.label}) immediately blocks any request using it. This
                can't be undone — create a new key to restore access.
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {selfLockout && (
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>This is the key you're currently using</AlertTitle>
            <AlertDescription>
              Revoking it will log this dashboard out immediately. You'll need a
              different valid key to sign back in.
            </AlertDescription>
          </Alert>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertTitle>Couldn't revoke key</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleRevoke}
            disabled={submitting}
          >
            {submitting ? "Revoking…" : "Revoke key"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Loading + empty states
// ---------------------------------------------------------------------------

function KeysSkeleton() {
  return (
    <div className="border-border flex flex-col gap-0 overflow-hidden rounded-md border">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="border-border flex items-center gap-4 border-b p-3 last:border-b-0"
        >
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-16 flex-1" />
          <Skeleton className="h-6 w-16" />
        </div>
      ))}
    </div>
  )
}

function KeysEmpty({ onCreate }: { onCreate: () => void }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <KeyRoundIcon />
        </EmptyMedia>
        <EmptyTitle>No API keys yet</EmptyTitle>
        <EmptyDescription>
          Create your first key to authenticate clients against this gateway.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={onCreate}>
          <PlusIcon data-icon="inline-start" />
          Create key
        </Button>
      </EmptyContent>
    </Empty>
  )
}
