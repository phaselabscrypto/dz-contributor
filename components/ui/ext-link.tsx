import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Link out of the app.
 *
 * The CSP in `next.config.ts` sets `connect-src 'self'`, which governs fetches
 * and not top-level anchor navigation, so an external link is allowed where an
 * external fetch is not.
 */
export function ExtLink({
  href,
  children,
  className = "",
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`underline decoration-dotted hover:text-foreground inline-flex items-center gap-1 ${className}`}
    >
      {children}
      <ExternalLink className="size-3" />
    </a>
  );
}
