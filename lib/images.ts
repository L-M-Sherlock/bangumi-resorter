export type BangumiCoverVariant = "l" | "c" | "m";

const COVER_VARIANT_PATH = /\/pic\/cover\/[lcmgs]\//;

export function bangumiCoverVariant(source: string, variant: BangumiCoverVariant) {
  try {
    const url = new URL(source);
    if (url.hostname !== "lain.bgm.tv" || !COVER_VARIANT_PATH.test(url.pathname)) return source;
    url.pathname = url.pathname.replace(COVER_VARIANT_PATH, `/pic/cover/${variant}/`);
    return url.toString();
  } catch {
    return source;
  }
}
