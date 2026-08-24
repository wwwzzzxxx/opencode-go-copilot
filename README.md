<div align="center">

![logo](/assets/logo.png)

# 【魔改】OpenCode Go Provider for Copilot

</div>

> [!IMPORTANT]
> **魔改声明**
> 本项目是基于 [OnesoftQwQ/opencode-go-copilot](https://github.com/OnesoftQwQ/opencode-go-copilot) 的 Fork 魔改版，额外支持：VPN 代理转发、状态栏命中率/用耗/多窗口配额展示等。`muse-spark` 为上游已有能力，因本 Fork 较早、近期已同步上游的更新并做了适配。原项目 MIT 许可，本 Fork 保持相同许可。

## 中文

> [!IMPORTANT]
> **本插件与 OpenCode 官方或 Anomaly 无关，也未获得其官方维护或认可。**

将 [OpenCode Go](https://opencode.ai/go) 以及可选的 Zen 免费模型集成到 GitHub Copilot Chat 的 VS Code 插件。

### 使用

1. **设置 API Key**：`Ctrl+Shift+P` → `OpenCodeGo: Set OpenCode Go API Key`
2. **显示模型**：在模型选择器中点击设置图标 → **语言模型** 面板 → 将需要使用的模型显示
3. **选择模型**：在 Copilot Chat 底部模型选择器中选择 "OpenCode Go" 或 "OpenCode Zen" 下的模型
4. **开始对话**

### 高级 Token 用量指示器（魔改）

安装后状态栏直接展示 `命中/总命中/输入/输出/费用/5h·周·月配额及倒计时`（如下图），无需额外设置。

![token_counter](/assets/screenshots/token_counter_v2.png)

### Git 提交消息

在源代码管理（SCM）面板中点击魔法棒按钮，自动生成 Git 提交消息。

可在配置里配置使用的模型、语言、参考的最近提交数量以及是否附加上下文文件。

### 扩展视觉理解

本插件为**不支持视觉理解**的**纯文本模型**添加了**扩展视觉理解**功能，当你向这些模型发送带有图片的信息时，他们可以调用支持视觉理解的模型为图片输出描述，然后再回答。

通过配置文件可更改默认使用的模型以及是否在描述图片时启用思考。默认情况下，将使用 Qwen3.6-Plus 描述图片。

### 启用 OpenCode Zen 免费模型

该功能默认关闭，通过 `opencodego.enableZenFreeModels` 设置启用。开启后，将从 Zen API 获取免费模型并添加到模型选择器中，名称带 `Zen/` 前缀（如 `Zen/DeepSeek V4 Flash Free`）。更改设置后需要重新加载 VS Code 才能生效。

### 调整模型温度

通过 `Ctrl+Shift+P` → `OpenCodeGo: Set Model Temperature Preset` 快速切换温度预设。

内置 4 个预设档位：

| 档位 | 温度 |
|------|------|
| 精确 | 0.0 |
| 均衡 | 1.0 |
| 创意 | 1.2 |
| 极具创意 | 1.7 |

也可在 `settings.json` 中直接配置 `opencodego.temperature` 和 `opencodego.top_p`（需将 `opencodego.modelPreset` 设为 `"custom"`）。

### 配置

可在 `settings.json` 中配置：

```json
{
  "opencodego.commitLanguage": "auto",
  "opencodego.commitModel": "deepseek-v4-flash",
  "opencodego.commitMessagePrompt": "",
  "opencodego.requestTimeout": 600000,
  "opencodego.recentCommitsCount": 10,
  "opencodego.commitIncludeCommitDiff": false,
  "opencodego.commitAttachContextFiles": true
}
```

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `opencodego.commitLanguage` | `auto` | 提交消息语言。设为 `auto` 时将根据历史提交自动检测语言（无历史时默认英语）。 |
| `opencodego.commitModel` | `deepseek-v4-flash` | 用于生成提交消息的模型。 |
| `opencodego.commitMessagePrompt` | `""` | 生成提交消息的自定义系统提示词。 |
| `opencodego.requestTimeout` | `600000` | 单个 API 请求的最大等待时间（毫秒）。默认 600000（10 分钟）。生成长内容超时时可增大此值。 |
| `opencodego.recentCommitsCount` | `10` | 生成提交消息时参考的近期提交数量，用于学习仓库提交风格。设为 0 可禁用。 |
| `opencodego.commitIncludeCommitDiff` | `false` | 在风格参考中包含历史提交的实际代码变更（diff），帮助模型生成更符合项目提交风格的消息。 |
| `opencodego.enableZenFreeModels` | `false` | 启用 OpenCode Zen 免费模型并添加到模型选择器中。暂不支持用于 Git 提交消息生成。更改后需重载 VS Code 生效。 |
| `opencodego.commitAttachContextFiles` | `true` | 将仓库根目录的 AGENTS.md 和 README.md 作为额外上下文附加到提交消息生成中，帮助模型更好地理解项目。 |
| `opencodego.visionProxyModel` | `qwen3.6-plus` | 用于 ask_image 工具的视觉模型 ID。当所选模型不支持视觉时，该模型用于回答图片相关问题。 |
| `opencodego.visionProxyThinking` | `false` | 在视觉代理模型回答图片查询时启用思考/推理功能。 |

> [!NOTE]
> 支持切换思考模式的模型（如 DeepSeek、Qwen）提供`禁用思考`/`高`/`极高`等推理强度选项。

### 编译

```bash
npm install
npm run compile
npm run build      # 打包为 extension.vsix
```

### 许可

MIT License。本项目参考了 [oai-compatible-copilot](https://github.com/JohnnyZ93/oai-compatible-copilot) 的代码。
