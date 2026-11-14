/**
 * A press that dismisses a popover must do nothing else: the click it ends in is swallowed, so
 * dismissing a menu over a round card does not also open the round.
 */

/**
 * How long after the release the click of a tap may still come: on a touch screen the browser
 * synthesises it from the tap gesture after `pointerup`, not in the same dispatch as with a mouse.
 */
export const SWALLOW_GRACE_MS = 500;

/**
 * Swallows the click the press `down` ends in. The swallow is dropped once that click can no
 * longer come: on `pointercancel` (a touch scroll, which ends in no click), on the next press, or
 * `SWALLOW_GRACE_MS` after the release (a long press may end in no click either). It outlives the
 * popover that armed it, which closes on that same press.
 */
export function swallowClickOf(down: PointerEvent, target: EventTarget = document): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners: [string, (event: Event) => void][] = [
    [
      "click",
      (click) => {
        click.preventDefault();
        click.stopPropagation();
        disarm();
      },
    ],
    [
      "pointerup",
      (up) => {
        if ((up as PointerEvent).pointerId !== down.pointerId) return;
        clearTimeout(timer);
        timer = setTimeout(disarm, SWALLOW_GRACE_MS);
      },
    ],
    ["pointercancel", () => disarm()],
    [
      "pointerdown",
      (next) => {
        if (next !== down) disarm();
      },
    ],
  ];
  function disarm(): void {
    clearTimeout(timer);
    for (const [type, listener] of listeners) target.removeEventListener(type, listener, { capture: true });
  }
  for (const [type, listener] of listeners) target.addEventListener(type, listener, { capture: true });
}
