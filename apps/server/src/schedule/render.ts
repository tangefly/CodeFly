import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ScheduleAgendaItem,
  ScheduleAgendaModel,
  ScheduleConfidence,
  SchedulePriority,
} from "@codefly/protocol";
import sharp from "sharp";
import { formatDateTimeInTimezone } from "./time.js";

export interface RenderAgendaInput {
  agenda: ScheduleAgendaModel;
  outputDir: string;
  /**
   * Rasterization scale. The layout is authored at 820px logical width; the
   * default of 3 renders at roughly 300 DPI on A4, which is print quality.
   */
  scale?: number;
}

export interface RenderAgendaResult {
  agenda: ScheduleAgendaModel;
  buffer: Buffer;
  filePath: string;
  width: number;
  height: number;
  dataUrl: string | null;
}

/**
 * Inline images travel to LLM providers, which reject any image whose width
 * or height exceeds 8192 px. A tall agenda at print-quality scale grows past
 * that, so the data URL carries a downscaled copy capped at 4096 px on its
 * long edge — comfortably inside provider limits and cheaper in tokens. The
 * file on disk (and `buffer`) keeps full print quality for export and email.
 */
const INLINE_MAX_EDGE = 4096;

export const PRIORITY_LABEL: Record<SchedulePriority, string> = {
  urgent: "紧急",
  high: "高",
  medium: "中",
  low: "低",
};

export const CONFIDENCE_LABEL: Record<ScheduleConfidence, string> = {
  low: "置信低",
  medium: "置信中",
  high: "置信高",
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function charWidth(char: string, fontSize: number): number {
  const code = char.codePointAt(0) ?? 0;
  if (code > 0x2e7f) return fontSize;
  if ("MW@#%&".includes(char)) return fontSize * 0.78;
  if (char === " ") return fontSize * 0.28;
  return fontSize * 0.55;
}

function textWidth(value: string, fontSize: number): number {
  let width = 0;
  for (const char of value) width += charWidth(char, fontSize);
  return width;
}

function truncate(value: string, maxWidth: number, fontSize: number): string {
  if (textWidth(value, fontSize) <= maxWidth) return value;
  let result = "";
  let width = textWidth("…", fontSize);
  for (const char of value) {
    const next = charWidth(char, fontSize);
    if (width + next > maxWidth) break;
    result += char;
    width += next;
  }
  return `${result}…`;
}

function wrap(
  value: string,
  maxWidth: number,
  fontSize: number,
  maxLines: number,
): string[] {
  const lines: string[] = [];
  let current = "";
  let width = 0;
  for (const char of value) {
    const next = charWidth(char, fontSize);
    if (width + next > maxWidth && current !== "") {
      lines.push(current);
      if (lines.length >= maxLines) break;
      current = "";
      width = 0;
    }
    current += char;
    width += next;
  }
  if (lines.length < maxLines && current !== "") lines.push(current);
  if (lines.length === maxLines && textWidth(value, fontSize) > maxWidth * maxLines) {
    lines[maxLines - 1] = truncate(lines[maxLines - 1]!, maxWidth, fontSize);
  }
  return lines;
}

function minutesLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
}

function itemColor(item: ScheduleAgendaItem): string {
  if (item.status === "done") return "#047857";
  if (item.status === "skipped") return "#9ca3af";
  return item.kind === "fixed" ? "#0f766e" : "#1d4ed8";
}

function itemMeta(item: ScheduleAgendaItem): string {
  if (item.kind === "fixed") {
    const location = item.location.trim();
    const parts = location === "" ? ["固定"] : ["固定", location];
    if (item.busy === false) parts.push("可并行");
    return parts.join(" · ");
  }
  const status =
    item.status === "done"
      ? "已完成"
      : item.status === "skipped"
        ? "已跳过"
        : "待办";
  const priority = item.priority === null ? "" : `${PRIORITY_LABEL[item.priority]} · `;
  const actual =
    item.actualMinutes !== null && item.actualMinutes > 0
      ? ` · 实际 ${item.actualMinutes}m`
      : "";
  return `${priority}${status}${actual}`;
}

/**
 * Renders the rolling agenda to a portrait PNG: one section per day, with
 * fixed commitments and task blocks in chronological order. This intentionally
 * uses a light printable palette rather than the app's dark theme.
 */
