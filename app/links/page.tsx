import { Suspense } from "react";
import { PageHeader } from "@/components/ui/page-header";
import LinksTableContent from "@/components/links/links-table-content";

export const metadata = { title: "Links — DZ CONTRIBUTOR Rewards" };

export default function LinksPage() {
  return (
    <>
      <PageHeader
        title="Links"
        description="All inter-device links: capacity, status, and contributor."
      />
      <div className="flex-1 px-4 sm:px-6 py-4 sm:py-6">
        <Suspense
          fallback={
            <div className="border border-border bg-surface p-12 text-center text-sm text-muted-foreground">
              Loading links...
            </div>
          }
        >
          <LinksTableContent />
        </Suspense>
      </div>
    </>
  );
}
