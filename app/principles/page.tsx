import type { Metadata } from "next";
import { AppReturnLink } from "@/app/AppReturnLink";
import { Term } from "@/app/Term";
import { ThemeToggle } from "@/app/ThemeToggle";

export const metadata: Metadata = {
  title: "为什么这样排序？· Bangumi Resorter",
  description: "从评分聚集、两两比较到 Davidson 后验与动态停止：Bangumi Resorter 的完整方法、假设与限制。",
};

const sections = [
  ["rating-problem", "评分为什么会失真"],
  ["pairwise-comparisons", "为什么改问两两比较"],
  ["preference-model", "从比较推断连续排序"],
  ["inference-modes", "原评分先验与三种模式"],
  ["question-selection", "下一题为什么是这一对"],
  ["score-buckets", "从连续排序回到 K 档"],
  ["stopping-rule", "何时算作足够稳定"],
  ["remaining-forecast", "剩余次数如何预测"],
  ["collection-drift", "收藏变化与长期偏移"],
  ["differences", "与 Gwern 原版的差异"],
  ["limitations", "限制与诚实声明"],
] as const;

const clumpedRatings = [1, 1, 2, 3, 7, 16, 44, 88, 63, 22];
const tailRatings = [3, 5, 8, 14, 20, 20, 12, 8, 6, 4];
const stoppingModes = [
  { label: "快速", coverage: 80 },
  { label: "标准", coverage: 90 },
  { label: "精细", coverage: 95 },
] as const;

function MiniHistogram({ values, label }: { values: number[]; label: string }) {
  const max = Math.max(...values);
  return <div className="principle-mini-histogram" aria-label={label}>
    {values.map((value, index) => <span key={index} title={`${index + 1} 档：${value}`}><i style={{ height: `${value / max * 100}%` }} /><b>{index + 1}</b></span>)}
  </div>;
}

function SectionHeading({ id, children }: { id: string; children: string }) {
  return <h2 id={id}><a href={`#${id}`} aria-hidden="true" tabIndex={-1}>§</a>{children}</h2>;
}

