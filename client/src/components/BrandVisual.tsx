import { useEffect, useState } from 'react';
import { initials } from '../lib/format.js';

export function BrandVisual({ src, label, className = 'brand-mark' }: { src?: string | null; label: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (src && !failed) {
    return <span className={`${className} ${className}--image`}><img src={src} alt={`${label} logo`} onError={() => setFailed(true)} /></span>;
  }
  return <span className={className} aria-label={`${label} logo`}>{initials(label)}</span>;
}
