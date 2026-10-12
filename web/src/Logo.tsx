import { useId } from "react";

/** The popcorn puff with a play button cut out, in the full brand orange-to-coral. */
export function LogoMark(props: { size?: number }) {
  const id = useId();
  const size = props.size ?? 32;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="logo-mark">
      <defs>
        <linearGradient id={`${id}p`} gradientUnits="userSpaceOnUse" x1="6" y1="0" x2="58" y2="58">
          <stop offset="0" stopColor="#FF8E44" />
          <stop offset="1" stopColor="#FF5252" />
        </linearGradient>
        <mask id={`${id}m`} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <rect width="64" height="64" fill="#fff" />
          <path d="M26,20 L45,31 L26,42 Z" fill="#000" />
        </mask>
      </defs>
      <g fill={`url(#${id}p)`} mask={`url(#${id}m)`}>
        <circle cx="19" cy="28" r="15" />
        <circle cx="45" cy="28" r="15" />
        <circle cx="32" cy="16" r="16" />
        <circle cx="23" cy="43" r="14" />
        <circle cx="41" cy="43" r="14" />
      </g>
    </svg>
  );
}

/** The mark and the name, for page headers. */
export function Logo(props: { size?: number }) {
  return (
    <h1 className="logo">
      <LogoMark size={props.size} />
      <span>Popcorn Club</span>
    </h1>
  );
}
