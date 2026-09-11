export interface FrameTimeSummary {
  samples: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

/** Recording is allocation-free; summary copies/sorts the bounded rolling window. */
export class FrameTimeSampler {
  private readonly values: number[];
  private cursor = 0;
  private count = 0;

  constructor(private readonly capacity = 600) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Frame-time capacity must be a positive integer');
    this.values = new Array<number>(capacity);
  }

  record(milliseconds: number) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    this.values[this.cursor] = milliseconds;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.count = Math.min(this.capacity, this.count + 1);
  }

  summary(): FrameTimeSummary {
    if (!this.count) return { samples: 0, medianMs: 0, p95Ms: 0, maxMs: 0 };
    const ordered = this.values.slice(0, this.count).sort((a, b) => a - b);
    const middle = Math.floor(ordered.length / 2);
    const median = ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
    return {
      samples: this.count,
      medianMs: median,
      // Nearest-rank percentile: at least 95% of observations are <= this value.
      p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1],
      maxMs: ordered[ordered.length - 1],
    };
  }
}
