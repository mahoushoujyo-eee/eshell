import { Bot } from "lucide-react";
import { getAcpAgentBrand } from "../../lib/acpAgentBrands";

/**
 * Brand mark for one ACP agent. The caller sizes the chip through `className`
 * (e.g. `h-5 w-5`); the glyph scales inside it. Agents whose brand cannot be
 * identified fall back to a neutral bot glyph instead of a wrong logo.
 */
export default function AcpAgentLogo({ agent, className = "", title }) {
  const brand = getAcpAgentBrand(agent);
  const label = title ?? brand?.label ?? agent?.name ?? "";

  return (
    <span
      className={[
        "inline-flex shrink-0 items-center justify-center rounded-md border",
        brand ? `${brand.chipClass} ${brand.markClass}` : "border-border bg-hover text-muted",
        className,
      ].join(" ")}
      title={label || undefined}
      aria-hidden="true"
    >
      {brand ? (
        <svg viewBox="0 0 24 24" className="h-[62%] w-[62%]" fill="currentColor">
          <path d={brand.path} />
        </svg>
      ) : (
        <Bot className="h-[62%] w-[62%]" />
      )}
    </span>
  );
}
