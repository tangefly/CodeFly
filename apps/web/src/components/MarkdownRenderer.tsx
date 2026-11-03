import { memo, useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { createCodePlugin } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import "katex/dist/katex.min.css";

const codePlugin = createCodePlugin({
  themes: ["github-dark", "github-dark"],
});

const mathPlugin = createMathPlugin({
  singleDollarTextMath: true,
});

/** While streaming, re-parse Markdown at most this often. */
const STREAM_RENDER_INTERVAL_MS = 60;

/**
 * Throttles the text handed to Streamdown. Re-parsing the whole message for
 * every streamed chunk competes with wheel scrolling on the main thread, so
 * intermediate frames are skipped; the final text always renders immediately
 * once streaming stops.
 */
function useThrottledText(text: string, intervalMs: number): string {
  const [display, setDisplay] = useState(text);
  const latest = useRef(text);
  const timer = useRef<number | null>(null);
  const lastRenderAt = useRef(0);

  latest.current = text;

  useEffect(() => {
    if (intervalMs <= 0) {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      setDisplay(text);
      return;
    }
    if (text === display) return;

    const elapsed = Date.now() - lastRenderAt.current;
    if (elapsed >= intervalMs) {
      lastRenderAt.current = Date.now();
      setDisplay(text);
      return;
    }
    if (timer.current === null) {
      timer.current = window.setTimeout(() => {
        timer.current = null;
        lastRenderAt.current = Date.now();
        setDisplay(latest.current);
      }, intervalMs - elapsed);
    }
  }, [text, display, intervalMs]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return intervalMs > 0 ? display : text;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const renderedText = useThrottledText(
    text,
    streaming ? STREAM_RENDER_INTERVAL_MS : 0,
  );

  return (
    <div className="sd-prose">
      <Streamdown
        plugins={{ code: codePlugin, math: mathPlugin }}
        shikiTheme={["github-dark", "github-dark"]}
        isAnimating={streaming}
      >
        {renderedText}
      </Streamdown>
    </div>
  );
});
