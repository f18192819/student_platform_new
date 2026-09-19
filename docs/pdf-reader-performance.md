# PDF 阅读器首屏与预取性能优化报告

基线代码：`main` 提交 `c7225717a82b0bf4025ee3e87a3c00c7506ba3d5`。

## 1. 原始首屏阻塞路径

上传路径先执行 `extractPdfPreview(file)`，逐页调用 `getPage()`、`getTextContent()` 并生成 Markdown；即使只是重新打开已有文件，controller 也会等待所有页面尺寸初始化。服务端增强预览还受到全局存储锁、慢速 PNG `optimize=True` 编码和整文件响应的影响。页数越多，首屏前的工作越接近 O(pageCount)。

## 2. 全页 extraction 如何移出首屏

工作区上传、知识库上传和只读答案 PDF 改走 fast-open。工作区在拿到当前页 controller 后立即发布阅读器，再进行持久化和 MinerU；MinerU hydration 还会等待当前页 visual-ready。仍然真正需要全文 Markdown 的独立流程继续保留 `extractPdfPreview`，没有删除 extraction 能力。

## 3. `openPdfPreviewFromBuffer` 如何变成 fast open

现在只等待 `PDFDocumentProxy` 和请求的初始页，不生成 Markdown、outline 或全页文本，也不扫描全部页面。controller 会立即暴露 `pageCount`、`getPage()`、lazy `getPageSize()` 和 `dispose()`。

## 4. `pageSizes` 的 lazy / persisted 策略

`PdfController.pageSizes` 允许稀疏项，并提供 `defaultPageSize` 与 lazy `getPageSize()`。`KnowledgeFile` 持久化页面尺寸；后端预热异步发现全页尺寸，并以“保留已有有效项、填补缺项”的方式合并，既防止旧客户端覆盖元数据，也能把初次打开时的稀疏数组补全。没有历史尺寸的旧文件仍可通过当前页 lazy probing 打开。

## 5. 当前页优先调度

调度顺序是：当前页 priority 0；当前页跨过两个 RAF 的真实绘制边界后，释放下一页 priority 1；下一页 visual-ready 后，再释放上一页 priority 2。任何时刻只挂载当前页及相邻页的 PDF canvas，邻页不会与当前页争抢首屏。

## 6. PDF.js canvas 与 server raster 的关系

即使存在 server raster，PDF.js canvas 仍先渲染并作为 visual-ready 信号。文本层在 visual-ready 后异步提取，失败不影响可读性。增强 raster 只在 canvas 可见后请求，并延迟 110 ms 覆盖；同时绘回 canvas，以保持截图能力。若 PDF.js 渲染失败，raster 仍作为 fallback。

## 7. 后端 page preview 锁与发布

从全局 `_storage_lock` 中移除了耗时渲染。现在按“PDF 路径 + 页码”使用弱引用 keyed lock：同页并发请求去重，不同页可并行。源文件 identity 与 preview epoch 会阻止旧任务发布；缓存文件通过同目录临时文件和 `os.replace()` 原子发布，失败不会留下半成品。

## 8. PNG cold-render benchmark

测试对象为 `_converted.pdf` 第 1 页，5 次运行中位数：

| 编码模式 | 中位耗时 | 文件大小 |
|---|---:|---:|
| `optimize=True` | 12,947.87 ms | 858,818 B |
| `compress_level=1` | 329.95 ms | 1,111,339 B |
| `compress_level=3` | 590.99 ms | 1,028,308 B |

最终选择无损 `compress_level=1, optimize=False`：约快 39 倍，文件约增大 29%，优先降低冷预览延迟。

## 9. preview cache prewarm

PDF 保存以及 MinerU/layout 更新后，后台单 worker、有限队列地预热前 3 页，并补全页面尺寸。任务是 best-effort、非阻塞，并验证源 identity，避免旧任务污染新文件。

## 10. HTTP Range

已实现。后端 PDF 源改为 `FileResponse`，前端 URL fast-open 配置 64 KiB range chunk，并关闭 stream/auto-fetch。浏览器实测返回 `206`，请求头包含 `Range: bytes=0-65535`；因此没有把“配置了 Range”误报成“实际生效”。

## 11. 是否需要 virtualization

