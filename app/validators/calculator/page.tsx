import { redirect } from "next/navigation";

/**
 * The calculator used to be its own page with its own search box, which is
 * what the DoubleZero reviewer objected to: a button that led to a second
 * copy of the search he had just used. The estimate now lives inline on
 * /validators, driven by the same search.
 *
 * Kept as a redirect so existing links, bookmarks and the `?vote=` param
 * still land somewhere useful.
 */
export default async function ValidatorCalculatorPage({
  searchParams,
}: {
  searchParams: Promise<{ vote?: string }>;
}) {
  const { vote } = await searchParams;
  redirect(vote ? `/validators?q=${encodeURIComponent(vote)}` : "/validators");
}
