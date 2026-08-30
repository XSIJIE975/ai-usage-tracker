import { useId } from "react";

/**
 * 品牌图标（与应用主图标同源：docs/design/icons/app-icon.svg）。
 * 鸢尾紫渐变圆角底板 + 白色仪表盘（量表弧线 + 指针），
 * 表达「AI 用量计量」的产品定位。界面内一律使用本组件，不另绘 Logo。
 */
export function BrandIcon({ size = 32, className }: { size?: number; className?: string }) {
  const gradientId = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      className={className}
      role="img"
      aria-label="AI 用量助手"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="256" y2="256" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8183F8" />
          <stop offset="1" stopColor="#5A48E2" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="256" height="256" rx="56" fill={`url(#${gradientId})`} />
      <rect x="0" y="0" width="256" height="128" rx="56" fill="#FFFFFF" opacity="0.08" />
      {/* 量表弧线：140° → 40°，跨顶部 260°，底部留口 */}
      <path
        d="M 71.3 185.7 A 74 74 0 1 1 184.7 185.7"
        fill="none"
        stroke="#FFFFFF"
        strokeOpacity="0.96"
        strokeWidth="20"
        strokeLinecap="round"
      />
      {/* 指针（指向右上方高位） */}
      <line x1="128" y1="138" x2="164.8" y2="101.2" stroke="#FFFFFF" strokeWidth="13" strokeLinecap="round" />
      <circle cx="128" cy="138" r="13" fill="#FFFFFF" />
    </svg>
  );
}