本轮没有做高风险的完整 DOM virtualization。120 页仍保留轻量 page shell，以维持连续滚动、页码检测、锚点和 resize 稳定性；只有当前页与相邻页挂载重 canvas，并为 page shell 增加稳定 intrinsic size 与 `content-visibility:auto`。这已经移除了主要渲染成本，后续只有在超大文档 DOM profiling 明确显示 shell 数量成为瓶颈时，才值得引入完整窗口化。

## 12. 10 / 50 / 120 页 TTFV 前后对比

以下为同一路由导航 harness，单位 ms。“下一页 ready”表示第一页可见到第二页 ready 的间隔。

| 页数 | 缓存 | 修改前 Shell | 修改前首屏 | 修改前下一页 | 修改后 Shell | 修改后首屏 | 修改后下一页 |
|---:|---|---:|---:|---:|---:|---:|---:|
| 10 | cold | 799 | 1,853 | 0 | 974 | 1,921 | 192 |
| 10 | warm | 1,204 | 3,269 | 0 | 1,308 | 3,502 | 463 |
| 50 | cold | 1,283 | 8,179 | 5,485 | 1,385 | 2,630 | 252 |
| 50 | warm | 1,704 | 4,215 | 0 | 1,654 | 4,018 | 686 |
| 120 | cold | 1,328 | 9,160 | 5,805 | 1,169 | 2,461 | 178 |
| 120 | warm | 1,708 | 4,121 | 0 | 1,648 | 4,319 | 1,128 |

更新后，从知识库真实点击进入的独立结果：

| 页数 | 缓存 | Shell | 首屏 | 下一页 ready |
|---:|---|---:|---:|---:|
| 10 | cold | 302 | 1,210 | 173 |
| 10 | warm | 497 | 2,664 | 471 |
| 50 | cold | 212 | 1,428 | 789 |
| 50 | warm | 542 | 3,033 | 737 |
| 120 | cold | 151 | 1,390 | 370 |
| 120 | warm | 368 | 2,937 | 1,101 |

结论：冷首屏不再随 10 → 50 → 120 页近似线性增长，120 页 route harness 从 9.16 s 降到 2.46 s，点击 harness 为 1.39 s。

限制：harness 拦截 API 请求，因此不能等价模拟浏览器正常 HTTP cache；warm 数据主要反映同一浏览器上下文和服务端 raster cache，也会受后台预热竞争影响，不能解读为“warm 必然比 cold 快”。

## 13. Build

`npm.cmd run build`：通过。Vite 仅报告既有的大 chunk 警告。

## 14. Frontend tests

`npm.cmd run test:frontend`：74/74 通过。新增覆盖 fast controller 只请求初始页、当前/下一/上一调度顺序、上传不再走全量 extraction、存在 raster 时 PDF.js 仍先渲染，以及本轮 soft gate、controller dispose、page-size prefetch 与 mixed-size anchor 等行为。

## 15. Backend tests

`python -m unittest discover -s backend/tests -v`：156/156 通过。新增覆盖不同页并行、同页去重、原子发布失败不留缓存、稀疏页面尺寸可被后台发现结果补全。

## 视觉与响应式 QA

使用 120 页文档检查 1440×1000 与 390×844 viewport：document/body 横向溢出均为 0；首屏完成后只挂载第 1、2 页 canvas，对应 priority 0、1。截图保存在 `.pytest-tmp/pdf-reader-desktop.png` 和 `.pytest-tmp/pdf-reader-mobile.png`。

## Stability follow-up

本轮不更新上述历史性能结论，只收尾生命周期、MinerU 恢复能力、混合页面尺寸稳定性与 benchmark 可复现性。

- MinerU hydration 仍优先等待当前页 first visual，但 1,800 ms grace 到期后会放行，Reader 渲染失败不会永久阻断处理。
- Lecture、Homework 与学生答案 PDF controller 均按 object identity 幂等释放；LRU 淘汰和组件 teardown 会销毁 PDF.js document 资源。
- 当前页 visual-ready 后才以低优先级预取邻近两页的 geometry，顺序为 `+1, -1, +2, -2`，不会进入 first-paint critical path。
- `scripts/pdf_performance_server.py --baseline` 默认固定读取 `c7225717a82b0bf4025ee3e87a3c00c7506ba3d5`，也可用 `--baseline-ref` 或 `PDF_BENCH_BASELINE_REF` 覆盖。启动输出同时记录解析后的 baseline ref 与当前 candidate HEAD。
