import { Component, type ReactNode } from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";

/** URL 白名单：先过库的默认判定（挡掉 `javascript:` 等），再把放行面收窄到 http/https。
 *  库默认还放行 `irc` / `ircs` / `mailto` / `xmpp` 与相对路径，后者在桌面应用里没有
 *  「当前站点」可言，一律收掉。不放行时返回空串——react-markdown 会把它写成 `href=""`，
 *  组件据此退化渲染，因此「不可点」有明确信号可判，不依赖库的内部行为（ADR-0028）。
 *  导出供单测直接断言白名单边界。 */
export function safeUrl(value: string): string {
  const url = defaultUrlTransform(value);
  return /^https?:\/\//i.test(url) ? url : "";
}

/** 行内代码与代码块共用 `code` 元素，库不给可区分的标记，
 *  用 arbitrary variant `:not(pre *)` 把「非 pre 内的 code」挑出来只给行内代码上底色。 */
const INLINE_CODE =
  "font-mono text-[12px] [&:not(pre_*)]:rounded [&:not(pre_*)]:border [&:not(pre_*)]:border-line [&:not(pre_*)]:bg-canvas [&:not(pre_*)]:px-1 [&:not(pre_*)]:py-0.5 [&:not(pre_*)]:text-fg";

/** 元素级样式全部挂现有的语义 Token（text-fg / border-line / bg-canvas / font-mono），
 *  深浅色跟随 Token 自动适配，不新增排版样式表。正文色由外层容器统一给出。 */
const components: Components = {
  p({ children }) {
    return <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>;
  },
  h1({ children }) {
    return (
      <h1 className="mt-3 mb-1.5 text-sm font-semibold text-fg first:mt-0">
        {children}
      </h1>
    );
  },
  h2({ children }) {
    return (
      <h2 className="mt-3 mb-1.5 text-[13px] font-semibold text-fg first:mt-0">
        {children}
      </h2>
    );
  },
  h3({ children }) {
    return (
      <h3 className="mt-3 mb-1.5 text-[13px] font-medium text-fg first:mt-0">
        {children}
      </h3>
    );
  },
  h4({ children }) {
    return (
      <h4 className="mt-3 mb-1.5 text-[13px] font-medium text-fg-secondary first:mt-0">
        {children}
      </h4>
    );
  },
  h5({ children }) {
    return (
      <h5 className="mt-2 mb-1 text-[12px] font-medium text-fg-muted first:mt-0">
        {children}
      </h5>
    );
  },
  h6({ children }) {
    return (
      <h6 className="mt-2 mb-1 text-[12px] font-medium text-fg-muted first:mt-0">
        {children}
      </h6>
    );
  },
  ul({ children }) {
    return <ul className="my-1.5 list-disc space-y-1 pl-4">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="my-1.5 list-decimal space-y-1 pl-4">{children}</ol>;
  },
  li({ children }) {
    return <li className="leading-relaxed">{children}</li>;
  },
  strong({ children }) {
    return <strong className="font-medium text-fg">{children}</strong>;
  },
  del({ children }) {
    return <del className="line-through">{children}</del>;
  },
  code({ className, children }) {
    return (
      <code className={[INLINE_CODE, className].filter(Boolean).join(" ")}>
        {children}
      </code>
    );
  },
  pre({ children }) {
    return (
      <pre className="my-2 overflow-x-auto rounded-md border border-line bg-canvas p-2">
        {children}
      </pre>
    );
  },
  blockquote({ children }) {
    return (
      <blockquote className="my-2 border-l-2 border-line pl-3 text-fg-muted">
        {children}
      </blockquote>
    );
  },
  hr() {
    return <hr className="my-3 border-t border-line" />;
  },
  table({ children }) {
    return (
      <table className="my-2 w-full border-collapse text-left text-[12px]">
        {children}
      </table>
    );
  },
  th({ children }) {
    return (
      <th className="border border-line px-2 py-1 font-medium text-fg">
        {children}
      </th>
    );
  },
  td({ children }) {
    return <td className="border border-line px-2 py-1">{children}</td>;
  },
  img({ src, alt }) {
    // safeUrl 不放行时 src 为空串，此时不渲染 <img>，避免向未授权地址发起请求
    if (!src) return null;
    return (
      <img
        src={src}
        alt={alt ?? ""}
        loading="lazy"
        className="my-2 max-w-full rounded-md border border-line"
      />
    );
  },
  a({ href, children }) {
    // href 为空（协议未放行）时退化为纯文本：不可点，也没有可导航的地址
    if (!href) return <span>{children}</span>;
    // 前端拦截是必需的：Rust 侧没有 on_navigation，不拦会把应用界面导航走（ADR-0028）
    const open = (event: { preventDefault: () => void }) => {
      event.preventDefault();
      void openUrl(href);
    };
    return (
      <a
        href={href}
        className="text-brand underline underline-offset-2 hover:text-brand-hover"
        onClick={open}
        onAuxClick={open}
      >
        {children}
      </a>
    );
  },
};

interface NotesErrorBoundaryProps {
  fallback: string;
  children: ReactNode;
}

interface NotesErrorBoundaryState {
  failed: boolean;
}

/** 渲染层出意外（如某个 components 覆盖抛错）时退回纯文本。
 *  说明区是纯展示，不属于主流程，降级后更新检测与下载照常——按 ADR-0024 规则 3
 *  「纯优化性操作降级为日志后继续」，但必须留痕，不能默默吞掉。
 *  「Markdown 畸形」不会走到这里：react-markdown 对畸形输入容错，只会当成段落渲染。 */
export class NotesErrorBoundary extends Component<
  NotesErrorBoundaryProps,
  NotesErrorBoundaryState
> {
  state: NotesErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): NotesErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn("更新说明渲染失败，已回退为纯文本：", error);
  }

  render() {
    if (this.state.failed) {
      return (
        <p className="max-h-72 overflow-y-auto whitespace-pre-wrap text-[13px] leading-relaxed text-fg-secondary">
          {this.props.fallback}
        </p>
      );
    }
    return this.props.children;
  }
}

export interface ReleaseNotesProps {
  /** `latest.json` 的 notes：发布侧写入的原始 Markdown（ADR-0028） */
  markdown: string;
}

/** 设置 → 检查更新的说明区。容器高度、滚动与纯文本回退都收在这里，调用方只传字符串。 */
export function ReleaseNotes({ markdown }: ReleaseNotesProps) {
  return (
    <NotesErrorBoundary fallback={markdown}>
      <div
        tabIndex={0}
        className="max-h-72 overflow-y-auto wrap-break-word text-[13px] leading-relaxed text-fg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface-2"
      >
        <Markdown
          remarkPlugins={[remarkGfm]}
          skipHtml
          urlTransform={safeUrl}
          components={components}
        >
          {markdown}
        </Markdown>
      </div>
    </NotesErrorBoundary>
  );
}
