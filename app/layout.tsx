import type { Metadata } from "next";
import { Audiowide, Kode_Mono, Outfit } from "next/font/google";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { SidebarShell } from "@/components/ui/sidebar-shell";
import { PhaseFooter } from "@/components/ui/phase-lockup";
import { KeyboardShortcuts } from "@/components/ui/keyboard-shortcuts";
import { WebVitalsReporter } from "@/components/ui/web-vitals-reporter";
import "./globals.css";

const audiowide = Audiowide({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-audiowide",
  display: "swap",
});

const outfit = Outfit({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  variable: "--font-outfit",
  display: "swap",
});

const kodeMono = Kode_Mono({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  variable: "--font-kode-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "DZ Contributor Rewards",
    template: "%s · DZ Contributor",
  },
  description:
    "Live DoubleZero network state, real on-chain reward distribution, and a Shapley-based forecaster for any add/remove scenario. Powered by Phase.",
  applicationName: "DZ Contributor",
  authors: [{ name: "Phase" }],
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ||
      "https://dz-contributor.vercel.app",
  ),
  openGraph: {
    type: "website",
    siteName: "DZ Contributor Rewards",
    title: "DZ Contributor Rewards",
    description:
      "See exactly what your links earn. Live network, real on-chain distribution, Shapley forecasts.",
  },
  twitter: {
    card: "summary_large_image",
    title: "DZ Contributor Rewards",
    description:
      "See exactly what your links earn. Live network, real on-chain distribution, Shapley forecasts.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      data-theme="dark"
      className={`${audiowide.variable} ${outfit.variable} ${kodeMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/*
          Apply saved theme before paint to avoid a flash on first load.
          Reads localStorage synchronously, sets data-theme on <html>.
          Failures are swallowed so broken/blocked storage never breaks the page.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('dz:theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();",
          }}
        />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        {/*
          Skip-to-content link for keyboard users. Hidden visually but
          revealed on focus (Tab from the URL bar). Sends focus straight
          into the <main> landmark so screen readers and keyboard
          navigators don't have to traverse the whole sidebar every
          page load.
        */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-3 focus:py-2 focus:bg-foreground focus:text-background focus:font-medium focus:text-sm focus:rounded-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          Skip to main content
        </a>
        <NuqsAdapter>
          <div className="flex min-h-screen flex-col md:flex-row">
            <SidebarShell />
            <div className="flex min-w-0 flex-1 flex-col">
              <main id="main" tabIndex={-1} className="flex-1 outline-none">
                {children}
              </main>
              <PhaseFooter />
            </div>
          </div>
          <KeyboardShortcuts />
          <WebVitalsReporter />
        </NuqsAdapter>
      </body>
    </html>
  );
}
