import { memo } from "react";
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

export const MarkdownRenderer = memo(function MarkdownRenderer({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  return (
    <div className="sd-prose">
      <Streamdown
        plugins={{ code: codePlugin, math: mathPlugin }}
        shikiTheme={["github-dark", "github-dark"]}
        isAnimating={streaming}
      >
        {text}
      </Streamdown>
    </div>
  );
});
