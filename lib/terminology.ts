export interface TermDefinition {
  label: string;
  summary: string;
  sectionId: string;
}

export const TERM_DEFINITIONS = {
  "rating-clumping": {
    label: "评分聚集",
    summary: "大量作品挤在少数几个分数上，使名义上的十档评分退化成只有两三档的实际信息。",
    sectionId: "rating-problem",
  },
  "pairwise-comparison": {
    label: "两两比较",
    summary: "每次只判断两部作品谁更偏爱。它比一次为数百部作品指定绝对名次更符合人的判断能力。",
    sectionId: "pairwise-comparisons",
  },
  "noisy-sorting": {
    label: "噪声排序",
    summary: "允许人的判断偶尔矛盾或改变，再用统计模型从不完美的比较中恢复整体顺序。",
    sectionId: "pairwise-comparisons",
  },
  "bradley-terry": {
    label: "Bradley–Terry 模型",
    summary: "一种成对比较模型：两部作品的潜在偏好差越大，前者在比较中胜出的概率越高。",
    sectionId: "preference-model",
  },
  "logistic-function": {
    label: "logistic 函数",
    summary: "把任意大小的偏好差压缩到 0–1 概率区间；差为零时，双方胜率都是 50%。",
    sectionId: "preference-model",
  },
  "latent-preference": {
    label: "连续潜在分数",
    summary: "模型内部用于排序的连续偏好坐标。它只有相对大小有意义，不等同于作品的客观质量。",
    sectionId: "preference-model",
  },
  prior: {
    label: "先验",
    summary: "在读取新比较之前对排序的初始约束。本项目可让 Bangumi 原评分提供强、中等或零顺序先验。",
    sectionId: "inference-modes",
  },
  posterior: {
    label: "后验",
    summary: "把先验与已有比较合并后得到的不确定性分布；它描述模型在当前证据下仍认为哪些排序可能成立。",
    sectionId: "preference-model",
  },
  "posterior-interval": {
    label: "后验区间",
    summary: "由后验样本给出的可能范围。80% 区间不是保证，而是模型内部约八成样本落入的区间。",
    sectionId: "stopping-rule",
  },
  "posterior-standard-deviation": {
    label: "后验标准差",
    summary: "潜在分数仍有多不确定的模型内尺度；数值越大，通常表示该作品的位置还缺少证据。",
    sectionId: "preference-model",
  },
  "map-estimate": {
    label: "MAP 估计",
    summary: "最大后验估计：寻找同时最符合比较记录和先验约束的一组潜在分数。",
    sectionId: "preference-model",
  },
  "l2-regularization": {
    label: "L2 正则",
    summary: "惩罚过大的潜在分数，避免数据稀疏时模型为了迁就少数比较而产生极端估计。",
    sectionId: "preference-model",
  },
  hessian: {
    label: "Hessian",
    summary: "目标函数在最优点附近的曲率矩阵；本项目用它近似各作品潜在分数之间的不确定性关系。",
    sectionId: "preference-model",
  },
  "laplace-approximation": {
    label: "Laplace 近似",
    summary: "在 MAP 解附近用多元高斯分布近似后验，从而以适合交互界面的速度生成不确定性样本。",
    sectionId: "preference-model",
  },
  "information-gain": {
    label: "期望信息增益",
    summary: "衡量询问某一对作品后，答案预计能消除多少整体排序不确定性。",
    sectionId: "question-selection",
  },
  "adaptive-comparison": {
    label: "自适应比较",
    summary: "根据当前模型实时选择下一题，而不是预先固定全部比较；每个答案都可能改变后续问题。",
    sectionId: "question-selection",
  },
  "coverage-exploration": {
    label: "覆盖探索",
    summary: "定期优先询问比较不足或尚不稳定的作品，防止纯贪心策略困在同一小组。",
    sectionId: "question-selection",
  },
  "calibration-repeat": {
    label: "校准复问",
    summary: "隔一段时间把旧问题交换左右后再问一次，用来诊断判断波动；它不改变停止门槛。",
    sectionId: "question-selection",
  },
  "score-bucket": {
    label: "K 档分桶",
    summary: "按最终排序和目标分布把连续潜在分数切成 K 个离散评分档；K 可在 3–20 之间选择。",
    sectionId: "score-buckets",
  },
  "score-distribution": {
    label: "评分分布",
    summary: "规定每个输出评分档应容纳多大比例的作品；它改变分界位置，不改变潜在排序本身。",
    sectionId: "score-buckets",
  },
  "high-tail": {
    label: "高分辨率尾部分布",
    summary: "给最高分区域更窄的档位，以便在真正偏爱的作品之间保留更多区分度。",
    sectionId: "score-buckets",
  },
  "reverse-j": {
    label: "反 J 分布",
    summary: "把大多数作品集中到低分档，只给极少数顶尖作品高分；它比高分辨率尾部分布更激进。",
    sectionId: "score-buckets",
  },
  "bucket-stability": {
    label: "精确分桶稳定度",
    summary: "后验样本中，某部作品仍落在当前这一档的比例；它是逐条诊断，不直接决定总体停止。",
    sectionId: "stopping-rule",
  },
  "adjacent-tolerance": {
    label: "相邻容差覆盖",
    summary: "后验样本中，作品至多偏移一档的预期比例；它允许无关紧要的相邻档摆动。",
    sectionId: "stopping-rule",
  },
  "cross-two-buckets": {
    label: "跨两档作品",
    summary: "相对当前结果偏移两档或更多的作品，被停止条件视为实质性分桶错误。",
    sectionId: "stopping-rule",
  },
  "maximum-displacement": {
    label: "最坏偏移",
    summary: "一次后验样本里偏移最远的那部作品移动了几档；它用于观察尾部风险，不单独阻止停止。",
    sectionId: "stopping-rule",
  },
  "monte-carlo": {
    label: "Monte Carlo 模拟",
    summary: "从近似后验反复抽样，用样本频率估计整个评分结果满足条件的概率。",
    sectionId: "stopping-rule",
  },
  "wilson-bound": {
    label: "Wilson 下界",
    summary: "考虑有限模拟次数误差后的保守概率下界；样本不足时，它会低于观察到的成功比例。",
    sectionId: "stopping-rule",
  },
  "mc-lower-bound": {
    label: "MC 下界",
    summary: "Monte Carlo 成功比例的 Wilson 置信下界。本项目要求它达到 90%，而不只看点估计。",
    sectionId: "stopping-rule",
  },
  "dynamic-forecast": {
    label: "动态剩余预测",
    summary: "用后验收缩路径估计还需多少有效比较；它会随新证据重算，是区间而不是承诺题量。",
    sectionId: "remaining-forecast",
  },
  "inference-mode": {
    label: "推断模式",
    summary: "快速、标准和精细模式分别要求强先验、强加中等先验、以及全部三种先验检查通过。",
    sectionId: "inference-modes",
  },
  snapshot: {
    label: "收藏快照",
    summary: "一次同步得到的不可变收藏版本；旧会话继续绑定旧快照，不会被后来新增或改分静默改写。",
    sectionId: "collection-drift",
  },
  "history-reuse": {
    label: "历史判断导入",
    summary: "在创建会话时把仍然适用于当前作品范围的旧比较复制为本地证据；导入完成后与来源会话解耦。",
    sectionId: "collection-drift",
  },
} as const satisfies Record<string, TermDefinition>;

export type TermKey = keyof typeof TERM_DEFINITIONS;
