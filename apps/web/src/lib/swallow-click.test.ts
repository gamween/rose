import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWALLOW_GRACE_MS, swallowClickOf } from "./swallow-click";

function pointer(type: string, pointerId = 1): PointerEvent {
  return Object.assign(new Event(type), { pointerId }) as PointerEvent;
}

/** Dispatches a cancelable click and tells whether it was swallowed. */
function clickSwallowed(target: EventTarget): boolean {
  const click = new Event("click", { cancelable: true });
  target.dispatchEvent(click);
  return click.defaultPrevented;
}

describe("swallowClickOf", () => {
  let target: EventTarget;
  let down: PointerEvent;

  beforeEach(() => {
    vi.useFakeTimers();
    target = new EventTarget();
    down = pointer("pointerdown");
    swallowClickOf(down, target);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("swallows the click of a mouse press, dispatched with its release, and only that one", () => {
    target.dispatchEvent(pointer("pointerup"));
    expect(clickSwallowed(target)).toBe(true);
    expect(clickSwallowed(target)).toBe(false);
  });

  it("swallows the click of a tap that the browser sends a moment after the release", () => {
    target.dispatchEvent(pointer("pointerup"));
    vi.advanceTimersByTime(SWALLOW_GRACE_MS - 100);
    expect(clickSwallowed(target)).toBe(true);
    expect(clickSwallowed(target)).toBe(false);
  });

  it("lets the next tap through after a touch scroll, which ends in pointercancel and no click", () => {
    target.dispatchEvent(pointer("pointercancel"));
    target.dispatchEvent(pointer("pointerdown"));
    target.dispatchEvent(pointer("pointerup"));
    expect(clickSwallowed(target)).toBe(false);
  });

  it("lets the next press through when the dismissing press ended in no click", () => {
    target.dispatchEvent(pointer("pointerup"));
    target.dispatchEvent(pointer("pointerdown"));
    expect(clickSwallowed(target)).toBe(false);
  });

  it("drops the swallow a moment after a release that brought no click", () => {
    target.dispatchEvent(pointer("pointerup"));
    vi.advanceTimersByTime(SWALLOW_GRACE_MS);
    expect(clickSwallowed(target)).toBe(false);
  });

  it("stays armed through the dismissing press itself and another pointer's release", () => {
    target.dispatchEvent(down);
    target.dispatchEvent(pointer("pointerup", 2));
    vi.advanceTimersByTime(SWALLOW_GRACE_MS * 2);
    expect(clickSwallowed(target)).toBe(true);
  });
});
