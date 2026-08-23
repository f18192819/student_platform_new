# Student Learning Platform Demo

课程服务平台本地 Demo。

当前项目不是纯前端静态页，而是由两部分组成：

- 前端：Vite 开发服务器，默认端口 `4173`
- 后端：FastAPI 服务，默认端口 `8000`

前端里的 `/api/*` 请求会代理到 `http://127.0.0.1:8000`，所以如果只启动前端、不启动后端，页面能打开，但下面这些功能会失败：

- 上传 PDF 后的后端解析流程
- 音频 / 录音转写
- 课堂讲解映射
- MinerU 提取
- 任何走 `/api/*` 的功能

## Environment

建议环境：

- Node.js 18+
- Python 3.10+
- FFmpeg 已安装，并且命令行可直接调用 `ffmpeg` / `ffprobe`
- 本地可用的 FunASR Python 环境

当前项目默认按下面这组本地环境运行：

- 前端地址：`http://127.0.0.1:4173`
- 后端地址：`http://127.0.0.1:8000`
- 本地 ASR Python：`C:\anaconda3\python.exe`

## Install

先安装前端依赖：

```bash
npm install
```

如果你要跑后端，请确认下面这些 Python 依赖可用：

```bash
fastapi
uvicorn
requests
qdrant-client
```

另外，本地 ASR 依赖：

```bash
funasr
torch
```

## Start

开发时需要同时启动两个进程。

### 1. 启动后端

在项目根目录执行：

```bash
C:\anaconda3\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000
```

或者用 npm 脚本：

```bash
npm run serve:local
```

后端启动成功后，可以访问：

```text
http://127.0.0.1:8000/openapi.json
```

如果能返回 JSON，说明后端已经起来了。

### 2. 启动前端

在另一个终端执行：

```bash
npm run dev
```

然后打开：

```text
http://127.0.0.1:4173
```

## Minimal Startup Checklist

如果你只是想确认“当前项目能不能正常上传 PDF / 上传录音 / 问 AI”，请按这个顺序检查：

1. 先启动后端 `8000`
2. 再启动前端 `4173`
3. 打开 `http://127.0.0.1:4173`
4. 上传讲义 PDF
5. 再测试上传录音 / 开始上课

如果第 5 步失败，先检查后端是不是还活着：

```bash
curl http://127.0.0.1:8000/openapi.json
```

或者浏览器直接打开：

```text
http://127.0.0.1:8000/openapi.json
```

## Audio / ASR Notes

当前课堂录音和上传音频，已经不再依赖 Octopus 的本地 ASR 服务，而是直接走你本地的 FunASR。

默认使用：

- Python：`C:\anaconda3\python.exe`
- 模型缓存目录：`C:\Users\fangk\.cache\modelscope\hub\models\iic\...`

音频处理逻辑：

- 小于等于约 10 分钟：直接用原文件转写
- 更长的音频：后端自动按 10 分钟分段，再调用本地 FunASR

## Common Problems

### 页面能打开，但上传录音 / PDF / 课堂讲解失败

最常见原因：你只开了前端，没有开后端。

因为前端 `4173` 会把 `/api/*` 代理到 `8000`，如果 `8000` 没启动，这些功能都会失败。

### 上传录音失败

请先检查：

1. `http://127.0.0.1:8000/openapi.json` 能否打开
2. `ffmpeg` 和 `ffprobe` 是否能在命令行直接运行
3. `C:\anaconda3\python.exe` 是否可用
4. `funasr` 是否能在这个 Python 环境里导入

可用下面命令快速验证：

```bash
C:\anaconda3\python.exe -c "import funasr, fastapi, uvicorn, requests; print('ok')"
```

### 只想开项目，不想开 Octopus

可以。

这个项目现在可以独立运行，不需要依赖 Octopus 才能完成本地 PDF、问答、录音转写、课堂讲解映射这些功能。

但如果你还想从 Octopus 市场入口点进来，就仍然需要 Octopus 运行。

## Useful Commands

```bash
npm run dev
npm run build
npm run lint
npm run serve:local
```

## Main Files

- [app.py](C:/data/octopus/student-learning-platform-demo/app.py) : FastAPI 后端入口
- [vite.config.ts](C:/data/octopus/student-learning-platform-demo/vite.config.ts) : 前端开发服务器和 `/api` 代理配置
- [src/pages/PdfWorkspacePage.tsx](C:/data/octopus/student-learning-platform-demo/src/pages/PdfWorkspacePage.tsx) : PDF 阅读、疑点、课堂讲解、音频处理主页面
- [src/lib/ai.ts](C:/data/octopus/student-learning-platform-demo/src/lib/ai.ts) : 前端 AI / ASR 请求封装
- [scripts/local_funasr_transcribe.py](C:/data/octopus/student-learning-platform-demo/scripts/local_funasr_transcribe.py) : 本地 FunASR 转写脚本
