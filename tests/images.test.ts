import { describe, expect, it } from "vitest";
import { bangumiCoverVariant } from "../lib/images";

describe("Bangumi cover variants", () => {
  it("selects a smaller official cover while preserving the rest of the URL", () => {
    expect(bangumiCoverVariant(
      "https://lain.bgm.tv/pic/cover/l/39/ad/253046_IjUfm.jpg?rev=1",
      "c",
    )).toBe("https://lain.bgm.tv/pic/cover/c/39/ad/253046_IjUfm.jpg?rev=1");
  });

  it("supports official cover URLs that already use another size", () => {
    expect(bangumiCoverVariant(
      "https://lain.bgm.tv/r/400/pic/cover/m/f3/2d/249637_2r3gw.jpg",
      "l",
    )).toBe("https://lain.bgm.tv/r/400/pic/cover/l/f3/2d/249637_2r3gw.jpg");
  });

  it("leaves external and malformed image URLs unchanged", () => {
    expect(bangumiCoverVariant("https://example.com/pic/cover/l/image.jpg", "m"))
      .toBe("https://example.com/pic/cover/l/image.jpg");
    expect(bangumiCoverVariant("not a url", "m")).toBe("not a url");
  });
});
