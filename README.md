# 听书 Audiobook（SillyTavern 扩展）

把酒馆里的消息像有声书一样读出来：旁白、对白分开，按说话人男女自动切换声线。

## 安装

方式一（推荐）：在酒馆的「扩展」面板点「安装扩展」，粘贴本仓库的 GitHub 地址
（仓库需要是公开的），安装后刷新页面。以后有更新，点扩展旁边的更新按钮即可。

方式二：手动把整个文件夹放进酒馆扩展目录，例如
`SillyTavern/public/scripts/extensions/third-party/tavern-audiobook`。

安装后在「扩展」面板能看到「🎧 听书 Audiobook」。
只做到这一步时，用的是手机自带的系统语音，已经能听书。

## 启用本地音源（离线、可选声线）

模型文件很大（约 400 MB），超过 GitHub 的单文件 100 MB 上限，
所以不在仓库里，需要安装后单独下载，放进扩展目录的 `sherpa/` 文件夹。

推荐用 Kokoro 多语言模型（自带中文男女声，扩展里已内置男女声对应表，不用识别）。
需要 4 个文件，文件名必须一致：

- `sherpa-onnx-tts.js`
- `sherpa-onnx-wasm-main-tts.js`
- `sherpa-onnx-wasm-main-tts.wasm`
- `sherpa-onnx-wasm-main-tts.data`（约 400 MB，模型就打包在这个文件里）

来源：Hugging Face 上的 `cgisky/kokoro-multi-lang-wasm`（Files 页面）。

在 Termux 里下载（需要 Wi-Fi）。先找到扩展安装到哪里了：

```
find ~/SillyTavern -type d -name tavern-audiobook
```

再把下面的路径换成上一步找到的路径，执行：

```
cd 上一步找到的路径
mkdir -p sherpa && cd sherpa
for f in sherpa-onnx-tts.js sherpa-onnx-wasm-main-tts.js sherpa-onnx-wasm-main-tts.wasm sherpa-onnx-wasm-main-tts.data; do
  curl -L -O "https://huggingface.co/spaces/cgisky/kokoro-multi-lang-wasm/resolve/main/$f"
done
```

然后刷新酒馆，在设置里点「加载本地音源」（首次几十秒）。状态栏显示
「Kokoro v1.0 / v1.1」就说明男女声表已套用；如果显示的是别的说话人数量，
就点「识别男女声」让扩展自己判断。

通过「安装扩展」更新时，`sherpa/` 里下载的文件不会被删除。

## 太卡怎么办

本地音源（Kokoro）在手机浏览器里运行，合成时会占用页面，配置低的手机会卡。可以这样调：

- 设置里把「每段最多字数」调小（比如 20），每次卡的时间更短，代价是停顿更多
- 关掉「打开酒馆后自动加载本地音源」，需要听书时再点「加载本地音源」
- 实在不行，把「声音引擎」改成「仅系统语音」，完全不卡，只是音质和声线取决于手机自带的语音

## 设置面板

- 只朗读 AI 生成的文字 / 自动朗诵新消息 / 自动切换声线
- 旁白、男声、女声、统一声线，各自可选并可试听
- 当前角色性别（自动判断，可手动改）、我的性别
- 朗读旁白 / 朗读对白、跳过括号内容、忽略的标签、语速、音量

## 使用

- 每条消息的按钮栏里有 🎧，点它朗读这一条
- 屏幕右侧的悬浮 🎧：朗读最新一条；播放时变成 上一句 / 暂停 / 下一句 / 停止 / 倍速
