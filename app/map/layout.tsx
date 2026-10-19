export default function MapLayout({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  // Break out of any parent container constraints using CSS
  // Fill full viewport height (standalone app — no navbar offset)
  // No overflow restriction so OpenLayers popups can render outside bounds
  return (
    <div className="w-screen relative left-1/2 -translate-x-1/2 h-screen overflow-hidden">
      {children}
    </div>
  );
}
