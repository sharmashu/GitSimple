import { jsPDF } from "jspdf";

export interface PDFRelatedCommit {
  shortSha: string;
  title: string;
  author: string;
  date?: string;
  reason?: string;
}

export interface PDFReportData {
  repoName: string;
  repoUrl: string;
  sha: string;
  title: string;
  author: string;
  date: string;
  impactLevel: string;
  stats?: { files_changed: number; additions: number; deletions: number } | null;
  executiveSummary: string;
  breakingChanges: string[];
  domains: string[];
  detailedReport: string; // markdown
  related: PDFRelatedCommit[];
}

const PAGE_W = 210;
const MARGIN = 18;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BOTTOM = 280;

const IMPACT_COLORS: Record<string, [number, number, number]> = {
  Breaking: [220, 38, 38],
  Security: [234, 88, 12],
  Feature: [22, 163, 74],
  Performance: [8, 145, 178],
  Refactor: [124, 58, 237],
  Fix: [37, 99, 235],
};

/** jsPDF's built-in fonts only cover Latin-1: replace common symbols, drop the rest. */
function clean(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[→⇒]/g, "->")
    .replace(/[←]/g, "<-")
    .replace(/[•●▪]/g, "-")
    .replace(/[✓✔]/g, "v")
    // Brackets holding only unsupported text (e.g. a name in another script) are dropped entirely
    .replace(/\s*\(\s*[^\x20-\x7E\xA0-\xFF]+[^()\x20-\x7E\xA0-\xFF\s]*\s*\)/g, "")
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "");
}

