import { PageHeader } from "@/components/ui/page-header";
import NetworkPageClient from "@/components/network/network-page-client";

export const metadata = { title: "Network — DZ CONTRIBUTOR Rewards" };

export default function NetworkPage() {
  return (
    <>
      <PageHeader
        title="Network"
        description="Geographic distribution of contributors, devices, and links across the DoubleZero network."
      />
      <div className="flex-1 px-4 sm:px-6 py-4 sm:py-6">
        <NetworkPageClient />
      </div>
    </>
  );
}
