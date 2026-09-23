<!-- Owner: src/definition.ts -->

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
    <img src="assets/banner.svg" alt="cortico-world-desktop-pet" width="806">
  </picture>
</p>

[Cortico](https://github.com/Pal-AI-Lab/Cortico) 的桌宠 World,一个独立的扩展包。
[CortiCompanion](https://github.com/Pal-AI-Lab/CortiCompanion) 桌面上的 Coo 就是它。

bot 在屏幕底边有一个小身体:C 形的身体,两只 0 形的眼睛,两条短腿。它用气泡说话、用选项提问、
沿任务栏走动、做表情和动作;人可以对它说话(内置 whisper.cpp 识别)、打字、点选项、戳它、摸它、
把它拎起来甩出去,这些都作为事件送回 bot。

## 工具

| 工具 | 作用 | 回执 |
|---|---|---|
| `pet_say(script)` | 冒气泡说话;`【词】` 先做动作再换新气泡,`<词>` 打字到那里时做 | 立即返回,报约显示多久、前面排了多久 |
| `pet_ask(question, options, allowOwnAnswer)` | 提问气泡,最多 3 个选项,默认再加一格自己写 | 立即返回;回答以 `[回答]` 事件送达 |
| `pet_walk_to(to, run)` | 走(跑)到屏幕横向 0–1 处,或 `left` `center` `right` `cursor` | 走到或被打断才返回,最多 30 秒 |
| `pet_act(actions)` | 不说话,依次做一串表情或动作 | 立即返回;`sit` `sleep` 保持到下个动作 |

表情和动作的词表在 `src/script.ts`,英文词与中文名都认;环境提示词 `src/ENV_PROMPT.md` 把它渲染成表格。

## 事件

| `type` | 正文 | 投递 |
|---|---|---|
| `desktop-pet.speech` | `[语音] 主人:…` | flush |
| `desktop-pet.message` | `[打字] 主人:…`(右键「说点什么」、双击或悬停按钮) | flush |
| `desktop-pet.answer` | `[回答] 主人回答「问题」:选了第 2 项「…」` / 自己写的 / 关掉没答 | flush,关掉没答为 debounce |
| `desktop-pet.touch` | `[互动] 主人戳了你 3 下` / 摸了摸 / 拎起来甩了出去 / 摔晕 | `worlds.desktop-pet.touch.trigger`,默认 debounce |

同一种互动 2.5 秒内连着来,并成一条带次数的事件。「主人」取自 `worlds.desktop-pet.user`。

## 桌宠窗口

World 在 `127.0.0.1:7797`(被占向上顺延)起一个页面服务:`/pet` 是桌宠本身,`/dress` 是装扮页。
桌宠窗口是一个 Electron 进程(`host/electron-main.cjs`):透明、无边框、置顶,盖住主屏幕的工作区,
鼠标只在身体、气泡、右键菜单和悬停按钮上时才接收点击,其余位置点击穿透。托盘图标可以显示、隐藏、关闭它。
鼠标停在桌宠身上时,身旁出现两个按钮:打字说话、切换黑白模式。窗口打开时桌宠从屏幕顶上掉到底边。
右键菜单顶上一行是 bot 的头像(部署目录的 `avatar.png`,没有时画桌宠自己)和名字;内嵌应用借出运行控制时,
旁边还有暂停/继续、退出按钮,最下面多一行「打开设置」。点退出先在这一行问一次,菜单宽度不变。
「行为模式」展开二级菜单选常走动、多待着、不乱动。
World 进程退出后窗口在 2 秒内自己关掉。

用哪个 Electron,依次是:

1. 环境变量 `CORTICO_DESKTOP_PET_HOST`:内嵌应用给的 JSON 数组命令,末尾追加 `--pet-url=<url>`。
   应用在自己的主进程里调 `require('cortico-world-desktop-pet/host/electron-main.cjs').runPetHost({ url, parentPid })`;
2. 配置 `worlds.desktop-pet.window.electronFile`;
3. 「桌宠」面板安装的托管运行时(Electron 44.4.4,装到 `<运行时根>/electron/44.4.4/`);
4. 本包能解析到的 `electron` 包。

没有窗口时,在浏览器里打开 `/pet` 也能看到桌宠;窗口连着时浏览器标签页只旁观,不接收指令,
打字和偏好改动照样送到 World。

黑白模式存在 `worlds.desktop-pet.theme`,默认 `dark`(浅色身体、深色气泡)。桌宠窗口、`/pet`、`/dress` 和控制台面板里的
预览都按这一项画,与系统和控制台的深浅色设置无关。

## 语音输入

桌宠窗口里的页面用麦克风收音,16 kHz 单声道 PCM 经 WebSocket 送到 World,按能量门限切句
(`src/asr/segmenter.ts`),交给 OpenAI 兼容的 `/v1/audio/transcriptions` 识别,繁体转简体、
挡掉已知幻觉后作为 `desktop-pet.speech` 投递。说话时桌宠歪头倾听,虚线气泡里显示听到的字。

识别端点上已经有服务在跑就直接用;没有且 `asr.manageServer` 开着,World 自己启动 whisper.cpp 的
`whisper-server`。「语音输入」面板负责下载:

- 程序:whisper.cpp `b5130` 的发布包(Windows x64 CPU 版 8.6 MB;Linux 用 ubuntu 包),解到
  `<运行时根>/whisper.cpp/b5130/`。macOS 没有预编译包,用 `brew install whisper-cpp` 后把
  `whisper-server` 填进 `asr.serverFile`;
- 模型:`ggml-base-q5_1`(57 MB)、`ggml-small-q5_1`(181 MB,默认)、`ggml-large-v3-turbo-q5_0`(547 MB),
  从 HuggingFace 固定 revision 下到 `<模型根>/desktop-pet/`,按仓库公布的 SHA-256 校验。

下载都先写 `.partial`,完整后才改名到位。自备的程序和模型填 `asr.serverFile` / `asr.modelFile` 即可。

收音方式存在 `asr.mic`,在「语音输入」面板里改:

| `asr.mic.mode` | 行为 |
|---|---|
| `hold`(默认) | 按住说话键时收音,整段都算话,松开即一句结束 |
| `toggle` | 按一下说话键开始,再按一下停;中间按停顿切句 |
| `always` | 一直收音,按停顿切句 |

说话键 `asr.mic.hotkey` 默认 `RightCtrl`,用 `+` 连写组合键(`Ctrl+Space`、`F8`、`Mouse4`),在哪个窗口里按都算。
它经 koffi 轮询 Win32 `GetAsyncKeyState` 读取,只在 Windows 上可用;读不到时退回 `always`,面板上写明原因。
`asr.mic.deviceId` 选麦克风,留空用系统默认;设备列表由桌宠页在拿到麦克风权限后报上来。
麦克风在「听麦克风」开着时一直打开,电平条随时显示音量,说话键只决定哪一段送去识别。

## 给内嵌应用

`desktopPetDefinition({ controls, onCreate })` 生成定义:`controls`(`PetBotControls`)给右键菜单借出暂停、设置、退出,
借了哪个就只画哪个按钮或菜单行(暂停要 `isPaused` 和 `setPaused`,设置要 `openSettings`,退出要 `quit` 与可选的 `quitLabel`);
`onCreate` 拿到 World 实例,应用可以调 `world.confirm(问题, [同意, 不同意])` 弹一个两选项气泡,
结果是 `yes` / `no` / `dismissed` / `timeout`(60 秒没人答) / `unavailable`(没有桌宠页),不会作为事件送给 bot。

## 安装

```bash
corepack pnpm install
corepack pnpm build        # 面板产物 dist/,不进版本库
```

然后在 Cortico 控制台「扩展」页安装(填本目录的绝对路径),整进程重启。bot 的 `declares` 里加上 `desktop-pet`,或在「World 总览」启用它。

## 开发

```bash
corepack pnpm test
corepack pnpm typecheck
npx tsx scripts/check-voice.ts <whisper-server> <ggml 模型> <语音.wav>   # 连真 whisper.cpp 手动检查
```

`tsconfig.json` 与 `vitest.config.ts` 把 `cortico/*` 指到同级的框架 checkout(`../BOT/src/`);
装进 Cortico 运行时由框架的模块钩子解析。`web/pet-core.js` 是身体本身(造型、表情、配件、合成音效、
动作模拟),桌宠页、装扮页都从它构建,不依赖 World。
