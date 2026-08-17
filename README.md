# Bangumi Resorter

一个静态优先、数据本地保存的 Bangumi 收藏重排工具。它读取你已经打过分的条目，通过两两比较和带正则化先验的 Bradley–Terry 模型，逐步得到更细的个人偏好顺序；不会修改 Bangumi 上的原评分。

## 功能

- 读取 Bangumi 全部 `rate > 0` 的收藏，并按动画、书籍、音乐、游戏和三次元分别排序
- 可选个人令牌，用于读取私有收藏；令牌只存在当前页面内存，不进入 IndexedDB、日志或导出文件
- 信息增益驱动的下一对选择、平局、跳过冷却、撤销、暂停和恢复
- Worker 内运行带 L2 先验的 Bradley–Terry / MAP 拟合，避免大量条目时阻塞界面
- 均匀、保持原分布、高分辨率尾部、自定义权重四种 1–10 分映射
- IndexedDB 自动保存；CSV 结果导出和完整 ExportV1 JSON 备份/迁移
- 带演示数据，可在不连接 Bangumi 的情况下体验完整流程

方法受到 [Gwern 的 Resorter](https://gwern.net/resorter) 启发。这里采用稳定的正则化 Bradley–Terry 优化，并保留原评分作为弱先验，而不是把原评分直接当作最终顺序。

## 本地开发

要求 Node.js 22.13 或更高版本。

```bash
npm ci
npm run dev
```

打开 `http://localhost:3000`。常用检查：

```bash
npm run typecheck
npm run test:unit
npm run lint
npm run build
npm run test:e2e
```

生产静态文件位于 `dist/client`。

## 部署

这个项目没有服务端数据库和密钥，适合 GitHub Pages、Vercel、Cloudflare Pages 等静态托管。运行时只会从浏览器直接请求 `https://api.bgm.tv/v0`；用户数据留在对应域名的 IndexedDB 中。因此更换域名不会自动带走本地数据，需要先下载 JSON，再到新站点导入。

### GitHub Pages

仓库已包含 `.github/workflows/deploy-pages.yml`。在仓库 Settings → Pages 中把 Source 设为 GitHub Actions，推送 `main` 即会测试、按仓库子路径构建并部署。工作流也支持 `username.github.io` 这类根站点仓库。

### Vercel

直接导入仓库即可；`vercel.json` 会运行 `npm run build` 并发布 `dist/client`。建议给正式域名设置环境变量：

```text
NEXT_PUBLIC_SITE_URL=https://你的正式域名
```

### 其他子路径托管

如果站点部署在 `/some-path` 下，构建时设置：

```bash
NEXT_PUBLIC_BASE_PATH=/some-path \
NEXT_PUBLIC_SITE_URL=https://example.com \
npm run build
```

## 数据与隐私

- Bangumi API 请求全部为 `GET`。
- 可选令牌不会持久化，也不会进入备份。
- 私有条目的名称、评分和判断会进入本地 IndexedDB 与 JSON 备份；界面会在导出前提示。
- 浏览器清理站点数据会删除 IndexedDB。建议每完成约 20 次判断后下载 JSON 备份。
- 导入永远创建新项目，不覆盖已有数据；单个备份文件限制为 20 MB。

## 模型简述

每个条目有一个潜在偏好强度。比较结果的似然由两者强度差的 logistic 函数给出；平局按半胜处理。优化器使用原评分派生的弱先验和 L2 正则，Newton 外循环配合预条件共轭梯度求解，并用线搜索保证目标函数不下降。候选问题来自当前相邻的 1–3 个排名位置，再按预期信息量、不确定性和重复惩罚选择。

最终的连续强度只决定顺序，1–10 分由当前选择的分布配置重新映射。这样可以随时切换分布，而无需重做比较。
