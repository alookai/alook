export function PlanBotDots({ count, className }: { count: number; className?: string }) {
  const columns = count <= 10 ? 5 : 10
  const rows = Math.max(1, Math.ceil(count / columns))
  const width = 80
  const height = Math.max(32, rows * 8)
  const left = (width - (Math.min(count, columns) - 1) * 8) / 2
  const top = (height - (rows - 1) * 8) / 2
  return <svg className={className} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${count} bot slots`}>
    {Array.from({ length: count }, (_, index) => <circle key={index} cx={left + index % columns * 8} cy={top + Math.floor(index / columns) * 8} r="1.5" fill="currentColor" />)}
  </svg>
}
