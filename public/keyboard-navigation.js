const HORIZONTAL_KEYS = Object.freeze({ ArrowLeft: -1, ArrowRight: 1 });
const VERTICAL_KEYS = Object.freeze({ ArrowUp: -1, ArrowDown: 1 });

export function nextNavigationIndex({
  key,
  currentIndex,
  itemCount,
  orientation = "both",
  wrap = true,
}) {
  if (!Number.isInteger(currentIndex) || !Number.isInteger(itemCount) || itemCount <= 0) {
    return null;
  }
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;

  const horizontal = orientation === "horizontal" || orientation === "both";
  const vertical = orientation === "vertical" || orientation === "both";
  const delta = (horizontal ? HORIZONTAL_KEYS[key] : undefined)
    ?? (vertical ? VERTICAL_KEYS[key] : undefined);
  if (delta === undefined) return null;

  const next = currentIndex + delta;
  if (wrap) return (next + itemCount) % itemCount;
  return Math.max(0, Math.min(itemCount - 1, next));
}
