import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { TanStackRouterVite } from "@tanstack/router-plugin/vite"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    TanStackRouterVite({
      target: "react",
      autoCodeSplitting: true,
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    // Proxy API + chat completions + health to the gateway in dev so the
    // SPA can hit same-origin paths just like in production.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3457",
        changeOrigin: true,
      },
      "/v1": {
        target: "http://127.0.0.1:3457",
        changeOrigin: true,
      },
      "/health": {
        target: "http://127.0.0.1:3457",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    // Hash-based asset filenames so the backend can set `immutable` cache.
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
})
