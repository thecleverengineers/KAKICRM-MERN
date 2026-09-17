import { FileImage } from 'lucide-react';
import { assetUrl } from '../lib/assets.js';

interface Props {
  value: unknown;
  label: string;
  variant?: 'default' | 'qr';
}

export function AssetPreview({ value, label, variant = 'default' }: Props) {
  const source = assetUrl(value);
  if (!source) return <span className="asset-preview-empty">Not uploaded</span>;
  return <span className={`asset-preview${variant === 'qr' ? ' asset-preview--qr' : ''}`} title={`${label} preview`}><img src={source} alt={`${label} preview`} loading="lazy" onError={(event) => { event.currentTarget.style.display = 'none'; event.currentTarget.nextElementSibling?.removeAttribute('hidden'); }} /><span className="asset-preview-fallback" hidden><FileImage size={16} />Unavailable</span></span>;
}
