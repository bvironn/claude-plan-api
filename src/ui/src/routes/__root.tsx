import { createRootRoute, Outlet } from "@tanstack/react-router"

import { AppHeader } from "@/components/layout/app-header"

export const Route = createRootRoute({
  component: RootComponent,
})

function RootComponent() {
  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col">
      <AppHeader />
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  )
}
