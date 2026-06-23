"use client";

import { useReportWebVitals } from "next/web-vitals";
import { postVitals } from "@/lib/observability";

/**
 * Reports Core Web Vitals to /api/vitals. Mounted in the root layout.
 *
 * Today /api/vitals is a no-op aggregator (logs in dev, swallows in
 * prod). When Phase wires a real metrics backend, swap the route
 * implementation — this component doesn't change.
 */
export function WebVitalsReporter() {
  useReportWebVitals(postVitals);
  return null;
}
