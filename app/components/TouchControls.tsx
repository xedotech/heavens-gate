'use client';

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type CSSProperties } from 'react';
import type { HeavensGateEngine } from '../game/engine';
import type { KeybindAction } from '../game/types';

const STICK_RADIUS = 46;

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

export function TouchControls({ engine, onPause }: TouchControlsProps) {
  const [aimOn, setAimOn] = useState(false);
  const [sprintOn, setSprintOn] = useState(false);
  const [touchSeen, setTouchSeen] = useState(false);
  const [stick, setStick] = useState({ x: 0, y: 0 });
  const stickPointer = useRef<number | null>(null);
  const stickOrigin = useRef({ x: 0, y: 0 });
  const lookPointer = useRef<number | null>(null);
  const lookLast = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const markTouch = (event: PointerEvent) => {
      if (event.pointerType === 'touch') setTouchSeen(true);
    };
    window.addEventListener('pointerdown', markTouch, { passive: true });
    return () => window.removeEventListener('pointerdown', markTouch);
  }, []);

  const stickDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (stickPointer.current !== null) return;
    stickPointer.current = event.pointerId;
    const bounds = event.currentTarget.getBoundingClientRect();
    stickOrigin.current = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    capturePointer(event);
  };

  const stickMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerId !== stickPointer.current) return;
    const dx = event.clientX - stickOrigin.current.x;
    const dy = event.clientY - stickOrigin.current.y;
    const length = Math.hypot(dx, dy);
    const scale = length > STICK_RADIUS ? STICK_RADIUS / length : 1;
    const x = dx * scale;
    const y = dy * scale;
    setStick({ x, y });
    engine()?.setTouchMove(x / STICK_RADIUS, y / STICK_RADIUS);
  };

  const stickEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerId !== stickPointer.current) return;
    stickPointer.current = null;
    setStick({ x: 0, y: 0 });
    engine()?.setTouchMove(0, 0);
  };

  const lookDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (lookPointer.current !== null) return;
    lookPointer.current = event.pointerId;
    lookLast.current = { x: event.clientX, y: event.clientY };
    capturePointer(event);
  };

  const lookMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerId !== lookPointer.current) return;
    const dx = event.clientX - lookLast.current.x;
    const dy = event.clientY - lookLast.current.y;
    lookLast.current = { x: event.clientX, y: event.clientY };
    engine()?.applyTouchLook(dx, dy);
  };

  const lookEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerId === lookPointer.current) lookPointer.current = null;
  };

  const tapAction = (action: KeybindAction) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      capturePointer(event);
      engine()?.pressTouchAction(action);
    },
    onPointerUp: () => engine()?.releaseTouchAction(action),
    onPointerCancel: () => engine()?.releaseTouchAction(action),
  });

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
      <button type="button" className="touch-pause" onClick={onPause} tabIndex={-1}>II</button>

      <div
        className="touch-stick"
        style={{ '--stick-x': `${stick.x}px`, '--stick-y': `${stick.y}px` } as CSSProperties}
        onPointerDown={stickDown}
        onPointerMove={stickMove}
        onPointerUp={stickEnd}
        onPointerCancel={stickEnd}
      >
        <i className="touch-stick-ring" />
        <i className="touch-stick-nub" />
      </div>

      <div className="touch-buttons">
        <button
          type="button"
          className="touch-button touch-fire"
          tabIndex={-1}
          onPointerDown={(event) => {
            capturePointer(event);
            engine()?.setTouchFire(true);
          }}
          onPointerUp={() => engine()?.setTouchFire(false)}
          onPointerCancel={() => engine()?.setTouchFire(false)}
          onPointerLeave={() => engine()?.setTouchFire(false)}
        >FIRE</button>
        <button type="button" className={`touch-button${aimOn ? ' touch-active' : ''}`} tabIndex={-1} onClick={toggleAim}>AIM</button>
        <button type="button" className="touch-button" tabIndex={-1} {...tapAction('jump')}>JUMP</button>
        <button type="button" className={`touch-button${sprintOn ? ' touch-active' : ''}`} tabIndex={-1} onClick={toggleSprint}>RUN</button>
        <button type="button" className="touch-button touch-small" tabIndex={-1} {...tapAction('interact')}>E</button>
        <button type="button" className="touch-button touch-small" tabIndex={-1} {...tapAction('reload')}>R</button>
        <button type="button" className="touch-button touch-small" tabIndex={-1} {...tapAction('weaponSwap')}>SWP</button>
        <button type="button" className="touch-button touch-small" tabIndex={-1} {...tapAction('veil')}>VEIL</button>
        <button type="button" className="touch-button touch-small" tabIndex={-1} {...tapAction('pulse')}>PLS</button>
      </div>
    </div>
  );
}
