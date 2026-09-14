/**
 * "Did the mouse actually move?", for focus-follows-mouse.
 *
 * The pane under the pointer should only take focus because the pointer moved
 * there. The browser, however, also re-delivers the pointer's position without it
 * having moved at all: bringing the window back to the foreground (Alt+Tab, a
 * taskbar click) re-fires `mouseenter` -- and a `mousemove` with it -- for the
 * element under the cursor, carrying the coordinates the pointer already had. A
 * pane that appears under a resting cursor gets the same treatment when a split
 * creates it. Honouring those steals focus from the pane the user was working in,
 * which is the one thing focus-follows-mouse must not do.
 *
 * The event cannot tell the two apart, but the position can: a real move changes
 * the coordinates, a re-delivery repeats them. So every pane reports what it sees
 * to one shared tracker, and only a position the pointer was not already at
 * counts as a move.
 */

export interface PointerPosition {
  x: number
  y: number
}

/**
 * Record `next` against `previous` and report whether getting there was a move.
 *
 * `null` -- nothing observed yet -- counts as a move. The pointer can arrive in a
 * pane before anything has been recorded (the window may open with the cursor
 * already inside it), and refusing that would wedge focus-follows-mouse until the
 * pointer left the layout and came back.
 */
export function pointerMoved(previous: PointerPosition | null, next: PointerPosition): boolean {
  if (previous === null) return true
  return previous.x !== next.x || previous.y !== next.y
}
