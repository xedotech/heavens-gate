'use client';

import { RotateCcw, TriangleAlert } from 'lucide-react';

export default function ErrorBoundary({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="route-error" role="alert">
      <TriangleAlert aria-hidden="true" />
      <p className="eyebrow">World simulation interrupted</p>
      <h1>The gate failed safely.</h1>
      <p>Your local checkpoint is intact. Restart the renderer and continue from the last operation.</p>
      <button className="primary-action" type="button" onClick={reset}><RotateCcw aria-hidden="true" /> Restart renderer</button>
    </main>
  );
}
