import type { HTMLAttributes, ReactNode, ThHTMLAttributes, TdHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type DenseTableProps = HTMLAttributes<HTMLTableElement> & {
  children: ReactNode;
};

export function DenseTable({ className, children, ...rest }: DenseTableProps) {
  // `min-w-full` (not `w-full`) lets the table grow past the container
  // when columns demand more horizontal space than the viewport has —
  // which is what makes `overflow-x-auto` actually scroll. With `w-full`
  // the table is clamped to container width and cells squeeze instead.
  return (
    <div className="w-full overflow-x-auto border border-border bg-surface">
      <table
        className={cn(
          "min-w-full border-collapse text-sm tabular-nums",
          className,
        )}
        {...rest}
      >
        {children}
      </table>
    </div>
  );
}

export function DTHead({ children, className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn("bg-surface-2 border-b border-border", className)}
      {...rest}
    >
      {children}
    </thead>
  );
}

export function DTBody({ children, className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody className={cn("", className)} {...rest}>
      {children}
    </tbody>
  );
}

type RowProps = HTMLAttributes<HTMLTableRowElement>;
export function DTRow({ className, ...rest }: RowProps) {
  return (
    <tr
      className={cn(
        "border-b border-border last:border-b-0 hover:bg-surface-2/60",
        className,
      )}
      {...rest}
    />
  );
}

type DTHProps = ThHTMLAttributes<HTMLTableCellElement> & {
  align?: "left" | "right" | "center";
};
export function DTH({ className, align = "left", ...rest }: DTHProps) {
  return (
    <th
      className={cn(
        // `whitespace-nowrap` keeps headers on one line so columns demand
        // their natural width. Combined with `min-w-full` on the table,
        // this is what makes horizontal scroll engage when needed.
        "px-3 py-2 text-xs uppercase tracking-[0.12em] font-mono font-normal text-muted-foreground whitespace-nowrap",
        align === "right" && "text-right",
        align === "center" && "text-center",
        align === "left" && "text-left",
        className,
      )}
      {...rest}
    />
  );
}

type DTDProps = TdHTMLAttributes<HTMLTableCellElement> & {
  align?: "left" | "right" | "center";
  mono?: boolean;
};
export function DTD({ className, align = "left", mono, ...rest }: DTDProps) {
  return (
    <td
      className={cn(
        "px-3 py-2 text-sm",
        align === "right" && "text-right",
        align === "center" && "text-center",
        align === "left" && "text-left",
        mono && "font-mono",
        className,
      )}
      {...rest}
    />
  );
}
