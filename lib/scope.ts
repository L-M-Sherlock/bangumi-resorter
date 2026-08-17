import type { CollectionItem, CollectionType, SessionTagFilter, SortingSession, SubjectType } from "./types";

export function normalizeCollectionTag(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

export function collectionTagFilter(tags: string[]): SessionTagFilter | undefined {
  const unique = new Map<string, string>();
  for (const raw of tags) {
    const label = raw.normalize("NFKC").trim();
    const key = normalizeCollectionTag(label);
    if (key && !unique.has(key)) unique.set(key, label);
  }
  const normalized = [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, label]) => label);
  return normalized.length > 0
    ? { source: "collection", match: "all", tags: normalized }
    : undefined;
}

export function itemMatchesTagFilter(item: Pick<CollectionItem, "tags">, filter?: SessionTagFilter) {
  if (!filter || filter.tags.length === 0) return true;
  const available = new Set((item.tags ?? []).map(normalizeCollectionTag).filter(Boolean));
  return filter.tags.every((tag) => available.has(normalizeCollectionTag(tag)));
}

export function filterScopeItems(
  scope: Pick<SortingSession, "subjectType" | "collectionTypes" | "tagFilter">,
  items: CollectionItem[],
) {
  return items.filter((item) => item.subjectType === scope.subjectType
    && scope.collectionTypes.includes(item.collectionType)
    && itemMatchesTagFilter(item, scope.tagFilter));
}

export function filterBaseItems(
  subjectType: SubjectType,
  collectionTypes: CollectionType[],
  items: CollectionItem[],
) {
  return items.filter((item) => item.subjectType === subjectType && collectionTypes.includes(item.collectionType));
}

export function sameTagFilter(left?: SessionTagFilter, right?: SessionTagFilter) {
  const leftTags = collectionTagFilter(left?.tags ?? [])?.tags.map(normalizeCollectionTag) ?? [];
  const rightTags = collectionTagFilter(right?.tags ?? [])?.tags.map(normalizeCollectionTag) ?? [];
  return leftTags.length === rightTags.length && leftTags.every((tag, index) => tag === rightTags[index]);
}

export interface CollectionTagOption {
  key: string;
  label: string;
  count: number;
}

export function collectionTagOptions(items: CollectionItem[]): CollectionTagOption[] {
  const grouped = new Map<string, { label: string; subjects: Set<number> }>();
  for (const item of items) {
    for (const raw of item.tags ?? []) {
      const label = raw.normalize("NFKC").trim();
      const key = normalizeCollectionTag(label);
      if (!key) continue;
      const current = grouped.get(key) ?? { label, subjects: new Set<number>() };
      current.subjects.add(item.subjectId);
      grouped.set(key, current);
    }
  }
  return [...grouped.entries()]
    .map(([key, value]) => ({ key, label: value.label, count: value.subjects.size }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

export function tagFilterSummary(filter?: SessionTagFilter) {
  return filter?.tags.length ? filter.tags.join(" + ") : "全部标签";
}
