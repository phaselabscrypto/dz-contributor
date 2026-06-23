"use client";

import * as React from "react";
import { Dialog as RadixDialog } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Dialog = RadixDialog.Root;
const DialogTrigger = RadixDialog.Trigger;
const DialogPortal = RadixDialog.Portal;
const DialogClose = RadixDialog.Close;

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof RadixDialog.Overlay>) {
  return (
    <RadixDialog.Overlay
      className={cn(
        "fixed inset-0 z-50 bg-dark/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  hideClose,
  ...props
}: React.ComponentProps<typeof RadixDialog.Content> & { hideClose?: boolean }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <RadixDialog.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-cream-10 bg-background shadow-2xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:max-w-2xl",
          className
        )}
        {...props}
      >
        {children}
        {!hideClose && (
          <RadixDialog.Close className="absolute right-3 top-3 sm:right-4 sm:top-4 rounded-md p-1.5 sm:p-1 text-cream-30 hover:text-cream transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <X className="size-5 sm:size-4" />
            <span className="sr-only">Close</span>
          </RadixDialog.Close>
        )}
      </RadixDialog.Content>
    </DialogPortal>
  );
}

function DialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-col gap-2 p-4 pb-2 sm:p-6 sm:pb-3", className)}
      {...props}
    />
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof RadixDialog.Title>) {
  return (
    <RadixDialog.Title
      className={cn("font-display text-lg tracking-wide text-cream", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof RadixDialog.Description>) {
  return (
    <RadixDialog.Description
      className={cn("text-sm text-cream-40", className)}
      {...props}
    />
  );
}

function DialogBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("px-4 py-3 sm:px-6 sm:py-4", className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 px-4 pb-4 pt-3 sm:px-6 sm:pb-6 sm:pt-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
};
