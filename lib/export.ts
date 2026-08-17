import { ExportV1, RankedItem } from "./types";

function csvCell(value: string | number | boolean | undefined) {
  const text = value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function resultsCsv(items: RankedItem[]) {
  const headers = ["subject_type", "subject_id", "name", "name_cn", "collection_type", "original_rate", "new_rate", "rank", "ability", "uncertainty", "comparison_count", "subject_url"];
  const rows = items.map((item) => [
    item.subjectType, item.subjectId, item.name, item.nameCn, item.collectionType,
    item.rate, item.newRate, item.rank, item.ability.toFixed(6), item.uncertainty.toFixed(6),
    item.comparisonCount, `https://bgm.tv/subject/${item.subjectId}`,
  ]);
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}

export function downloadText(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function downloadJson(filename: string, payload: ExportV1) {
  downloadText(filename, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
}

export async function readBackup(file: File): Promise<ExportV1> {
  if (file.size > 20 * 1024 * 1024) throw new Error("备份文件不能超过 20 MB。");
  let parsed: unknown;
  try { parsed = JSON.parse(await file.text()); }
  catch { throw new Error("这不是有效的 JSON 备份文件。"); }
  if (!parsed || typeof parsed !== "object" || (parsed as { schemaVersion?: unknown }).schemaVersion !== 1) {
    throw new Error("不支持这个备份文件版本。");
  }
  return parsed as ExportV1;
}

export async function storageStatus() {
  const estimate = await navigator.storage?.estimate?.();
  const persisted = await navigator.storage?.persisted?.();
  return { usage: estimate?.usage ?? 0, quota: estimate?.quota ?? 0, persisted: Boolean(persisted) };
}

export async function requestPersistentStorage() {
  return Boolean(await navigator.storage?.persist?.());
}
