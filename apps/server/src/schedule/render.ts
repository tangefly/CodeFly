import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ScheduleBlockStatus,
  ScheduleConfidence,
  SchedulePlan,
  SchedulePlanSummary,
  SchedulePreferences,
  SchedulePriority,
  ScheduleTask,
  ScheduleUnscheduledTask,
} from "@codefly/protocol";
import sharp from "sharp";
import {
  addDays,
  clockToMinutes,
  durationMinutes,
  todayInTimezone,
  weekdayLabel,
} from "./time.js";

export interface ScheduleTableCellBlock {
  id: string;
  start: string;
  end: string;
  status: ScheduleBlockStatus;
  actualMinutes: number | null;
  note: string;
}

export interface ScheduleTableRow {
  taskId: string;
  title: string;
  priority: SchedulePriority;
  confidence: ScheduleConfidence;
  status: ScheduleTask["status"];
  estimatedMinutes: number;
  remainingMinutes: number;
  actualMinutes: number;
  totalMinutes: number;
  days: ScheduleTableCellBlock[][];
}

export interface ScheduleTableDay {
  date: string;
  label: string;
}

/** Structured table shared by the UI card, the PNG renderer and emails. */
export interface ScheduleTableModel {
  weekStart: string;
  weekEnd: string;
  timezone: string;
  generatedAt: string;
  days: ScheduleTableDay[];
  rows: ScheduleTableRow[];
  summary: SchedulePlanSummary;
  unscheduled: ScheduleUnscheduledTask[];
  warnings: string[];
  notes: string;
}

export interface RenderWeekInput {
  plan: SchedulePlan | null;
  tasks: ScheduleTask[];
  preferences: SchedulePreferences;
  weekStart: string;
  weekEnd: string;
  summary: SchedulePlanSummary;
  outputDir: string;
  notes?: string;
}

export interface RenderWeekResult {
  table: ScheduleTableModel;
  buffer: Buffer;
  filePath: string;
  width: number;
  height: number;
  dataUrl: string | null;
}

const PRIORITY_LABEL: Record<SchedulePriority, string> = {
  urgent: "紧急",
  high: "高",
  medium: "中",
  low: "低",
};

const CONFIDENCE_LABEL: Record<ScheduleConfidence, string> = {
  low: "置信低",
  medium: "置信中",
  high: "置信高",
};

