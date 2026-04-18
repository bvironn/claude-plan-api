import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { useEffect, useState } from "react"
import type { Highlighter, BundledLanguage } from "shiki"

import { cn } from "@/lib/utils"

// Langs we lazy-load into shiki. Keep the list tight — each adds ~5-20 KB
// to the highlighter bundle. Add on-demand if the response asks for one
// we haven't loaded yet.
const LANGS: BundledLanguage[] = [
  "bash",
  "sh",
  "shell",
  "json",
  "js",
  "javascript",
  "ts",
  "typescript",
  "tsx",
  "jsx",
  "python",
  "py",
  "html",
  "css",
  "yaml",
  "toml",
  "sql",
  "md",
  "markdown",
  "diff",
  "go",
  "rust",
]

// A singleton shiki highlighter. Lazily initialised on first use.
let highlighterPromise: Promise<Highlighter> | null = null

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then((shiki) =>
      shiki.createHighlighter({
        themes: ["github-light", "github-dark"],
        langs: LANGS,
      }),
    )
  }
  return highlighterPromise
}

function SyntaxHighlighted({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getHighlighter().then(async (hl) => {
      if (cancelled) return
      // If the requested lang isn't loaded yet, try loading it on demand.
      if (!hl.getLoadedLanguages().includes(lang as BundledLanguage)) {
        try {
          await hl.loadLanguage(lang as BundledLanguage)
        } catch {
          // unsupported language — fall through to plain text
        }
      }
      if (cancelled) return
      const rendered = hl.codeToHtml(code, {
        lang: hl.getLoadedLanguages().includes(lang as BundledLanguage) ? lang : "txt",
        themes: {
          light: "github-light",
          dark: "github-dark",
        },
        defaultColor: false,
      })
      if (!cancelled) setHtml(rendered)
    })
    return () => {
      cancelled = true
    }
  }, [code, lang])

  // While shiki warms up, render a plain fallback so the user still sees text.
  if (html === null) {
    return (
      <pre className="bg-muted overflow-x-auto rounded-md p-3 text-sm">
        <code>{code}</code>
      </pre>
    )
  }

  // Shiki emits <pre><code>…</code></pre> with inline colour variables that
  // respect our dark/light class on <html>. Safe-inject the produced HTML.
  return (
    <div
      className="overflow-x-auto rounded-md [&_pre]:!bg-muted [&_pre]:p-3 [&_pre]:text-sm [&_code]:!bg-transparent [&_code]:text-sm"
      // eslint-disable-next-line react/no-danger -- output is our own highlighter, not user HTML
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

/**
 * Markdown renderer with GFM (tables, strikethrough, task lists) and syntax-
 * highlighted code blocks via shiki. Plain text content also flows through
 * here, so passing non-markdown strings is safe.
 */
export function MarkdownView({
  content,
  className,
}: {
  content: string
  className?: string
}) {
  return (
    <div
      className={cn(
        "prose prose-sm dark:prose-invert max-w-none",
        // Tailwind `prose` is not part of shadcn/nova by default, so we compose
        // a minimal set of readable defaults. Text wraps, code is monospace,
        // lists/tables use semantic tokens.
        "text-foreground text-sm leading-relaxed",
        "[&_p]:my-2",
        "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4",
        "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5",
        "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_li]:my-1",
        "[&_blockquote]:border-l-muted-foreground [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:italic",
        "[&_table]:my-3 [&_table]:w-auto [&_th]:border [&_th]:p-2 [&_td]:border [&_td]:p-2",
        "[&_hr]:border-border [&_hr]:my-4",
        "[&_code]:bg-muted [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs",
        "[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-semibold",
        "[&_h2]:mt-3 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold",
        "[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-base [&_h3]:font-semibold",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // react-markdown v10 no longer passes `inline` — distinguish by
          // presence of a `language-*` class (added by fenced code blocks).
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className ?? "")
            const code = String(children).replace(/\n$/, "")
            if (!match) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              )
            }
            return <SyntaxHighlighted code={code} lang={match[1] ?? "txt"} />
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
