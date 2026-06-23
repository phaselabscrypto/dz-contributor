interface SectionHeadingProps {
  title: string;
  subtitle?: string;
}

export function SectionHeading({ title, subtitle }: SectionHeadingProps) {
  return (
    <div>
      <h2 className="font-display text-lg sm:text-xl tracking-wide text-cream">{title}</h2>
      {subtitle && (
        <p className="text-xs sm:text-sm text-cream-50 mt-0.5 sm:mt-1">{subtitle}</p>
      )}
    </div>
  );
}