export async function renderAgendaPng(
  input: RenderAgendaInput,
): Promise<RenderAgendaResult> {
  const { agenda } = input;
  const margin = 36;
  const width = 820;
  const scale = Math.min(4, Math.max(1, input.scale ?? 3));
  const contentWidth = width - margin * 2;
  const summaryTop = 92;
  const summaryHeight = 44;
  const daysTop = summaryTop + summaryHeight + 24;
  const dayHeaderHeight = 34;
  const itemHeight = 38;
  const emptyHeight = 34;
  const dayFooterHeight = 22;
  const dayGap = 14;

  const dayLayouts = agenda.days.map((day) => {
    const rows = Math.max(1, day.items.length);
    const rowHeight = day.items.length === 0 ? emptyHeight : itemHeight;
    return {
      day,
      height: dayHeaderHeight + rows * rowHeight + dayFooterHeight,
    };
  });
  const daysHeight = dayLayouts.reduce(
    (total, layout, index) => total + layout.height + (index === 0 ? 0 : dayGap),
    0,
  );

  const notesLines =
    agenda.notes.trim() === ""
      ? 0
      : wrap(agenda.notes.trim(), contentWidth - 8, 11.5, 5).length;
  const footerTop = daysTop + daysHeight + 28;
  const footerHeight =
    (agenda.unscheduled.length > 0 ? 26 + agenda.unscheduled.length * 18 : 0) +
    (agenda.warnings.length > 0 ? 26 + agenda.warnings.length * 18 : 0) +
    (notesLines > 0 ? 26 + notesLines * 18 : 0) +
    44;
  const height = footerTop + footerHeight + margin;

  const parts: string[] = [];
  const push = (value: string): void => {
    parts.push(value);
  };

  push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * scale}" height="${height * scale}" viewBox="0 0 ${width} ${height}" font-family="Noto Sans CJK SC, Noto Sans, sans-serif">`,
  );
  push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);

  push(
    `<text x="${margin}" y="50" font-size="25" font-weight="700" fill="#111827">${escapeXml(
      `未来 ${agenda.days.length} 天日程 · ${agenda.startDate} ~ ${agenda.endDate}`,
    )}</text>`,
  );
  push(
    `<text x="${margin}" y="74" font-size="12" fill="#6b7280">${escapeXml(
      `时区 ${agenda.timezone} · 生成于 ${formatDateTimeInTimezone(
        agenda.generatedAt,
        agenda.timezone,
      )}（当地时间）`,
    )}</text>`,
  );

  const fixedCount = agenda.days.reduce(
    (total, day) => total + day.items.filter((item) => item.kind === "fixed").length,
    0,
  );
  push(
    `<rect x="${margin}" y="${summaryTop}" width="${contentWidth}" height="${summaryHeight}" rx="10" fill="#f3f6fb" stroke="#dbe3ef"/>`,
  );
  const summaryText = [
    `${agenda.summary.taskCount} 项任务`,
    ...(fixedCount > 0 ? [`固定安排 ${fixedCount} 次`] : []),
    `计划 ${minutesLabel(agenda.summary.totalPlannedMinutes)}`,
    `已完成 ${minutesLabel(agenda.summary.doneMinutes)}`,
    agenda.unscheduled.length > 0
      ? `未排期 ${agenda.unscheduled.length} 项`
      : "全部已排入",
  ].join("   ·   ");
  push(
    `<text x="${margin + 16}" y="${summaryTop + 27}" font-size="13" fill="#374151">${escapeXml(summaryText)}</text>`,
  );

  let y = daysTop;
  dayLayouts.forEach((layout) => {
    const { day } = layout;
    const isToday = day.date === agenda.today;
    push(
      `<rect x="${margin}" y="${y}" width="${contentWidth}" height="${layout.height}" rx="10" fill="${
        isToday ? "#f0f7ff" : "#ffffff"
      }" stroke="${isToday ? "#bfdbfe" : "#e2e8f0"}"/>`,
    );
    push(
      `<rect x="${margin}" y="${y}" width="${contentWidth}" height="${dayHeaderHeight}" rx="10" fill="${
        isToday ? "#dbeafe" : "#f1f5f9"
      }"/>`,
    );
    push(
      `<text x="${margin + 14}" y="${y + 22}" font-size="13.5" font-weight="700" fill="#1f2937">${escapeXml(
        `${day.weekday} · ${day.date}`,
      )}</text>`,
    );
    if (isToday) {
      push(
        `<rect x="${margin + 146}" y="${y + 8}" width="38" height="18" rx="9" fill="#2563eb"/>`,
      );
      push(
        `<text x="${margin + 165}" y="${y + 21}" font-size="10" font-weight="600" fill="#ffffff" text-anchor="middle">今天</text>`,
      );
    }
    push(
      `<text x="${margin + contentWidth - 14}" y="${y + 22}" font-size="11" fill="#64748b" text-anchor="end">${escapeXml(
        `${day.items.length} 项 · ${minutesLabel(day.plannedMinutes)}`,
      )}</text>`,
    );

    let rowY = y + dayHeaderHeight;
    if (day.items.length === 0) {
      push(
        `<text x="${margin + 14}" y="${rowY + 22}" font-size="11.5" fill="#9ca3af">${escapeXml(
          "无安排",
        )}</text>`,
      );
      rowY += emptyHeight;
    } else {
      day.items.forEach((item, index) => {
        const color = itemColor(item);
        if (index % 2 === 1) {
          push(
            `<rect x="${margin + 1}" y="${rowY}" width="${contentWidth - 2}" height="${itemHeight}" fill="#fafbfd"/>`,
          );
        }
        push(
          `<rect x="${margin + 1}" y="${rowY + 7}" width="3" height="${itemHeight - 14}" rx="1.5" fill="${color}"/>`,
        );
        if (item.parallelBlocks !== undefined && item.parallelBlocks.length > 0) {
          // Course on the left, task blocks running inside it on the right,
          // split by a divider so the parallel arrangement reads at a glance.
          const splitX = margin + Math.round(contentWidth * 0.44);
          push(
            `<line x1="${splitX}" y1="${rowY + 8}" x2="${splitX}" y2="${rowY + itemHeight - 8}" stroke="#dbe4ee"/>`,
          );
          push(
            `<text x="${margin + 14}" y="${rowY + 23}" font-size="11.5" fill="${color}">${escapeXml(
              `${item.start}-${item.end}`,
            )}</text>`,
          );
          push(
            `<text x="${margin + 108}" y="${rowY + 23}" font-size="12.5" font-weight="600" fill="#111827">${escapeXml(
              truncate(item.title, splitX - (margin + 108) - 12, 12.5),
            )}</text>`,
          );
          const taskAreaStart = splitX + 14;
          const taskAreaEnd = margin + contentWidth - 14;
          let taskX = taskAreaStart;
          const separator = " ∥ ";
          for (let blockIndex = 0; blockIndex < item.parallelBlocks.length; blockIndex += 1) {
            const block = item.parallelBlocks[blockIndex]!;
            if (blockIndex > 0) {
              const separatorWidth = textWidth(separator, 10.5);
              if (taskX + separatorWidth > taskAreaEnd) break;
              push(
                `<text x="${taskX}" y="${rowY + 23}" font-size="10.5" fill="#94a3b8">${escapeXml(separator)}</text>`,
              );
              taskX += separatorWidth;
            }
            const time = `${block.start}-${block.end} `;
            const mark =
              block.status === "done"
                ? "✓ "
                : block.status === "skipped"
                  ? "— "
                  : "";
            const title = `${mark}${block.title}`;
            const timeWidth = textWidth(time, 11.5);
            const maxTitleWidth = Math.max(
              40,
              taskAreaEnd - taskX - timeWidth,
            );
            const titleWidth = Math.min(
              textWidth(truncate(title, maxTitleWidth, 11.5), 11.5),
              maxTitleWidth,
            );
            if (taskX + timeWidth + 20 > taskAreaEnd) break;
            push(
              `<text x="${taskX}" y="${rowY + 23}" font-size="11.5" fill="#1d4ed8">${escapeXml(time)}</text>`,
            );
            push(
              `<text x="${taskX + timeWidth}" y="${rowY + 23}" font-size="11.5" font-weight="600" fill="${
                block.status === "skipped" ? "#9ca3af" : "#111827"
              }">${escapeXml(truncate(title, maxTitleWidth, 11.5))}</text>`,
            );
            taskX += timeWidth + titleWidth;
          }
        } else {
          push(
            `<text x="${margin + 14}" y="${rowY + 23}" font-size="11.5" fill="${color}">${escapeXml(
              `${item.start}-${item.end}`,
            )}</text>`,
          );
          const titleMax = contentWidth - 110 - 170;
          push(
            `<text x="${margin + 108}" y="${rowY + 23}" font-size="12.5" font-weight="600" fill="${
              item.status === "skipped" ? "#9ca3af" : "#111827"
            }">${escapeXml(
              truncate(
                `${item.status === "done" ? "✓ " : item.status === "skipped" ? "— " : ""}${item.title}`,
                titleMax,
                12.5,
              ),
            )}</text>`,
          );
          push(
            `<text x="${margin + contentWidth - 14}" y="${rowY + 23}" font-size="10.5" fill="#6b7280" text-anchor="end">${escapeXml(
              truncate(
                item.note.trim() === "" ? itemMeta(item) : `${itemMeta(item)} · ${item.note.trim()}`,
                170,
                10.5,
              ),
            )}</text>`,
          );
        }
        if (index < day.items.length - 1) {
          push(
            `<line x1="${margin + 14}" y1="${rowY + itemHeight}" x2="${margin + contentWidth - 14}" y2="${rowY + itemHeight}" stroke="#eef2f7"/>`,
          );
        }
        rowY += itemHeight;
      });
    }

    const freeLabel =
      day.freeMinutes === null
        ? day.items.length > 0
          ? "非工作日 · 有安排"
          : "休息日"
        : day.freeMinutes <= 0
          ? "工作时段已排满"
          : `空闲约 ${minutesLabel(day.freeMinutes)}`;
    push(
      `<text x="${margin + 14}" y="${rowY + 16}" font-size="10.5" fill="#64748b">${escapeXml(
        freeLabel,
      )}</text>`,
    );
    push(
      `<text x="${margin + contentWidth - 14}" y="${rowY + 16}" font-size="10.5" fill="#94a3b8" text-anchor="end">${escapeXml(
        `${day.date.slice(5)} 计划 ${minutesLabel(day.plannedMinutes)}`,
      )}</text>`,
    );

    y += layout.height + dayGap;
  });

  // Footer: unscheduled work, warnings and notes.
  let footerY = footerTop;
  if (agenda.unscheduled.length > 0) {
    push(
      `<text x="${margin}" y="${footerY}" font-size="13" font-weight="700" fill="#b45309">${escapeXml(
        "未排期任务",
      )}</text>`,
    );
    footerY += 20;
    for (const item of agenda.unscheduled) {
      push(
        `<text x="${margin + 8}" y="${footerY}" font-size="11.5" fill="#6b7280">${escapeXml(
          truncate(
            `• ${item.title} · 剩余 ${minutesLabel(item.remainingMinutes)} · ${item.reason}`,
            contentWidth - 8,
            11.5,
          ),
        )}</text>`,
      );
      footerY += 18;
    }
    footerY += 8;
  }
  if (agenda.warnings.length > 0) {
    push(
      `<text x="${margin}" y="${footerY}" font-size="13" font-weight="700" fill="#b91c1c">${escapeXml(
        "提醒",
      )}</text>`,
    );
    footerY += 20;
    for (const warning of agenda.warnings) {
      push(
        `<text x="${margin + 8}" y="${footerY}" font-size="11.5" fill="#6b7280">${escapeXml(
          truncate(`• ${warning}`, contentWidth - 8, 11.5),
        )}</text>`,
      );
      footerY += 18;
    }
    footerY += 8;
  }
  if (agenda.notes.trim() !== "") {
    push(
      `<text x="${margin}" y="${footerY}" font-size="13" font-weight="700" fill="#374151">${escapeXml(
        "备注",
      )}</text>`,
    );
    footerY += 20;
    for (const line of wrap(agenda.notes.trim(), contentWidth - 8, 11.5, 5)) {
      push(
        `<text x="${margin + 8}" y="${footerY}" font-size="11.5" fill="#6b7280">${escapeXml(
          line,
        )}</text>`,
      );
      footerY += 18;
    }
  }

  push(
    `<text x="${margin}" y="${height - 18}" font-size="10" fill="#9ca3af">${escapeXml(
      "CodeFly 日程助手 · 按天议程 · 时间均为本地墙钟时间",
    )}</text>`,
  );
  push("</svg>");

  const svg = parts.join("\n");
  const image = sharp(Buffer.from(svg)).png({ compressionLevel: 9 });
  const { data, info } = await image.toBuffer({ resolveWithObject: true });
  // Keep the file stamp consistent with the timestamp printed on the PNG:
  // both use the user's timezone, never raw UTC.
  const stamp = formatDateTimeInTimezone(
    agenda.generatedAt,
    agenda.timezone,
  ).replace(/\D/g, "");
  const fileName = `week-${agenda.startDate}-${stamp}-${randomUUID().slice(0, 6)}.png`;
  const filePath = path.join(input.outputDir, fileName);
  await writeFile(filePath, data);

  const inline =
    Math.max(info.width, info.height) <= INLINE_MAX_EDGE
      ? data
      : await sharp(data)
          .resize({
            width: INLINE_MAX_EDGE,
            height: INLINE_MAX_EDGE,
            fit: "inside",
            withoutEnlargement: true,
          })
          .png({ compressionLevel: 9 })
          .toBuffer();

  return {
    agenda,
    buffer: data,
    filePath,
    width: info.width,
    height: info.height,
    dataUrl:
      inline.byteLength <= 1_500_000
        ? `data:image/png;base64,${inline.toString("base64")}`
        : null,
  };
}
