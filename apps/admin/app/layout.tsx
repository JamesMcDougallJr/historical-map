import Link from "next/link";
import "./globals.css";

export const metadata = {
  title: "Historical Map — Admin",
  description: "Local-only CRUD for published events and locations",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  return (
    <html lang="en">
      <body>
        <nav
          style={{
            display: "flex",
            gap: "1rem",
            padding: "1rem 1.5rem",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <Link href="/">Locations</Link>
          <Link href="/sequences">Sequences</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
