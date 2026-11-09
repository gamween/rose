/**
 * Critically damped spring toward a moving target, integrated exactly over each frame, so the
 * motion is the same at 30, 60 or 144 fps and never overshoots a target that stands still. The
 * landing drives its whole scene from the spring's value instead of the raw scroll position:
 * wheel notches and keyboard jumps become one continuous glide.
 */
export type Spring = { value: number; velocity: number };

/**
 * Advances `spring` by `dt` seconds toward `target`. `omega` is the natural frequency (1/s): the
 * value covers about 95% of a step in `4.7 / omega` seconds.
 */
export function stepSpring(spring: Spring, target: number, omega: number, dt: number): Spring {
  if (dt <= 0) return spring;
  const offset = spring.value - target;
  const impulse = (spring.velocity + omega * offset) * dt;
  const decay = Math.exp(-omega * dt);
  return {
    value: target + (offset + impulse) * decay,
    velocity: (spring.velocity - omega * impulse) * decay,
  };
}
