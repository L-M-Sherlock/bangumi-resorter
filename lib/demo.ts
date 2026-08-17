import { CollectionItem, CollectionType, SubjectType } from "./types";

const names = [
  ["蟲師", "虫师", 9, 2005], ["COWBOY BEBOP", "星际牛仔", 9, 1998],
  ["少女革命ウテナ", "少女革命", 10, 1997], ["千年女優", "千年女优", 9, 2001],
  ["四畳半神話大系", "四叠半神话大系", 9, 2010], ["攻殻機動隊 STAND ALONE COMPLEX", "攻壳机动队 S.A.C.", 9, 2002],
  ["新世紀エヴァンゲリオン", "新世纪福音战士", 10, 1995], ["昭和元禄落語心中", "昭和元禄落语心中", 8, 2016],
  ["ピンポン THE ANIMATION", "乒乓", 9, 2014], ["灰羽連盟", "灰羽联盟", 8, 2002],
  ["MONSTER", "怪物", 9, 2004], ["映像研には手を出すな！", "别对映像研出手！", 8, 2020],
  ["カウボーイビバップ 天国の扉", "星际牛仔 天国之扉", 8, 2001], ["PERFECT BLUE", "未麻的部屋", 9, 1998],
  ["時をかける少女", "穿越时空的少女", 8, 2006], ["電脳コイル", "电脑线圈", 8, 2007],
] as const;

export function createDemoItems(snapshotId: string): CollectionItem[] {
  return names.map(([name, nameCn, rate, year], index) => ({
    snapshotId,
    subjectId: 900000 + index,
    subjectType: 2 as SubjectType,
    collectionType: 2 as CollectionType,
    rate,
    name,
    nameCn,
    date: `${year}-01-01`,
    private: false,
    tags: index % 3 === 0 ? ["demo", "经典"] : ["demo"],
  }));
}
