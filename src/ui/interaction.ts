/** Screen-space threshold: pointer travel within this is a click, not a drag. */
export const CLICK_PX = 4;

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
