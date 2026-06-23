import { PageHeader } from "@/components/ui/page-header";
import EconomicsPageClient from "@/components/economics/economics-page-client";

export const metadata = { title: "Economics — DZ CONTRIBUTOR Rewards" };

export default function EconomicsPage() {
  return (
    <>
      <PageHeader
        title="Economics"
        description="Live 2Z reward distribution, debt, and burn from the DoubleZero Economic Hub."
      />
      <div className="flex-1 px-4 sm:px-6 py-4 sm:py-6">
        <EconomicsPageClient />
      </div>
    </>
  );
}
