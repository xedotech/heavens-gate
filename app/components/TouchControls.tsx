'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type CSSProperties } from 'react';
import type { HeavensGateEngine } from '../game/engine';
import { TouchLookSmoother, touchStickResponse } from '../game/input';
import type { KeybindAction } from '../game/types';

const STICK_RADIUS = 46;
/** The nub may ride a little past the rim so the thumb never "hits a wall". */
const STICK_VISUAL_RADIUS = STICK_RADIUS * 1.3;
/** Extra touch target (px) beyond each button's drawn circle. */
const BUTTON_HIT_SLOP = 10;
/** Slack around the stick pad so near-miss presses still grab it. */
const STICK_HIT_SLOP = 10;

interface TouchControlsProps {
  engine: () => HeavensGateEngine | null;
  onPause: () => void;
}

function capturePointer(event: ReactPointerEvent<HTMLElement>) {
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    // Embedders (iframes/previews) can report pointer ids that are not active.
  }
}

/** Invisible expansion of a control's hit area — pointer events, not layout. */
const hitSlop = (px: number): CSSProperties => ({ position: 'absolute', inset: -px });

interface TouchButtonProps {
  label: string;
  className: string;
  active?: boolean;
  onPress?: () => void;
  onRelease?: () => void;
  onTap?: () => void;
}

/**
 * One action button with hit-slop, an immediate pressed style, and its own
 * pointer tracking so a second finger landing on it cannot cut the first
 * finger's press short (and a foreign pointerup cannot release it early).
 */
