# AI生图 · ai-image

面向 [QQ-agent](https://github.com/K0nd1us/QQ-agent) 的图片生成技能，支持文生图和图生图，并将结果直接发送到当前群聊或私聊。

## 安装与配置

将合集中的 `skills/ai-image/` 整个目录复制到 QQ-agent 的 `skills/` 下，或在仓库根目录执行 `npm run pack:extension -- ai-image` 后导入生成的 ZIP。压缩包根目录直接包含 `skill.json`、`index.js` 和 `lib/`，符合市场打包格式。首次安装按宿主的热重载设置加载。

在控制台的「AI生图」设置中填写：

| 配置 | 用途 |
| --- | --- |
| `baseUrl` | 必填，图片 API 前缀，如 `https://example.com/v1` |
| `apiKey` | 必填，密码字段，使用 Bearer 认证 |
| `model` | 默认 `gpt-image-1`，按服务商支持情况修改 |
| `editModel` | 可选，单独指定图生图模型；留空复用 `model` |

支持纯域名、API 前缀以及完整的 `/images/generations`、`/images/edits` 地址。纯域名自动补 `/v1`；其他路径按原样保留为前缀，例如 `https://example.com/proxy/v1`。不要填聊天接口地址。需要 **OpenAI images 兼容接口**：文生图为 JSON POST，图生图为上传单张参考图的 multipart POST；仅支持 chat/completions 的服务不能直接使用。

初次没有配置时，技能同步显示缺少 Base URL/API Key 的原因。修改配置后下一次调用生效，无需重新加载代码。

## 使用

- 文生图：「画一张雨夜城市街景，赛博朋克风格」。
- 图生图：先发参考图，再说「保留这张图的人物姿势，把背景换成雪山」。
- 指定图片：「把消息 #12345 的第 2 张图改成水彩风」。

注册 `gen` 与 `edit` 两个工具（实际名称前缀为 `ai-image__`）。每次生成 1~4 张，支持可选尺寸。参考图支持 PNG/JPEG/WebP；图片格式、数量、尺寸和参数最终以服务商及模型为准。

确认用户明确要求生图或改图后，主会话模型先通过内置 `send_message` 按当前人设自然告知正在处理，发送成功后调用 `ai-image__gen` / `ai-image__edit`。技能等待生图/改图并发送图片，然后返回结果，要求主会话模型再通过 `send_message` 自然回复完成情况或失败原因。两次文字均由正常主会话产生，技能不生成或发送固定文字，也不另起聊天模型调用。当前对话轮次会等待生图完成。

技能只观察公开的 `ctx.session.sent`：本轮没有非空文字发送记录时，返回“先调用 send_message”的指引，不提交生成请求。记录只能证明本轮有文字发送，不能判断其语义是否确实为开始提醒；具体话术和顺序由提示词引导。图片发出后，工具明确区分“不要重复发图片”和“仍需发送完成文字”，不再把全部回复笼统标为无需发送。生成或发图失败也只返回事实和处理建议，由主会话模型说明。

技能只通过公开的 `api.config()` 读取自己的图片配置，通过 `api.fetch` 访问图片接口，通过 `ctx` 读取当前会话参考图并发送图片。不导入宿主 `src/`、不读取全局聊天配置、不自行组装系统人设或调用主聊天 API。文字回复的人设、权限检查、用量统计和发送均走宿主原有主会话流程。

提示词和工具结果不能强制宿主一定再执行一次 `send_message`。模型选择结束、轮次耗尽或宿主提前收尾时，完成文字仍可能缺失；本技能不声称能硬性保证回复，也不通过内部模块访问来绕过这一限制。要提供强保证，需要宿主公开相应的流程接口。

图生图优先使用明确指定的消息或本轮触发消息中的图片。自动回看最近 30 条记录时，会按本轮触发批的本地消息序号或时间边界排除后来新发的图片。QQ 图片链接过期时，会尝试协议端提供的其他地址或本地文件。

图片先下载或解码、检查体积与格式，再保存到系统临时目录 `qq-agent-ai-image`，经 `ctx.sender` 发到当前会话。本地路径发送有 `dataUrl` 回退；缓存失败时仍可发送。缓存保留最新 20 张，一小时内文件暂不清理以保护并发发送。会话历史与限频、去重由 QQ-agent 的发送器负责。

API Key 不写入源码，不发送给参考图或结果图的下载地址。默认关闭生成重试；可选重试仅针对 HTTP 429，不能据此保证服务商不计费。图片下载遇到网络故障可以重试一次，生成超时、5xx、断连和发送失败都不会再次调用生成接口。

## 停用、中止与更新

停用、卸载或重载技能会中断在途 HTTP 请求和重试等待，并阻止旧操作继续提交生成或发送图片。再次启用不会恢复旧操作。已经被服务商受理的请求仍可能计费。

工具在回复、生成、下载和发送边界检查可见的会话状态；观察到 `done`、`noreply`、`aborted` 或 `error` 时停止后续处理。已核对的 QQ Agent API v1 没有向技能传递会话取消信号，因此不能保证“中止”按钮立即打断在途处理。需要停止所有在途生图时可停用技能。已经交给宿主发送队列的消息无法由技能撤回。

重启不会恢复或自动重新提交未完成请求。其他扩展调用 `image.generate` / `image.edit` 能力时只返回图片数据，由调用方负责发送，不触发开始或结果聊天回复。

配置修改下一次调用生效。宿主热重载只重新导入入口，Node.js 会缓存静态导入的子模块；修改 `lib/` 后应重启 QQ Agent，确保加载新代码。

额外请求字段 `extraBody` 必须是合法 JSON 对象，不能覆盖模型、提示词、图片和数量等核心字段。

## 开发与验证

Node.js 20 或以上，无第三方运行时依赖。以下命令在合集仓库根目录执行。

```text
npm test -- ai-image
npm run test:audit
npm run pack:extension -- ai-image
```

测试使用本地模拟 HTTP 服务和 QQ-agent 上下文，覆盖 JSON/multipart、参考图定位、热更新、图片下载与解码、超时、体积限制、部分失败、密钥脱敏、开始文字记录检查、慢请求等待和返回主模型的回复指引。边界测试检查模块依赖不越出技能目录，并在没有宿主源码或配置的独立目录执行生图/改图；不需要真实 API Key，也不调用付费接口。测试不代表模型一定遵循回复指引，真实服务商、模型和 QQ 发送需配置后验证。

`test:audit` 是本项目的清单与工具契约检查，不等于 QQ-agent 全仓审计。安装进 QQ-agent 源码仓库后可再运行其官方 `npm run test:audit`。

本技能在 `qq-agent-extensions` 合集中维护，使用仓库根目录的 Git。

开发依据：[skill-development.md](https://github.com/K0nd1us/QQ-agent/blob/main/doc/extend_development/skill-development.md)、[skill-reference.md](https://github.com/K0nd1us/QQ-agent/blob/main/doc/extend_development/skill-reference.md)、[snowluma-capabilities.md](https://github.com/K0nd1us/QQ-agent/blob/main/doc/extend_development/snowluma-capabilities.md)；并核对上游 `sender.js`、`store.js` 的当前实现。
