export default function StatusListSection({ title, icon: Icon, rows, getKey, renderRow, className = "" }) {
  return (
    <div className={["flex min-h-0 flex-1 flex-col px-2 py-2", className].join(" ")}>
      <div className="mb-1 inline-flex items-center gap-1.5 font-medium">
        <Icon className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
        {title}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {rows.map((row) => (
          <div key={getKey(row)}>{renderRow(row)}</div>
        ))}
      </div>
    </div>
  );
}
