"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Download } from "lucide-react";
import { exportUrl } from "@/lib/telemetry/client";

export function ExportMenu() {
  const openExport = (type: "events" | "requests", format: "csv" | "json") => {
    window.open(exportUrl(type, format), "_blank");
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium shadow-xs hover:bg-accent hover:text-accent-foreground">
        <Download className="h-4 w-4" />
        Export
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Events</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => openExport("events", "json")}>
          Events → JSON
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => openExport("events", "csv")}>
          Events → CSV
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Requests</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => openExport("requests", "json")}>
          Requests → JSON
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => openExport("requests", "csv")}>
          Requests → CSV
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
