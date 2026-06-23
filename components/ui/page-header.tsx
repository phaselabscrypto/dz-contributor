import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type PageHeaderProps = {
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
};

export function PageHeader({
  title,
  description,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        "flex flex-col gap-2 border-b border-border px-4 sm:px-6 py-4 sm:py-5 sm:flex-row sm:items-end sm:justify-between sm:gap-6",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="font-display text-xl sm:text-2xl tracking-tight uppercase">
          {title}
        </h1>
        {description && (
          <p className="mt-1 max-w-2xl text-xs sm:text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </header>
  );
}
