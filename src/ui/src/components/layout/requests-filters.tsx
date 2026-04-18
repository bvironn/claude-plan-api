import { FilterIcon, SearchIcon, XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group"

/** Filter state (URL-driven). Everything optional, empty = no filter. */
export interface RequestsFilterState {
  search?: string
  statusClass?: "2xx" | "4xx" | "5xx"
  model?: string
}

interface RequestsFiltersProps {
  value: RequestsFilterState
  onChange: (next: RequestsFilterState) => void
  models: string[]
}

export function RequestsFilters({ value, onChange, models }: RequestsFiltersProps) {
  const active =
    (value.search && value.search.length > 0 ? 1 : 0) +
    (value.statusClass ? 1 : 0) +
    (value.model ? 1 : 0)

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Search */}
      <div className="relative min-w-0 flex-1 sm:max-w-md">
        <SearchIcon
          data-icon
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
        />
        <Input
          type="search"
          placeholder="Search in request / response bodies …"
          value={value.search ?? ""}
          onChange={(e) => onChange({ ...value, search: e.target.value || undefined })}
          className="pl-9"
          aria-label="Search requests"
          data-search-input
        />
      </div>

      {/* Status class */}
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={value.statusClass ?? ""}
        onValueChange={(v) =>
          onChange({
            ...value,
            statusClass: v === "" ? undefined : (v as RequestsFilterState["statusClass"]),
          })
        }
      >
        <ToggleGroupItem value="2xx">2xx</ToggleGroupItem>
        <ToggleGroupItem value="4xx">4xx</ToggleGroupItem>
        <ToggleGroupItem value="5xx">5xx</ToggleGroupItem>
      </ToggleGroup>

      {/* Model */}
      {models.length > 0 && (
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={value.model ?? ""}
          onValueChange={(v) =>
            onChange({ ...value, model: v === "" ? undefined : v })
          }
          aria-label="Model filter"
          className="flex-wrap"
        >
          {models.map((m) => (
            <ToggleGroupItem key={m} value={m} className="font-mono text-xs">
              {m}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}

      {/* Reset + active badge */}
      {active > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            onChange({ search: undefined, statusClass: undefined, model: undefined })
          }
        >
          <XIcon data-icon="inline-start" />
          Clear ({active})
        </Button>
      ) : (
        <Badge variant="outline" className="gap-1">
          <FilterIcon className="size-3" />
          no filters
        </Badge>
      )}
    </div>
  )
}
