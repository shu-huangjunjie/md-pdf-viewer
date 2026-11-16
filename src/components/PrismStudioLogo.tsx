import React, { useId } from 'react';

interface PrismStudioLogoProps {
  className?: string;
}

export const PrismStudioLogo: React.FC<PrismStudioLogoProps> = ({
  className = 'w-12 h-12',
}) => {
  const uid = useId().replace(/:/g, '');
  const bgId = `ps-bg-${uid}`;
  const glowId = `ps-glow-${uid}`;
  const beamId = `ps-beam-${uid}`;
  const slashId = `ps-slash-${uid}`;

  return (
    <svg
      viewBox="0 0 128 128"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={bgId} x1="10" y1="8" x2="118" y2="120" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#2343CC" />
          <stop offset="48%" stopColor="#0E84E8" />
          <stop offset="100%" stopColor="#06C4CC" />
        </linearGradient>
        <radialGradient id={glowId} cx="82%" cy="84%" r="58%">
          <stop offset="0%" stopColor="#14E4BC" stopOpacity="0.46" />
          <stop offset="100%" stopColor="#14E4BC" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={beamId} x1="68" y1="52" x2="120" y2="42" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#7DF9FF" stopOpacity="0.34" />
          <stop offset="100%" stopColor="#6EE7B7" stopOpacity="0.04" />
        </linearGradient>
        <linearGradient id={slashId} x1="72" y1="36" x2="56" y2="92" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#86FFE8" />
        </linearGradient>
      </defs>

      {/* Rounded Aurora Squircle */}
      <rect x="6" y="6" width="116" height="116" rx="27" fill={`url(#${bgId})`} />
      <rect x="6" y="6" width="116" height="116" rx="27" fill={`url(#${glowId})`} />

      {/* Refracted Aurora Light Fan */}
      <polygon points="68,50 120,30 120,75 77,73" fill={`url(#${beamId})`} />

      {/* 3D Crystal Prism Facets */}
      <polygon points="64,21 31,86 64,69" fill="#FFFFFF" fillOpacity="0.19" />
      <polygon points="64,21 64,69 97,86" fill="#BAF7FF" fillOpacity="0.27" />
      <polygon points="31,86 64,107 64,69" fill="#0C2A6E" fillOpacity="0.17" />
      <polygon points="64,69 64,107 97,86" fill="#FFFFFF" fillOpacity="0.11" />
      <polygon
        points="64,21 97,86 64,107 31,86"
        stroke="#FFFFFF"
        strokeOpacity="0.34"
        strokeWidth="1.4"
        fill="none"
      />
      <line
        x1="64"
        y1="21"
        x2="64"
        y2="107"
        stroke="#FFFFFF"
        strokeOpacity="0.26"
        strokeWidth="1.2"
      />

      {/* Specular Inner Rim */}
      <rect
        x="6.75"
        y="6.75"
        width="114.5"
        height="114.5"
        rx="26.25"
        stroke="#FFFFFF"
        strokeOpacity="0.34"
        strokeWidth="1.5"
      />

      {/* Bold Crisp </> Code & Refracted Beam Emblem */}
      <polyline
        points="44.2,46.8 25,64.6 44.2,82.4"
        stroke="#FFFFFF"
        strokeWidth="9.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <polyline
        points="83.8,46.8 103,64.6 83.8,82.4"
        stroke="#FFFFFF"
        strokeWidth="9.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line
        x1="71.9"
        y1="37.8"
        x2="56.1"
        y2="91.4"
        stroke={`url(#${slashId})`}
        strokeWidth="10.2"
        strokeLinecap="round"
      />
    </svg>
  );
};
