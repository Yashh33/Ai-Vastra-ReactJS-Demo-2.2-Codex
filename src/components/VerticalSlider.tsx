import {
  useRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from "react";

type VerticalSliderProps = {
  label: string;
  /** Tiny hint above the track (what "up" does), e.g. "Warmer". */
  up: string;
  /** Tiny hint below the track (what "down" does), e.g. "Cooler". */
  down: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  /** Sets --cs-track, e.g. a colour gradient for the track line. */
  trackStyle?: CSSProperties;
  onChange: (value: number) => void;
};

const DOUBLE_TAP_MS = 300;

function formatValue(value: number) {
  return value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : "0";
}

/**
 * Vertical slider built on pointer events (a rotated native range input is
 * unreliable on iOS). The middle is 0 ("Original"); up is more, down is less.
 * Tap the track to jump, drag to adjust, double-tap to reset to 0.
 */
export function VerticalSlider({
  label,
  up,
  down,
  value,
  min = -100,
  max = 100,
  step = 1,
  disabled,
  trackStyle,
  onChange
}: VerticalSliderProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const lastTapRef = useRef(0);
  // Last value sent, so a drag only reports real changes.
  const lastValueRef = useRef(value);
  lastValueRef.current = value;

  const clamp = (next: number) => Math.min(max, Math.max(min, next));

  const emit = (next: number) => {
    const snapped = clamp(Math.round(next / step) * step);
    if (snapped === lastValueRef.current) return;
    lastValueRef.current = snapped;
    onChange(snapped);
  };

  const valueAt = (clientY: number) => {
    const track = trackRef.current;
    if (!track) return value;
    const rect = track.getBoundingClientRect();
    if (rect.height === 0) return value;
    const ratio = Math.min(1, Math.max(0, 1 - (clientY - rect.top) / rect.height));
    return min + ratio * (max - min);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    thumbRef.current?.focus({ preventScroll: true });

    const now = event.timeStamp;
    if (now - lastTapRef.current < DOUBLE_TAP_MS) {
      lastTapRef.current = 0;
      draggingRef.current = false;
      emit(0);
      return;
    }
    lastTapRef.current = now;

    draggingRef.current = true;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // capture is best effort; moves over the track still work without it
    }
    emit(valueAt(event.clientY));
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || disabled) return;
    emit(valueAt(event.clientY));
  };

  const endDrag = () => {
    draggingRef.current = false;
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    let next: number | null = null;
    switch (event.key) {
      case "ArrowUp":
      case "ArrowRight":
        next = value + step;
        break;
      case "ArrowDown":
      case "ArrowLeft":
        next = value - step;
        break;
      case "PageUp":
        next = value + step * 10;
        break;
      case "PageDown":
        next = value - step * 10;
        break;
      case "Home":
        next = max;
        break;
      case "End":
        next = min;
        break;
      default:
        return;
    }
    event.preventDefault();
    emit(next);
  };

  const position = ((clamp(value) - min) / (max - min)) * 100;
  const centre = ((0 - min) / (max - min)) * 100;
  const fillStyle: CSSProperties = {
    bottom: `${Math.min(position, centre)}%`,
    height: `${Math.abs(position - centre)}%`
  };

  return (
    <div className={`cs-vslider${disabled ? " is-disabled" : ""}`}>
      <button
        type="button"
        className="cs-vslider-value"
        onClick={() => emit(0)}
        disabled={disabled || value === 0}
        aria-label={`Reset ${label}`}
      >
        {formatValue(value)}
      </button>
      <span className="cs-vslider-hint" aria-hidden>
        {up}
      </span>

      <div
        ref={trackRef}
        className="cs-vslider-track"
        style={trackStyle}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onContextMenu={(event) => event.preventDefault()}
      >
        <span className="cs-vslider-line" aria-hidden />
        {!trackStyle ? <span className="cs-vslider-fill" style={fillStyle} aria-hidden /> : null}
        <span className="cs-vslider-tick" aria-hidden />
        <div
          ref={thumbRef}
          className="cs-vslider-thumb"
          style={{ bottom: `${position}%` }}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label={label}
          aria-orientation="vertical"
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={value === 0 ? "Original" : formatValue(value)}
          aria-disabled={disabled || undefined}
          onKeyDown={handleKeyDown}
        />
      </div>

      <span className="cs-vslider-hint" aria-hidden>
        {down}
      </span>
      <span className="cs-vslider-label">{label}</span>
    </div>
  );
}
