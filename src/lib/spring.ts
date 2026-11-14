/**
 * 帧率无关的二阶阻尼弹簧（ADR-0047）：半隐式欧拉 + 子步长积分，移植自岛仔 Daozai
 * 的 anim.rs（MIT）。关键性质：目标随时可改、速度保留——展开途中收起、收起途中再展开
 * 都不会跳变，这是形变「丝滑」的根。
 *
 * 刻意不用 CSS transition 驱动形变：本机 WebView2 恒定上报 prefers-reduced-motion:
 * reduce（系统关闭显示动画即触发），CSS 侧的让步会让岛永远没有展开动画
 * （styles.css 的 .panel-enter 已有同类先例注释）。
 */

export interface SpringTuning {
  /** 刚度 k：越大越快 */
  stiffness: number;
  /** 阻尼比 zeta：<1 有过冲，=1 临界阻尼，>1 无过冲更迟缓 */
  zeta: number;
}

/** 子步上限：保证 30–240 Hz 帧率下积分轨迹一致 */
const MAX_SUBSTEP = 1 / 480;
/** 掉帧时限幅：一帧跨太远时按 100ms 积分，防弹簧被长帧炸飞 */
const MAX_DT = 0.1;

export class Spring {
  pos: number;
  vel = 0;
  target: number;
  private k: number;
  private c: number;

  constructor(value: number, tuning: SpringTuning) {
    this.pos = value;
    this.target = value;
    this.k = tuning.stiffness;
    this.c = damping(tuning);
  }

  tune(tuning: SpringTuning) {
    this.k = tuning.stiffness;
    this.c = damping(tuning);
  }

  /** 瞬间到位（清速度），用于重置到确定状态 */
  snap(value: number) {
    this.pos = value;
    this.target = value;
    this.vel = 0;
  }

  /** 推进一个帧间隔（秒） */
  step(dtSeconds: number) {
    const dt = Math.min(Math.max(dtSeconds, 0), MAX_DT);
    const steps = Math.max(1, Math.ceil(dt / MAX_SUBSTEP));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = -this.k * (this.pos - this.target) - this.c * this.vel;
      this.vel += a * h;
      this.pos += this.vel * h;
    }
  }

  /** 相对 scale 足够接近目标且几乎静止 */
  settled(scale = 1): boolean {
    return (
      Math.abs(this.pos - this.target) < 0.002 * scale &&
      Math.abs(this.vel) < 0.02 * scale
    );
  }
}

function damping({ stiffness, zeta }: SpringTuning): number {
  return 2 * zeta * Math.sqrt(stiffness);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp01(t: number): number {
  return Math.min(Math.max(t, 0), 1);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  // 允许 edge0 > edge1（反向区间的「越近越强」）
  const d = edge1 - edge0;
  if (Math.abs(d) < 1e-6) return x >= edge1 ? 1 : 0;
  const t = clamp01((x - edge0) / d);
  return t * t * (3 - 2 * t);
}
