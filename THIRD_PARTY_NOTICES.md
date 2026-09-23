# 第三方声明

这个包不带识别程序、模型和 Electron。下面是它在运行时会去取的东西,以及各自的许可。

## 识别程序

whisper.cpp 的 `whisper-server`,钉在发布 `b5130`,由「语音输入」面板从
[ggml-org/whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases/tag/b5130) 取到
`<运行时根>/whisper.cpp/b5130/`。MIT。

## 模型

放在 `<模型根>/desktop-pet/`,按固定 revision 从 HuggingFace 下载并校验 SHA-256。

| 文件 | 来源 | 许可 |
|---|---|---|
| `ggml-base-q5_1.bin`、`ggml-small-q5_1.bin`、`ggml-large-v3-turbo-q5_0.bin` | [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp) @ `5359861` | MIT(OpenAI Whisper 权重的 ggml 转换) |

## 桌宠窗口

Electron 44.4.4,从 [electron/electron releases](https://github.com/electron/electron/releases/tag/v44.4.4)
取到 `<运行时根>/electron/44.4.4/`,或使用内嵌应用自带的那份。MIT;其中 Chromium 与依赖各随其许可。

## 其他运行时依赖

- `ws`:MIT
- `opencc-js`(繁简转换):MIT AND Apache-2.0

## 本包的许可

MIT,见 [`LICENSE`](LICENSE)。
