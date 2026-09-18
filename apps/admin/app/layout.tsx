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
      <body>{children}</body>
    </html>
  );
}
