/**
 * Orbit brand mark — GitHub-mark style: a dark disc with a white pig
 * silhouette (ears, snout and a curly tail echoing the old orbit ellipse).
 */
export function OrbitMark({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {/* disc */}
      <circle cx="12" cy="12" r="12" fill="#1e222a" />
      {/* head */}
      <circle cx="12" cy="13.1" r="6.7" fill="#ffffff" />
      {/* ears */}
      <path
        d="M5.9 9.2 Q4.3 6.8 4.7 4.2 Q4.8 3.6 5.4 3.9 L9.9 6.2 Z"
        fill="#ffffff"
      />
      <path
        d="M18.1 9.2 Q19.7 6.8 19.3 4.2 Q19.2 3.6 18.6 3.9 L14.1 6.2 Z"
        fill="#ffffff"
      />
      {/* curly tail */}
      <path
        d="M18.3 18.2 C20.4 19.0 21.6 17.6 21.0 16.4 C20.6 15.6 19.4 15.8 19.5 16.8"
        stroke="#ffffff"
        strokeWidth="1.15"
        strokeLinecap="round"
        fill="none"
      />
      {/* snout (punched out of the silhouette) */}
      <ellipse cx="12" cy="15.9" rx="3.3" ry="2.3" fill="#1e222a" />
      <circle cx="10.85" cy="15.9" r="0.62" fill="#ffffff" />
      <circle cx="13.15" cy="15.9" r="0.62" fill="#ffffff" />
    </svg>
  );
}
