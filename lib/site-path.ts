export const LOCAL_PROJECT_MARKER_KEY = "bangumi-resorter:has-local-project";
export const PRINCIPLES_RETURN_PENDING_KEY = "bangumi-resorter:principles-return-pending";
export const PRINCIPLES_RETURN_TARGET_KEY = "bangumi-resorter:principles-return-target";

export function sitePath(path: string) {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${basePath}${normalized}`;
}
