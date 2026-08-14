export const DEFAULT_SPLIT_RATIO = 0.5;
export const MIN_PANE_WIDTH = 280;

export function splitRatioBounds(availableWidth, minimumPaneWidth = MIN_PANE_WIDTH) {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0
    || !Number.isFinite(minimumPaneWidth) || minimumPaneWidth < 0) {
    throw new TypeError("Split-pane dimensions must be finite positive values.");
  }
  const minimum = Math.min(DEFAULT_SPLIT_RATIO, minimumPaneWidth / availableWidth);
  return Object.freeze({ minimum, maximum: 1 - minimum });
}

export function clampSplitRatio(ratio, availableWidth, minimumPaneWidth = MIN_PANE_WIDTH) {
  const { minimum, maximum } = splitRatioBounds(availableWidth, minimumPaneWidth);
  const candidate = Number.isFinite(ratio) ? ratio : DEFAULT_SPLIT_RATIO;
  return Math.min(maximum, Math.max(minimum, candidate));
}

export function splitRatioFromPointer({
  clientX,
  containerLeft,
  containerWidth,
  dividerWidth,
  minimumPaneWidth = MIN_PANE_WIDTH
}) {
  if (![clientX, containerLeft, containerWidth, dividerWidth].every(Number.isFinite)
    || containerWidth <= dividerWidth || dividerWidth < 0) {
    throw new TypeError("Pointer split geometry is invalid.");
  }
  const availableWidth = containerWidth - dividerWidth;
  const ratio = (clientX - containerLeft - (dividerWidth / 2)) / availableWidth;
  return clampSplitRatio(ratio, availableWidth, minimumPaneWidth);
}