function TouchButton({ label, className, active = false, onPress, onRelease, onTap }: TouchButtonProps) {
  const pointer = useRef<number | null>(null);
  const [pressed, setPressed] = useState(false);

  const finish = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerId !== pointer.current) return;
    pointer.current = null;
    setPressed(false);
    onRelease?.();
  };

  return (
    <button
      type="button"
      tabIndex={-1}
      className={`${className}${active ? ' touch-active' : ''}`}
      style={{
        // The slop child is absolutely positioned, so the button must be a
        // containing block for it; the grid layout is unaffected by relative.
        position: 'relative',
        transform: pressed ? 'scale(0.9)' : 'none',
        opacity: pressed ? 0.78 : 1,
        transition: 'transform 80ms ease-out, opacity 80ms ease-out',
      }}
      onPointerDown={(event) => {
        if (pointer.current !== null) return;
        pointer.current = event.pointerId;
        capturePointer(event);
        setPressed(true);
        onPress?.();
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onPointerLeave={finish}
      onClick={onTap}
    >
      <i style={hitSlop(BUTTON_HIT_SLOP)} aria-hidden="true" />
      {label}
    </button>
  );
}

export function TouchControls({ engine, onPause }: TouchControlsProps) {
  const [aimOn, setAimOn] = useState(false);
  const [sprintOn, setSprintOn] = useState(false);
  const [touchSeen, setTouchSeen] = useState(false);
  const [stick, setStick] = useState({ x: 0, y: 0 });
  const stickPointer = useRef<number | null>(null);
  const stickOrigin = useRef({ x: 0, y: 0 });
  const lookPointer = useRef<number | null>(null);
  const lookLast = useRef({ x: 0, y: 0 });
  const [lookSmoother] = useState(() => new TouchLookSmoother());

  useEffect(() => {
    const markTouch = (event: PointerEvent) => {
      if (event.pointerType === 'touch') setTouchSeen(true);
    };
    window.addEventListener('pointerdown', markTouch, { passive: true });
    return () => window.removeEventListener('pointerdown', markTouch);
  }, []);

  // The look-drag smoother integrates in wall-clock time on rAF rather than
  // in jittery, coalesced pointer-event time. Gated on the same first-touch
  // reveal so a mouse-only session never schedules this loop.
  useEffect(() => {
    if (!touchSeen) return undefined;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const { dx, dy } = lookSmoother.advance((now - last) / 1000);
      last = now;
      if (dx !== 0 || dy !== 0) engine()?.applyTouchLook(dx, dy);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [touchSeen, engine, lookSmoother]);

  const updateStick = (clientX: number, clientY: number) => {
    const dx = clientX - stickOrigin.current.x;
    const dy = clientY - stickOrigin.current.y;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const response = touchStickResponse(dx, dy, STICK_RADIUS);
    engine()?.setTouchMove(response.x, response.y);
    // The nub follows the finger a little way past the rim; only the analog
    // output is clamped to the stick radius.
    const length = Math.hypot(dx, dy);
    const visual = length > STICK_VISUAL_RADIUS ? STICK_VISUAL_RADIUS / length : 1;
    setStick({ x: dx * visual, y: dy * visual });
  };

  const stickDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // The layer may be visible on hybrid devices; mouse drags belong to the
    // pointer-lock desktop path, so only touch/pen can grab the stick.
    if (event.pointerType === 'mouse' || stickPointer.current !== null) return;
    stickPointer.current = event.pointerId;
    const bounds = event.currentTarget.getBoundingClientRect();
    stickOrigin.current = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    capturePointer(event);
    updateStick(event.clientX, event.clientY);
  };

  const stickMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerId !== stickPointer.current) return;
    updateStick(event.clientX, event.clientY);
  };

  const stickEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerId !== stickPointer.current) return;
    stickPointer.current = null;
    setStick({ x: 0, y: 0 });
    engine()?.setTouchMove(0, 0);
  };

  const lookDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' || lookPointer.current !== null) return;
    lookPointer.current = event.pointerId;
    lookLast.current = { x: event.clientX, y: event.clientY };
    // A new drag starts from rest instead of inheriting the last fling.
    lookSmoother.reset();
    capturePointer(event);
  };

  const lookMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerId !== lookPointer.current) return;
    const dx = event.clientX - lookLast.current.x;
    const dy = event.clientY - lookLast.current.y;
    lookLast.current = { x: event.clientX, y: event.clientY };
    lookSmoother.push(dx, dy);
  };

  const lookEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Velocity survives release — the inertial glide plays out in advance().
    if (event.pointerId === lookPointer.current) lookPointer.current = null;
  };

  const press = (action: KeybindAction) => () => engine()?.pressTouchAction(action);
  const release = (action: KeybindAction) => () => engine()?.releaseTouchAction(action);

  const toggleAim = () => {
    const next = !aimOn;
    setAimOn(next);
    engine()?.setTouchAim(next);
  };

  const toggleSprint = () => {
    const next = !sprintOn;
    setSprintOn(next);
    if (next) engine()?.pressTouchAction('sprint');
    else engine()?.releaseTouchAction('sprint');
  };

  return (
    <div className={`touch-layer${touchSeen ? ' touch-seen' : ''}`} aria-hidden="true">
      <div
        className="touch-look"
        onPointerDown={lookDown}
        onPointerMove={lookMove}
        onPointerUp={lookEnd}
        onPointerCancel={lookEnd}
      />
      <button type="button" className="touch-pause" onClick={onPause} tabIndex={-1}>
        <i style={hitSlop(8)} aria-hidden="true" />
        II
      </button>

      <div
        className="touch-stick"
        style={{ '--stick-x': `${stick.x}px`, '--stick-y': `${stick.y}px` } as CSSProperties}
        onPointerDown={stickDown}
        onPointerMove={stickMove}
        onPointerUp={stickEnd}
        onPointerCancel={stickEnd}
      >
        <i style={hitSlop(STICK_HIT_SLOP)} aria-hidden="true" />
        <i className="touch-stick-ring" />
        <i className="touch-stick-nub" />
      </div>

      <div className="touch-buttons">
        <TouchButton
          className="touch-button touch-fire"
          label="FIRE"
          onPress={() => engine()?.setTouchFire(true)}
          onRelease={() => engine()?.setTouchFire(false)}
        />
        <TouchButton className="touch-button" label="AIM" active={aimOn} onTap={toggleAim} />
        <TouchButton className="touch-button" label="JUMP" onPress={press('jump')} onRelease={release('jump')} />
        <TouchButton className="touch-button" label="RUN" active={sprintOn} onTap={toggleSprint} />
        <TouchButton className="touch-button touch-small" label="E" onPress={press('interact')} onRelease={release('interact')} />
        <TouchButton className="touch-button touch-small" label="R" onPress={press('reload')} onRelease={release('reload')} />
        <TouchButton className="touch-button touch-small" label="SWP" onPress={press('weaponSwap')} onRelease={release('weaponSwap')} />
        <TouchButton className="touch-button touch-small" label="VEIL" onPress={press('veil')} onRelease={release('veil')} />
        <TouchButton className="touch-button touch-small" label="PLS" onPress={press('pulse')} onRelease={release('pulse')} />
      </div>
    </div>
  );
}
