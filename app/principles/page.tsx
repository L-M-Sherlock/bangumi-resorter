import type { Metadata } from "next";
import { AppReturnLink } from "@/app/AppReturnLink";
import { Term } from "@/app/Term";
import { ThemeToggle } from "@/app/ThemeToggle";

export const metadata: Metadata = {
  title: "为什么这样排序？· Bangumi Resorter",
  description: "从评分聚集、两两比较到 Bradley–Terry 后验与动态停止：Bangumi Resorter 的完整方法、假设与限制。",
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
          <dl className="principles-meta"><div><dt>方法来源</dt><dd><a href="https://gwern.net/resorter" target="_blank" rel="noreferrer">Gwern · Resorting Media Ratings ↗</a></dd></div><div><dt>本项目实现</dt><dd>Bradley–Terry · Laplace 后验 · 主动选题</dd></div><div><dt>阅读方式</dt><dd>主线讲直觉，技术框可以跳过</dd></div></dl>
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
          <p>系统为每部作品设置一个不可直接观察的<Term term="latent-preference">连续潜在分数</Term> θ。<Term term="bradley-terry">Bradley–Terry 模型</Term>假定两部作品的分数差决定胜率：差得越远，偏好前者的概率越高；分数相同则各有一半概率。选择“差不多喜欢”时，双方各得到半次胜利。</p>
          <aside className="technical-box">
            <span>技术框 · 比较似然</span>
            <code>P(i ≻ j) = σ(θᵢ − θⱼ)</code>
            <p>σ 是 <Term term="logistic-function">logistic 函数</Term>。模型用 <Term term="map-estimate">MAP 估计</Term>寻找最符合比较与<Term term="prior">先验</Term>的一组 θ，并以 <Term term="l2-regularization">L2 正则</Term>抑制稀疏数据造成的极端值。</p>
          </aside>
          <p>一个最佳排序仍然不够：我们还要知道它有多不确定。系统读取最优点附近的 <Term term="hessian">Hessian</Term>，用 <Term term="laplace-approximation">Laplace 近似</Term>构造快速的高斯<Term term="posterior">后验</Term>。这不是精确贝叶斯推断，但能在交互所需的时间内反复抽样，检查其他仍然合理的排序会把作品放到哪里。</p>
          <div className="model-flow" role="img" aria-label="数据流：原评分和比较记录进入偏好模型，产生后验排序，再映射到评分档">
            <span>原评分<br /><small>粗先验</small></span><b>＋</b><span>比较记录<br /><small>新证据</small></span><b>→</b><span>后验排序<br /><small>含不确定性</small></span><b>→</b><span>K 档评分<br /><small>输出摘要</small></span>
          </div>
        </section>

        <section>
          <SectionHeading id="inference-modes">原评分先验与三种模式</SectionHeading>
          <p><Term term="prior">原评分先验</Term>回答的是一个取舍：我们愿意多大程度相信旧评分仍代表当前偏好？快速模式使用强先验，只校正附近顺序；标准模式允许比较显著改写原评分；精细模式不采用原评分顺序，让比较本身支撑排序。</p>
          <p>这三种<Term term="inference-mode">推断模式</Term>不是三个互不相干的进度条。停止检查采用嵌套要求：标准必须同时通过快速与标准模型，精细必须通过全部三种模型。因此更高模式不会凭一次偶然的宽松估计先于低模式达标。</p>
          <div className="principles-table-wrap"><table className="principles-mode-table"><thead><tr><th>模式</th><th>原评分作用</th><th>探索范围</th><th>适合的问题</th></tr></thead><tbody><tr><th>快速</th><td>强顺序先验</td><td>局部为主</td><td>在旧评分基础上纠正明显错位</td></tr><tr><th>标准</th><td>中等顺序先验</td><td>边界与全局均衡</td><td>允许偏好显著改变旧评分</td></tr><tr><th>精细</th><td>不采用顺序先验</td><td>高覆盖全局比较</td><td>让比较独立支撑完整排序</td></tr></tbody></table></div>
        </section>

        <section>
          <SectionHeading id="question-selection">下一题为什么是这一对</SectionHeading>
          <p>最不确定的作品不一定构成最有用的问题。若只追逐最大误差，算法可能反复困在同一小组。普通问题因此按<Term term="information-gain">期望信息增益</Term>排序：预估用户回答左、右或平局之后，整个潜在偏好状态能减少多少不确定性，同时惩罚重复配对。</p>
          <p>纯贪心仍会忽略边缘作品，所以系统混入两类有意的“低效率”：<Term term="coverage-exploration">覆盖探索</Term>把比较带到证据稀少或尚未稳定的区域；<Term term="calibration-repeat">校准复问</Term>交换左右重问旧题，单独诊断判断波动。前者参与建模，后者只作诊断，不提高也不降低停止门槛。</p>
        </section>

        <section>
          <SectionHeading id="score-buckets">从连续排序回到 K 档</SectionHeading>
          <p>潜在分数适合计算，却不适合直接解释。最终输出通过 <Term term="score-bucket">K 档分桶</Term>把排序切成 3–20 档；每一档容纳多少作品由<Term term="score-distribution">评分分布</Term>决定。改变 K 或分布不会删除比较，也不改变“谁在谁前面”，但会移动档位边界，因此必须重新计算稳定度、下一题和剩余预测。</p>
          <p>均匀分布让每档人数接近；保持原分布保留收藏的整体评分轮廓；默认的<Term term="high-tail">高分辨率尾部分布</Term>在高分区域使用较窄档位；<Term term="reverse-j">反 J 分布</Term>更激进，把大多数作品压进低档，只为极少数顶尖作品保留高分。没有一种分布天然“真实”，只有是否适合你的用途。</p>
        </section>

        <section>
          <SectionHeading id="stopping-rule">何时算作足够稳定</SectionHeading>
          <p>要求每部作品都固定在唯一一档，会让最靠近边界的作品永远拖住整个项目。本站把实质错误定义为<Term term="cross-two-buckets">跨两档</Term>：相邻档摆动可以接受，移动两档或更多才计入损失。</p>
          <p>在每一次 <Term term="monte-carlo">Monte Carlo 模拟</Term>的后验排序里，至少 90% 的作品必须相对当前结果最多偏移一档；然后，满足这个总体事件的概率之 <Term term="wilson-bound">Wilson 下界</Term>还必须达到 90%。使用 <Term term="mc-lower-bound">MC 下界</Term>而非观察比例，是为了避免 64 或 128 次模拟中的偶然好运被误报成稳定。</p>
          <figure className="principle-figure stopping-figure">
            <div className="stopping-grid" role="img" aria-label="一百个作品中九十个最多偏移一档，十个允许跨两档">{Array.from({ length: 100 }, (_, index) => <i className={index < 90 ? "within" : "outside"} key={index} />)}</div>
            <figcaption><b>90 个</b>最多偏移一档；<b>10 个</b>可以跨两档。真正停止还要求这个事件的保守概率下界达到 90%，并满足最低本会话证据量。</figcaption>
          </figure>
          <p><Term term="adjacent-tolerance">后验期望相邻容差覆盖</Term>是平均诊断；<Term term="bucket-stability">精确分桶稳定度</Term>描述单部作品；<Term term="maximum-displacement">最坏偏移</Term>观察最极端的尾部。它们帮助解释风险，但都不能替代上述总体停止事件。</p>
        </section>

        <section>
          <SectionHeading id="remaining-forecast">剩余次数如何预测</SectionHeading>
          <p><Term term="dynamic-forecast">动态剩余预测</Term>不是把当前进度除以平均速度。系统从当前后验抽取 64 条代表性路径；每条路径按当前模式选择下一对，模拟一次左胜、平局或右胜（含固定的小幅 lapse），用方向性秩一更新改写该对的后验，再检查模式自己的停止事件，最后报告 10%、50% 与 90% 分位数。</p>
          <p>所以区间可能变宽、变窄甚至暂时上升：新答案可能暴露此前被先验掩盖的不确定性。预测窗口内没有成功路径也不证明目标不可达。它只说明，在当前模型和有限前瞻下，还没有足够证据给出有限上界；大型收藏的前瞻窗口会设上限以保持界面响应。</p>
        </section>

        <section>
          <SectionHeading id="collection-drift">收藏变化与长期偏移</SectionHeading>
          <p>偏好并非静止数据库。新作品会加入，旧评分会修改，人的判断标准也会随时间改变。每次同步因此保存独立的<Term term="snapshot">收藏快照</Term>，而不是把旧会话原地改写。</p>
          <p>新建、升级或按标签派生会话时，系统可以复制目标范围内仍然有效的比较；已有会话也可以在明确预览后追加导入。每条副本都记录直接来源和原始根判断，并属于目标会话自身，来源之后新增、删除或被整体删除都不会回流成第二份证据；重复导入按根判断幂等。<Term term="history-reuse">历史判断导入</Term>可以节省工作，但跨快照导入越多，也越可能把旧偏好当成今天的偏好，因此新会话默认从零开始。</p>
        </section>

        <section>
          <SectionHeading id="differences">与 Gwern 原版的差异</SectionHeading>
          <p>本项目继承的是问题设定，不是原脚本的逐行翻译。Gwern 的文章还明确指出其实现缺少原则化不确定性与最优选题；本站把这些“未来改进”变成了交互流程的一部分，同时承担近似误差和更复杂解释的代价。</p>
          <div className="principles-table-wrap"><table><thead><tr><th>问题</th><th>Gwern 原版</th><th>本项目</th></tr></thead><tbody>
            <tr><th>输入</th><td>CSV 名称与可选评分</td><td>Bangumi 收藏、标签与不可变快照</td></tr>
            <tr><th>旧评分</th><td>转成相邻伪比较</td><td>正则化强、中、零顺序先验</td></tr>
            <tr><th>估计</th><td>BradleyTerry2 频率学派拟合</td><td>MAP 拟合与 Laplace 后验近似</td></tr>
            <tr><th>选题</th><td>最大标准误与随机探索交替</td><td>期望信息增益、覆盖探索、校准复问</td></tr>
            <tr><th>停止</th><td>用户退出或预设问题数</td><td>总体相邻容差的后验概率下界</td></tr>
            <tr><th>输出</th><td>命令行分位数映射</td><td>3–20 档、多种分布、解释诊断与 CSV</td></tr>
          </tbody></table></div>
        </section>

        <section>
          <SectionHeading id="limitations">限制与诚实声明</SectionHeading>
          <ul className="principles-limitations">
            <li>结果描述的是这个账号、这批作品、这些时刻下的主观偏好，不是作品的客观质量。</li>
            <li>Bradley–Terry 假设偏好大致可由一维连续顺序表达；强烈的类型依赖或循环偏好会被压缩。</li>
            <li>Laplace 后验、固定响应模型和未来逐题更新都是近似。页面上的概率与题量区间只在模型内部成立。</li>
            <li>“已稳定”不表示你以后不会改主意，只表示现有证据下，大多数作品不太可能发生跨两档变化。</li>
            <li>高分辨率分布提高高分区分力的代价，是压缩其他区域；选择分布本身就是价值判断。</li>
            <li>校准复问只报告判断波动，不会秘密调整你的答案、似然温度或停止结论。</li>
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