export default function PrinciplesPage() {
  return <main className="principles-page">
    <header className="principles-topbar">
      <AppReturnLink className="principles-brand"><span>R</span><strong>Resorter</strong><small>for Bangumi</small></AppReturnLink>
      <div className="principles-actions"><AppReturnLink className="principles-back">返回排序工具 <span aria-hidden="true">→</span></AppReturnLink><ThemeToggle /></div>
    </header>

    <div className="principles-layout">
      <aside className="principles-toc">
        <span>本文目录</span>
        <nav aria-label="原理页面目录">{sections.map(([id, label]) => <a href={`#${id}`} key={id}>{label}</a>)}</nav>
      </aside>

      <article className="principles-article">
        <header className="principles-hero">
          <span className="eyebrow">方法、证据与限制</span>
          <h1>为什么比较比打分更诚实？</h1>
          <p className="principles-deck">Bangumi Resorter 不试图发现作品的“真实分数”。它要解决一个更小、也更实际的问题：当旧评分已经挤成一团时，怎样用尽量少而且允许出错的判断，恢复你此刻愿意承认的偏好顺序？</p>
          <dl className="principles-meta"><div><dt>方法来源</dt><dd><a href="https://gwern.net/resorter" target="_blank" rel="noreferrer">Gwern · Resorting Media Ratings ↗</a></dd></div><div><dt>本项目实现</dt><dd>加权 Davidson · Laplace 后验 · 主动选题</dd></div><div><dt>阅读方式</dt><dd>主线讲直觉，技术框可以跳过</dd></div></dl>
        </header>

        <details className="principles-toc-mobile"><summary>本文目录</summary><nav aria-label="移动端原理页面目录">{sections.map(([id, label]) => <a href={`#${id}`} key={id}>{label}</a>)}</nav></details>

        <section>
          <SectionHeading id="rating-problem">评分为什么会失真</SectionHeading>
          <p>十档评分看起来能表达很多差异，长期使用后却往往只剩下“还行、喜欢、非常喜欢”。这就是<Term term="rating-clumping">评分聚集</Term>：并不是人的品味忽然变简单了，而是每次打分都在不同语境下完成。今天的 8 分与五年前的 8 分未必使用同一把尺；作品又经过主动筛选，我们本来就更常接触可能喜欢的东西。</p>
          <p>因此，原评分依然有价值，却不宜被当成精密测量。它更像一份粗糙但昂贵的草稿：丢掉可惜，照抄也不够。Gwern 的出发点正是把拥挤的评分重新分配，让有限的数字优先表达真正有用的差异。</p>
          <figure className="principle-figure distribution-argument">
            <div><strong>常见的旧评分聚集</strong><MiniHistogram values={clumpedRatings} label="示意图：大量旧评分聚集在七至九分" /></div>
            <div><strong>高分区域被切得更细</strong><MiniHistogram values={tailRatings} label="示意图：高分辨率尾部分布的目标权重" /></div>
            <figcaption>示意图，不代表你的收藏。目标不是让曲线“好看”，而是让评分在你关心的区域更有区分力。</figcaption>
          </figure>
        </section>

        <section>
          <SectionHeading id="pairwise-comparisons">为什么改问两两比较</SectionHeading>
          <p>要求一个人直接说出某部作品是第 137 名很荒谬；问“这两部更喜欢哪一部”却通常可答。<Term term="pairwise-comparison">两两比较</Term>把一个巨大的绝对排序任务拆成许多局部判断，并让模型利用弱传递性：如果 A 通常胜过 B、B 通常胜过 C，那么 A 大概也在 C 前面。</p>
          <p>关键在“大概”。审美判断受记忆、心情、题目顺序与疲劳影响，昨天的你甚至可能否定今天的你。普通排序算法假设比较器永不犯错，这里采用<Term term="noisy-sorting">噪声排序</Term>：保存矛盾，不强行修补，再让统计模型判断哪些顺序有充分证据。</p>
          <blockquote>比较不是把主观判断伪装成客观事实；它只是把一次难以校准的绝对评分，换成许多更容易回答的局部问题。</blockquote>
        </section>

        <section>
          <SectionHeading id="preference-model">从比较推断连续排序</SectionHeading>
          <p>系统为每部作品设置一个不可直接观察的<Term term="latent-preference">连续潜在分数</Term> θ，并使用 Bradley–Terry 的 <Term term="bradley-terry">Davidson 三结果扩展</Term>。两部作品的分数差决定左胜与右胜的相对概率，另一个共享参数描述“差不多喜欢”的强度；这个平局参数会随当前判断一起估计，而不是把平局拆成半次胜利。</p>
          <aside className="technical-box">
            <span>技术框 · 比较似然</span>
            <code>P(i ≻ j) : P(i ≈ j) : P(j ≻ i) = exp(d/2) : ν : exp(−d/2)</code>
            <p>d = θᵢ − θⱼ，ν 是带弱正则的共享平局强度。模型用 <Term term="map-estimate">MAP 估计</Term>寻找最符合比较与<Term term="prior">先验</Term>的一组 θ 和 ν，并以 <Term term="l2-regularization">L2 正则</Term>抑制稀疏数据造成的极端值。同一概率公式同时用于拟合、选题和未来回答模拟。</p>
          </aside>
          <p>一个最佳排序仍然不够：我们还要知道它有多不确定。系统读取最优点附近的 <Term term="hessian">Hessian</Term>，用 <Term term="laplace-approximation">Laplace 近似</Term>构造快速的高斯<Term term="posterior">后验</Term>。这不是精确贝叶斯推断，但能在交互所需的时间内反复抽样，检查其他仍然合理的排序会把作品放到哪里。</p>
          <div className="model-flow" role="img" aria-label="数据流：原评分和比较记录进入偏好模型，产生后验排序，再映射到评分档">
            <span>原评分<br /><small>粗先验</small></span><b>＋</b><span>比较记录<br /><small>新证据</small></span><b>→</b><span>后验排序<br /><small>含不确定性</small></span><b>→</b><span>K 档评分<br /><small>输出摘要</small></span>
          </div>
        </section>

        <section>
          <SectionHeading id="inference-modes">先验强度与停止严格度</SectionHeading>
          <p><Term term="prior">原评分先验</Term>回答的是一个取舍：我们愿意多大程度相信旧评分仍代表当前偏好？强先验让 Bangumi 原评分提供明显的初始顺序，适合旧评分大体可靠时加速冷启动；默认的弱先验不采用原评分顺序，只保留很弱的零均值正则，让两两判断主导结果。弱先验中能力相等时只按作品 ID 确定显示顺序，不读取原评分。两者使用完全相同的候选范围与探索节奏。</p>
          <p><Term term="inference-mode">停止严格度</Term>是另一个独立选择。快速、标准、精细分别要求至少 80%、90% 与 95% 的作品在后验样本中最多偏移一档；三个覆盖事件的 90% MC 下界都必须达到 90%。因为覆盖事件彼此嵌套，且三档共享后验、下一题策略和每一条未来模拟路径，所以快速达标时间不晚于标准，标准不晚于精细；切换停止档位无需重新拟合模型。</p>
          <div className="principles-table-wrap"><table className="principles-mode-table"><thead><tr><th>维度</th><th>选项</th><th>改变什么</th><th>不改变什么</th></tr></thead><tbody><tr><th rowSpan={2}>先验强度</th><td>强先验</td><td>原评分中心与正则强度</td><td>选题规则、停止阈值</td></tr><tr><td>弱先验（默认）</td><td>弱零均值正则</td><td>选题规则、停止阈值</td></tr><tr><th rowSpan={3}>停止严格度</th><td>快速：80% 覆盖</td><td>允许 20% 跨两档</td><td>90% MC 门槛、后验、下一题、未来路径</td></tr><tr><td>标准：90% 覆盖</td><td>允许 10% 跨两档</td><td>90% MC 门槛、后验、下一题、未来路径</td></tr><tr><td>精细：95% 覆盖</td><td>允许 5% 跨两档</td><td>90% MC 门槛、后验、下一题、未来路径</td></tr></tbody></table></div>
        </section>

        <section>
          <SectionHeading id="question-selection">下一题为什么是这一对</SectionHeading>
          <p>最不确定的作品不一定构成最有用的问题。若只追逐最大误差，算法可能反复困在同一小组。普通问题因此按<Term term="information-gain">期望信息增益</Term>排序：用拟合得到的三结果概率预估用户回答左、右或平局之后，整个潜在偏好状态能减少多少不确定性，同时惩罚重复配对。</p>
          <p>纯贪心仍会忽略边缘作品，所以系统混入两类有意的“低效率”：<Term term="coverage-exploration">覆盖探索</Term>把比较带到证据稀少或尚未稳定的区域；<Term term="calibration-repeat">校准复问</Term>交换左右重问旧题，同时提供偏好证据和一致性诊断。所有非跳过答案都会入模，但同一无序作品对构成相关簇：折减后的权重总量 m 按工作相关系数 ρ = 0.5 折算为 m/[1+max(0,m−1)ρ]；整数 m≥1 时就是常见的 m/[1+(m−1)ρ]。所以校准复问和导入的同对历史都不会被当成条件独立的新样本，低于一条完整判断的陈旧权重也不会被反向放大。</p>
        </section>

        <section>
          <SectionHeading id="score-buckets">从连续排序回到 K 档</SectionHeading>
          <p>潜在分数适合计算，却不适合直接解释。最终输出通过 <Term term="score-bucket">K 档分桶</Term>把排序切成 3–20 档；每一档容纳多少作品由<Term term="score-distribution">评分分布</Term>决定。改变 K 或分布不会删除比较，也不改变“谁在谁前面”，但会移动档位边界，因此必须重新计算稳定度、下一题和剩余预测。</p>
          <p>均匀分布让每档人数接近；保持原分布保留收藏的整体评分轮廓；默认的<Term term="high-tail">高分辨率尾部分布</Term>在高分区域使用较窄档位；<Term term="reverse-j">反 J 分布</Term>更激进，把大多数作品压进低档，只为极少数顶尖作品保留高分。没有一种分布天然“真实”，只有是否适合你的用途。</p>
        </section>

        <section>
          <SectionHeading id="stopping-rule">何时算作足够稳定</SectionHeading>
          <p>要求每部作品都固定在唯一一档，会让最靠近边界的作品永远拖住整个项目。本站把实质错误定义为<Term term="cross-two-buckets">跨两档</Term>：相邻档摆动可以接受，移动两档或更多才计入损失。</p>
          <p>在每一次 <Term term="monte-carlo">Monte Carlo 模拟</Term>的后验排序里，快速、标准和精细分别要求至少 80%、90% 或 95% 的作品相对当前结果最多偏移一档。满足相应覆盖事件的概率之 <Term term="wilson-bound">Wilson 下界</Term>还必须统一达到 90%。使用 <Term term="mc-lower-bound">MC 下界</Term>而非观察比例，是为了避免 64 或 128 次模拟中的偶然好运被误报成稳定。</p>
          <figure className="principle-figure stopping-figure">
            <div className="stopping-levels">{stoppingModes.map((mode) => <div className="stopping-level" key={mode.label}><b>{mode.label} · {mode.coverage}% 覆盖</b><div className="stopping-grid" role="img" aria-label={`一百个作品中至少 ${mode.coverage} 个最多偏移一档`}>{Array.from({ length: 100 }, (_, index) => <i className={index < mode.coverage ? "within" : "outside"} key={index} />)}</div></div>)}</div>
            <figcaption>覆盖目标越高，允许<Term term="cross-two-buckets">跨两档</Term>的作品越少。三个事件都要求保守概率下界达到 <b>90%</b>，并同时满足相关性修正后的有效权重、唯一作品对数和作品比较覆盖。</figcaption>
          </figure>
          <p><Term term="adjacent-tolerance">后验期望相邻容差覆盖</Term>是平均诊断；<Term term="bucket-stability">精确分桶稳定度</Term>描述单部作品；<Term term="maximum-displacement">最坏偏移</Term>观察最极端的尾部。它们帮助解释风险，但都不能替代上述总体停止事件。</p>
        </section>

        <section>
          <SectionHeading id="remaining-forecast">剩余次数如何预测</SectionHeading>
          <p><Term term="dynamic-forecast">动态剩余预测</Term>不是把当前进度除以平均速度。系统从当前后验选取最多 64 个粒子，并把有限粒子的经验均值精确移到当前 MAP；这个平移保留协方差，却消除模拟从另一套排序中心出发的漂移。每条路径使用实际策略选择普通题、覆盖探索或到期复问，以拟合得到的 Davidson 三结果概率模拟答案，再用同一似然做重要性加权和协方差传播。系统每 16 次模拟回答检查一次，并同时记录 80%、90% 与 95% 覆盖事件及证据门槛首次达标的时刻，最后分别报告 10%、50% 与 90% 分位数。这种逐路径共用保证三档预测理论上单调。</p>
          <p>所以范围可能变宽、变窄甚至暂时上升：新答案可能暴露此前被先验掩盖的不确定性。预测窗口内没有成功路径也不证明目标不可达。它只说明，在当前模型和有限前瞻下，还没有足够证据给出有限上界；大型收藏的前瞻窗口会设上限以保持界面响应。这里显示的是固定算法假设下的情景模拟分位数，尚未通过重复仿真验证频率覆盖率，不能当作已校准的预测区间。</p>
        </section>

        <section>
          <SectionHeading id="collection-drift">收藏变化与长期偏移</SectionHeading>
          <p>偏好并非静止数据库。新作品会加入，旧评分会修改，人的判断标准也会随时间改变。每次同步因此保存独立的<Term term="snapshot">收藏快照</Term>，而不是把旧会话原地改写。</p>
          <p>新建、升级或按标签派生会话时，系统可以复制目标范围内仍然有效的比较；已有会话也可以在明确预览后追加导入。每条副本都记录直接来源、来源时间和原始根判断，并属于目标会话自身，来源之后新增、删除或被整体删除都不会回流成第二份证据；重复导入按根判断幂等。导入时已经过去的来源年龄按 365 天半衰期折减，再进入同对相关簇。<Term term="history-reuse">历史判断导入</Term>可以节省工作，但跨快照导入越多，也越可能把旧偏好当成今天的偏好，因此新会话默认从零开始。</p>
        </section>

        <section>
          <SectionHeading id="differences">与 Gwern 原版的差异</SectionHeading>
          <p>本项目继承的是问题设定，不是原脚本的逐行翻译。Gwern 的文章还明确指出其实现缺少原则化不确定性与最优选题；本站把这些“未来改进”变成了交互流程的一部分，同时承担近似误差和更复杂解释的代价。</p>
          <div className="principles-table-wrap"><table><thead><tr><th>问题</th><th>Gwern 原版</th><th>本项目</th></tr></thead><tbody>
            <tr><th>输入</th><td>CSV 名称与可选评分</td><td>Bangumi 收藏、标签与不可变快照</td></tr>
            <tr><th>旧评分</th><td>转成相邻伪比较</td><td>独立选择强先验或弱零均值先验</td></tr>
            <tr><th>估计</th><td>BradleyTerry2 频率学派拟合</td><td>加权 Davidson MAP 与 Laplace 后验近似</td></tr>
            <tr><th>选题</th><td>最大标准误与随机探索交替</td><td>期望信息增益、覆盖探索、校准复问</td></tr>
            <tr><th>停止</th><td>用户退出或预设问题数</td><td>总体相邻容差下界与有效证据覆盖门槛</td></tr>
            <tr><th>输出</th><td>命令行分位数映射</td><td>3–20 档、多种分布、解释诊断与 CSV</td></tr>
          </tbody></table></div>
        </section>

        <section>
          <SectionHeading id="limitations">限制与诚实声明</SectionHeading>
          <ul className="principles-limitations">
            <li>结果描述的是这个账号、这批作品、这些时刻下的主观偏好，不是作品的客观质量。</li>
            <li>Davidson 模型仍假设偏好大致可由一维连续顺序和一个共享平局强度表达；强烈的类型依赖或循环偏好会被压缩。</li>
            <li>Laplace 后验、工作相关系数、时间半衰期和未来逐题更新都是近似。页面上的概率与题量范围只在模型内部成立，剩余题量尚无覆盖率校准保证。</li>
            <li>“已稳定”不表示你以后不会改主意，只表示现有证据下，大多数作品不太可能发生跨两档变化。</li>
            <li>高分辨率分布提高高分区分力的代价，是压缩其他区域；选择分布本身就是价值判断。</li>
            <li>校准复问的一致率只报告判断波动；复问答案会明确地按同对相关重复证据折权入模，不会秘密改写原答案或另设预测温度。</li>
            <li>优化器未收敛时仍可展示临时候选排序与诊断，但系统会 fail closed：不报告已稳定，也不给有限剩余题量。</li>
            <li>写回评分是显式的可选操作：仅接受 10 档结果，先比较线上评分与会话快照，跳过冲突后才会逐条修改 Bangumi 收藏。</li>
          </ul>
        </section>

        <footer className="principles-references">
          <h2 id="references">参考与进一步阅读</h2>
          <ol>
            <li><a href="https://gwern.net/resorter" target="_blank" rel="noreferrer">Gwern, “Resorting Media Ratings”</a>：问题背景、分布选择、噪声排序与原始实现。</li>
            <li><a href="https://doi.org/10.2307/2334029" target="_blank" rel="noreferrer">Bradley &amp; Terry (1952)</a>：成对比较模型。</li>
            <li><a href="https://arxiv.org/abs/1112.5745" target="_blank" rel="noreferrer">Houlsby et al. (2011)</a>：贝叶斯主动学习与期望信息增益。</li>
            <li><a href="https://doi.org/10.1080/01621459.1927.10502953" target="_blank" rel="noreferrer">Wilson (1927)</a>：二项比例区间。</li>
            <li><a href="https://doi.org/10.1080/01621459.1986.10478240" target="_blank" rel="noreferrer">Tierney &amp; Kadane (1986)</a>：贝叶斯后验的 Laplace 近似。</li>
          </ol>
          <p>实现细节以当前版本代码为准。本站默认只读；只有在结果页 Danger Zone 输入令牌、检查变更并确认账号后才会写回评分。收藏快照与判断仍只保存在当前站点的浏览器存储中。</p>
        </footer>
      </article>
    </div>
  </main>;
}