/** Removes inline markdown (bold, italics, code ticks, links) for plain rendering. */
function inline(text: string): string {
  return clean(text)
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(^|\s)\*(\S.*?)\*(?=\s|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

export function generateCommitPDF(data: PDFReportData): ArrayBuffer {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  let y = MARGIN;

  const ensure = (h: number) => {
    if (y + h > BOTTOM) {
      doc.addPage();
      y = MARGIN;
    }
  };

  const paragraph = (text: string, opts: { size?: number; style?: "normal" | "bold" | "italic"; color?: [number, number, number]; indent?: number; font?: string; lineH?: number } = {}) => {
    const size = opts.size ?? 10.5;
    const indent = opts.indent ?? 0;
    doc.setFont(opts.font || "helvetica", opts.style || "normal");
    doc.setFontSize(size);
    doc.setTextColor(...(opts.color || [51, 65, 85]));
    const lines = doc.splitTextToSize(text, CONTENT_W - indent) as string[];
    const lineH = opts.lineH ?? size * 0.48;
    for (const line of lines) {
      ensure(lineH);
      doc.text(line, MARGIN + indent, y);
      y += lineH;
    }
  };

  // ---- Header -------------------------------------------------------------
  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, PAGE_W, 34, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(255, 255, 255);
  doc.text("Commit Explanation Report", MARGIN, 15);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.setTextColor(203, 213, 225);
  doc.text(clean(`${data.repoName}  -  ${data.sha.slice(0, 7)}  -  ${data.date.slice(0, 10)}`), MARGIN, 23);
  doc.text(clean(data.repoUrl), MARGIN, 28.5);
  y = 44;

  paragraph(inline(data.title), { size: 14, style: "bold", color: [15, 23, 42] });
  y += 1;
  const statsText = data.stats ? `   ${data.stats.files_changed} files, +${data.stats.additions} / -${data.stats.deletions}` : "";
  paragraph(`By ${inline(data.author)}${statsText}`, { size: 9.5, color: [100, 116, 139] });
  y += 3;

  // Impact pill
  const color = IMPACT_COLORS[data.impactLevel] || [71, 85, 105];
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  const pillW = doc.getTextWidth(data.impactLevel) + 8;
  doc.setFillColor(...color);
  doc.roundedRect(MARGIN, y - 4, pillW, 6.5, 1.5, 1.5, "F");
  doc.setTextColor(255, 255, 255);
  doc.text(data.impactLevel, MARGIN + 4, y + 0.6);
  if (data.domains.length) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(100, 116, 139);
    doc.text(clean(data.domains.join("  -  ")), MARGIN + pillW + 4, y + 0.6);
  }
  y += 9;

  // Summary box
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10.5);
  const summaryLines = doc.splitTextToSize(inline(data.executiveSummary), CONTENT_W - 10) as string[];
  const boxH = summaryLines.length * 5 + 10;
  ensure(boxH);
  doc.setFillColor(241, 245, 249);
  doc.roundedRect(MARGIN, y, CONTENT_W, boxH, 2, 2, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text("SUMMARY", MARGIN + 5, y + 6);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10.5);
  doc.setTextColor(30, 41, 59);
  summaryLines.forEach((l, i) => doc.text(l, MARGIN + 5, y + 12 + i * 5));
  y += boxH + 6;

  if (data.breakingChanges.length) {
    paragraph("Breaking changes", { size: 11, style: "bold", color: [185, 28, 28] });
    y += 1;
    data.breakingChanges.forEach((b) => paragraph(`-  ${inline(b)}`, { indent: 2, color: [127, 29, 29] }));
    y += 4;
  }

  // ---- Markdown report body -------------------------------------------------
  let inCode = false;
  for (const raw of data.detailedReport.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^```/.test(line)) {
      inCode = !inCode;
      y += 1;
      continue;
    }
    if (inCode) {
      paragraph(clean(line) || " ", { font: "courier", size: 8.5, color: [30, 41, 59], indent: 3, lineH: 4 });
      continue;
    }
    if (!line.trim()) {
      y += 2.2;
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      y += level <= 2 ? 4 : 2;
      ensure(12);
      paragraph(inline(h[2]), { size: level === 1 ? 15 : level === 2 ? 13 : 11.5, style: "bold", color: [15, 23, 42] });
      if (level <= 2) {
        doc.setDrawColor(226, 232, 240);
        doc.line(MARGIN, y - 1.5, PAGE_W - MARGIN, y - 1.5);
        y += 1.5;
      }
      continue;
    }
    const bullet = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      const depth = Math.min(Math.floor(bullet[1].length / 2), 3);
      const marker = /\d/.test(bullet[2]) ? bullet[2] : "-";
      paragraph(`${marker}  ${inline(bullet[3])}`, { indent: 3 + depth * 5 });
      continue;
    }
    if (/^\s*[-*_]{3,}\s*$/.test(line)) {
      ensure(4);
      doc.setDrawColor(226, 232, 240);
      doc.line(MARGIN, y, PAGE_W - MARGIN, y);
      y += 4;
      continue;
    }
    paragraph(inline(line.replace(/^>\s?/, "")));
  }

  // ---- Related history (RAG sources) --------------------------------------------
  if (data.related.length) {
    y += 6;
    ensure(16);
    paragraph("Related commits in this repository", { size: 13, style: "bold", color: [15, 23, 42] });
    doc.setDrawColor(226, 232, 240);
    doc.line(MARGIN, y - 1.5, PAGE_W - MARGIN, y - 1.5);
    y += 2;
    for (const r of data.related) {
      paragraph(`${r.shortSha}  ${inline(r.title)}`, { style: "bold", size: 10 });
      paragraph(`${inline(r.author)}${r.date ? `, ${r.date.slice(0, 10)}` : ""}${r.reason ? `  (${r.reason})` : ""}`, { size: 9, color: [100, 116, 139] });
      y += 1.5;
    }
  }

  // ---- Footer on every page ------------------------------------------------------
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "italic");
    doc.setFontSize(8);
    doc.setTextColor(148, 163, 184);
    doc.text(`Generated by GitSimple AI  -  ${new Date().toISOString().slice(0, 10)}`, MARGIN, 290);
    doc.text(`Page ${i} of ${pages}`, PAGE_W - MARGIN, 290, { align: "right" });
  }

  return doc.output("arraybuffer");
}