const STATUS_LABEL: Record<ScheduleBlockStatus, string> = {
  planned: "",
  done: "✓ ",
  skipped: "— ",
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

function wrap(value: string, maxWidth: number, fontSize: number, maxLines: number): string[] {
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

/** Compact duration for narrow table cells, e.g. 2h18m. */
function minutesShort(minutes: number): string {
  if (minutes <= 0) return "0m";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}

/** Builds the task × weekday table used by the UI and the PNG. */
export function buildScheduleTable(input: {
  plan: SchedulePlan | null;
  tasks: ScheduleTask[];
  preferences: SchedulePreferences;
  weekStart: string;
  weekEnd: string;
  summary: SchedulePlanSummary;
  notes?: string;
}): ScheduleTableModel {
  const taskIndex = new Map(input.tasks.map((task) => [task.id, task]));
  const days: ScheduleTableDay[] = [];
  for (let index = 0; index < 7; index += 1) {
    const date = addDays(input.weekStart, index);
    days.push({ date, label: weekdayLabel(date) });
  }

  const rows = new Map<string, ScheduleTableRow>();
  for (const block of input.plan?.blocks ?? []) {
    const task = taskIndex.get(block.taskId);
    let row = rows.get(block.taskId);
    if (row === undefined) {
      row = {
        taskId: block.taskId,
        title: task?.title ?? "已删除任务",
        priority: task?.priority ?? "medium",
        confidence: task?.estimateConfidence ?? "medium",
        status: task?.status ?? "todo",
        estimatedMinutes: task?.estimatedMinutes ?? 0,
        remainingMinutes: task?.remainingMinutes ?? 0,
        actualMinutes: task?.actualMinutes ?? 0,
        totalMinutes: 0,
        days: days.map(() => []),
      };
      rows.set(block.taskId, row);
    }
    const dayIndex = days.findIndex((day) => day.date === block.date);
    if (dayIndex < 0) continue;
    row.days[dayIndex]!.push({
      id: block.id,
      start: block.start,
      end: block.end,
      status: block.status,
      actualMinutes: block.actualMinutes,
      note: block.note,
    });
    if (block.status !== "skipped") {
      row.totalMinutes += durationMinutes(block.start, block.end);
    }
  }

  for (const row of rows.values()) {
    for (const cell of row.days) {
      cell.sort((a, b) => clockToMinutes(a.start) - clockToMinutes(b.start));
    }
  }

  const priorityRank: Record<SchedulePriority, number> = {
    urgent: 4,
    high: 3,
    medium: 2,
    low: 1,
  };
  const sorted = [...rows.values()].sort((a, b) => {
    const aFirst = a.days.findIndex((cell) => cell.length > 0);
    const bFirst = b.days.findIndex((cell) => cell.length > 0);
    const aStart = a.days[aFirst]?.[0]?.start ?? "99:99";
    const bStart = b.days[bFirst]?.[0]?.start ?? "99:99";
    return (
      aFirst - bFirst ||
      aStart.localeCompare(bStart) ||
      priorityRank[b.priority] - priorityRank[a.priority] ||
      a.title.localeCompare(b.title)
    );
  });

  return {
    weekStart: input.weekStart,
    weekEnd: input.weekEnd,
    timezone: input.preferences.timezone,
    generatedAt: new Date().toISOString(),
    days,
    rows: sorted,
    summary: input.summary,
    unscheduled:
      input.plan?.unscheduled.map((item) => ({ ...item })) ?? [],
    warnings: [...(input.plan?.warnings ?? [])],
    notes: input.notes ?? input.plan?.notes ?? "",
  };
}

/**
 * Renders the weekly table to PNG via SVG + sharp. This intentionally uses a
 * light printable palette rather than the app's dark theme.
 */
export async function renderWeekPng(
  input: RenderWeekInput,
): Promise<RenderWeekResult> {
  const table = buildScheduleTable(input);
  const today = todayInTimezone(input.preferences.timezone);

  const margin = 32;
  const taskWidth = 260;
  const metaWidth = 150;
  const dayWidth = 148;
  const tableWidth = taskWidth + metaWidth + dayWidth * 7;
  const width = margin * 2 + tableWidth;
  const summaryTop = 96;
  const tableTop = 166;
  const tableHeaderHeight = 44;
  const rowPadding = 9;
  const lineHeight = 17;
  const maxCellLines = 3;

  const rowLayouts = table.rows.map((row) => {
    const titleLines = wrap(
      truncate(row.title, taskWidth - 20, 13),
      taskWidth - 20,
      13,
      2,
    ).length;
    const cellLines = row.days.reduce(
      (max, cell) => Math.max(max, Math.min(cell.length, maxCellLines)),
      0,
    );
    return {
      row,
      titleLineCount: titleLines,
      height: Math.max(
        52,
        titleLines * lineHeight + 30,
        cellLines * lineHeight + rowPadding * 2,
      ),
    };
  });
  const rowsHeight = rowLayouts.reduce((total, layout) => total + layout.height, 0);
  const emptyHeight = rowLayouts.length === 0 ? 52 : 0;
  const tableHeight = tableHeaderHeight + rowsHeight + emptyHeight;

  const warningLines = table.warnings.length;
  const unscheduledLines = table.unscheduled.length;
  const notesLines = table.notes.trim() === "" ? 0 : wrap(table.notes.trim(), width - margin * 2, 12, 4).length;
  const footerTop = tableTop + tableHeight + 30;
  const footerHeight =
    (unscheduledLines > 0 ? 26 + unscheduledLines * 18 : 0) +
    (warningLines > 0 ? 26 + warningLines * 18 : 0) +
    (notesLines > 0 ? 26 + notesLines * 18 : 0) +
    52;
  const height = footerTop + footerHeight + margin;

  const parts: string[] = [];
  const push = (value: string): void => {
    parts.push(value);
  };

  push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Noto Sans CJK SC, Noto Sans, sans-serif">`,
  );
  push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);

  // Title and subtitle.
  push(
    `<text x="${margin}" y="54" font-size="25" font-weight="700" fill="#111827">${escapeXml(
      `一周日程计划 · ${table.weekStart} ~ ${table.weekEnd}`,
    )}</text>`,
  );
  push(
    `<text x="${margin}" y="78" font-size="12" fill="#6b7280">${escapeXml(
      `时区 ${table.timezone} · 生成于 ${table.generatedAt.replace("T", " ").slice(0, 16)}`,
    )}</text>`,
  );

  // Summary strip.
  push(
    `<rect x="${margin}" y="${summaryTop}" width="${width - margin * 2}" height="46" rx="10" fill="#f3f6fb" stroke="#dbe3ef"/>`,
  );
  const summaryText = [
    `${table.rows.length} 项任务`,
    `计划 ${minutesLabel(table.summary.totalPlannedMinutes)}`,
    `已完成 ${minutesLabel(table.summary.doneMinutes)}`,
    table.unscheduled.length > 0
      ? `未排期 ${table.unscheduled.length} 项`
      : "全部已排入",
    `工作日 ${input.preferences.workdays.map((day) => ["一", "二", "三", "四", "五", "六", "日"][day - 1]).join("、")}`,
  ].join("   ·   ");
  push(
    `<text x="${margin + 16}" y="${summaryTop + 28}" font-size="13" fill="#374151">${escapeXml(summaryText)}</text>`,
  );

  // Table header.
  push(
    `<rect x="${margin}" y="${tableTop}" width="${tableWidth}" height="${tableHeaderHeight}" fill="#eef2f7"/>`,
  );
  const columns = [
    { x: margin, width: taskWidth, label: "任务" },
    { x: margin + taskWidth, width: metaWidth, label: "优先级 / 预估" },
    ...table.days.map((day, index) => ({
      x: margin + taskWidth + metaWidth + dayWidth * index,
      width: dayWidth,
      label: `${day.label} ${day.date.slice(5)}`,
    })),
  ];
  for (const column of columns) {
    push(
      `<text x="${column.x + 9}" y="${tableTop + 27}" font-size="12" font-weight="600" fill="#374151">${escapeXml(column.label)}</text>`,
    );
    push(
      `<line x1="${column.x}" y1="${tableTop}" x2="${column.x}" y2="${tableTop + tableHeight}" stroke="#d6dde8"/>`,
    );
  }
  push(
    `<line x1="${margin + tableWidth}" y1="${tableTop}" x2="${margin + tableWidth}" y2="${tableTop + tableHeight}" stroke="#d6dde8"/>`,
  );
  push(
    `<line x1="${margin}" y1="${tableTop}" x2="${margin + tableWidth}" y2="${tableTop}" stroke="#c7d0dd" stroke-width="1.2"/>`,
  );

  let y = tableTop + tableHeaderHeight;
  if (rowLayouts.length === 0) {
    push(
      `<text x="${margin + 16}" y="${y + 34}" font-size="13" fill="#9ca3af">${escapeXml(
        "这一周还没有已排入的任务。可以让助手生成计划，或先在日程面板中添加任务。",
      )}</text>`,
    );
    y += 52;
  }

  rowLayouts.forEach((layout, rowIndex) => {
    const { row, height: rowHeight } = layout;
    if (rowIndex % 2 === 1) {
      push(
        `<rect x="${margin}" y="${y}" width="${tableWidth}" height="${rowHeight}" fill="#fafbfd"/>`,
      );
    }
    push(
      `<line x1="${margin}" y1="${y + rowHeight}" x2="${margin + tableWidth}" y2="${y + rowHeight}" stroke="#e5e9f0"/>`,
    );

    const titleLines = wrap(
      truncate(row.title, taskWidth - 20, 13),
      taskWidth - 20,
      13,
      2,
    );
    titleLines.forEach((line, index) => {
      push(
        `<text x="${margin + 10}" y="${y + 20 + index * lineHeight}" font-size="13" font-weight="600" fill="#111827">${escapeXml(line)}</text>`,
      );
    });
    const statusText =
      row.status === "done"
        ? "已完成"
        : row.status === "in_progress"
          ? "进行中"
          : row.status === "cancelled"
            ? "已取消"
            : "待办";
    push(
      `<text x="${margin + 10}" y="${
        y + 20 + layout.titleLineCount * lineHeight
      }" font-size="10.5" fill="#6b7280">${escapeXml(
        `${statusText} · 剩余 ${minutesLabel(row.remainingMinutes)}`,
      )}</text>`,
    );

    const metaX = margin + taskWidth + 10;
    push(
      `<text x="${metaX}" y="${y + 20}" font-size="12" font-weight="600" fill="#374151">${escapeXml(
        `${PRIORITY_LABEL[row.priority]} · ${CONFIDENCE_LABEL[row.confidence]}`,
      )}</text>`,
    );
    push(
      `<text x="${metaX}" y="${y + 38}" font-size="10.5" fill="#6b7280">${escapeXml(
        truncate(
          `预估 ${minutesShort(row.estimatedMinutes)} · 已排 ${minutesShort(row.totalMinutes)}`,
          metaWidth - 20,
          10.5,
        ),
      )}</text>`,
    );

    row.days.forEach((cell, dayIndex) => {
      const cellX = margin + taskWidth + metaWidth + dayWidth * dayIndex;
      const day = table.days[dayIndex]!;
      if (day.date === today) {
        push(
          `<rect x="${cellX}" y="${y}" width="${dayWidth}" height="${rowHeight}" fill="#f0f7ff"/>`,
        );
      }
      if (cell.length === 0) return;
      cell.slice(0, maxCellLines).forEach((block, index) => {
        const color =
          block.status === "done"
            ? "#047857"
            : block.status === "skipped"
              ? "#9ca3af"
              : "#1d4ed8";
        const actual =
          block.actualMinutes !== null && block.actualMinutes > 0
            ? ` (${block.actualMinutes}m)`
            : "";
        const text = `${STATUS_LABEL[block.status]}${block.start}-${block.end}${actual}`;
        push(
          `<text x="${cellX + 8}" y="${y + 20 + index * lineHeight}" font-size="11.5" fill="${color}">${escapeXml(
            truncate(text, dayWidth - 16, 11.5),
          )}</text>`,
        );
      });
      if (cell.length > maxCellLines) {
        push(
          `<text x="${cellX + 8}" y="${y + 20 + maxCellLines * lineHeight}" font-size="10" fill="#6b7280">${escapeXml(
            `+${cell.length - maxCellLines} 个安排`,
          )}</text>`,
        );
      }
    });

    y += rowHeight;
  });

  push(
    `<line x1="${margin}" y1="${tableTop + tableHeight}" x2="${margin + tableWidth}" y2="${tableTop + tableHeight}" stroke="#c7d0dd"/>`,
  );

  // Footer: unscheduled work, warnings and notes.
  let footerY = footerTop;
  if (table.unscheduled.length > 0) {
    push(
      `<text x="${margin}" y="${footerY}" font-size="13" font-weight="700" fill="#b45309">${escapeXml("未排期任务")}</text>`,
    );
    footerY += 20;
    for (const item of table.unscheduled) {
      push(
        `<text x="${margin + 8}" y="${footerY}" font-size="11.5" fill="#6b7280">${escapeXml(
          truncate(
            `• ${item.title} · 剩余 ${minutesLabel(item.remainingMinutes)} · ${item.reason}`,
            width - margin * 2 - 8,
            11.5,
          ),
        )}</text>`,
      );
      footerY += 18;
    }
    footerY += 8;
  }
  if (table.warnings.length > 0) {
    push(
      `<text x="${margin}" y="${footerY}" font-size="13" font-weight="700" fill="#b91c1c">${escapeXml("提醒")}</text>`,
    );
    footerY += 20;
    for (const warning of table.warnings) {
      push(
        `<text x="${margin + 8}" y="${footerY}" font-size="11.5" fill="#6b7280">${escapeXml(
          truncate(`• ${warning}`, width - margin * 2 - 8, 11.5),
        )}</text>`,
      );
      footerY += 18;
    }
    footerY += 8;
  }
  if (table.notes.trim() !== "") {
    push(
      `<text x="${margin}" y="${footerY}" font-size="13" font-weight="700" fill="#374151">${escapeXml("备注")}</text>`,
    );
    footerY += 20;
    for (const line of wrap(table.notes.trim(), width - margin * 2 - 8, 11.5, 4)) {
      push(
        `<text x="${margin + 8}" y="${footerY}" font-size="11.5" fill="#6b7280">${escapeXml(line)}</text>`,
      );
      footerY += 18;
    }
  }

  push(
    `<text x="${margin}" y="${height - 18}" font-size="10" fill="#9ca3af">${escapeXml(
      "CodeFly 日程助手 · 可打印周计划 · 时间均为本地墙钟时间",
    )}</text>`,
  );
  push("</svg>");

  const svg = parts.join("\n");
  const image = sharp(Buffer.from(svg)).png({ compressionLevel: 9 });
  const { data, info } = await image.toBuffer({ resolveWithObject: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14);
  const fileName = `week-${input.weekStart}-${stamp}-${randomUUID().slice(0, 6)}.png`;
  const filePath = path.join(input.outputDir, fileName);
  await writeFile(filePath, data);

  return {
    table,
    buffer: data,
    filePath,
    width: info.width,
    height: info.height,
    dataUrl:
      data.byteLength <= 1_500_000
        ? `data:image/png;base64,${data.toString("base64")}`
        : null,
  };
}

export { PRIORITY_LABEL, CONFIDENCE_LABEL };
