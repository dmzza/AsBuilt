/** Screen-space threshold: pointer must travel farther than this before a
 *  gesture is considered a drag. Real trackpad clicks often jitter 5–10px. */
export const CLICK_PX = 12;

export function pointerTravelPx(
  down: { x: number; y: number },
  up: { x: number; y: number },
): number {
  return Math.hypot(up.x - down.x, up.y - down.y);
}

/** True when the gesture should select only — never emit a move/edit. */
export function isClickGesture(
  down: { x: number; y: number },
  up: { x: number; y: number },
  thresholdPx: number = CLICK_PX,
): boolean {
  return pointerTravelPx(down, up) <= thresholdPx;
}

/** True once pointer travel has crossed the click/drag threshold. */
export function hasArmedDrag(
  down: { x: number; y: number },
  current: { x: number; y: number },
  thresholdPx: number = CLICK_PX,
): boolean {
  return pointerTravelPx(down, current) > thresholdPx;
}

/**
 * Refit 2D/3D framing when the scene epoch advances (demo load, open folder).
 * Comparing epochs — not "was empty" — is required so reloading the same demo
 * after the user has panned/orbited still reframes.
 */
export function shouldRefitForEpoch(
  fittedEpoch: number,
  sceneEpoch: number,
  hasGeometry: boolean,
): boolean {
  return hasGeometry && fittedEpoch !== sceneEpoch;
}
