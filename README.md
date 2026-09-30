# QQ Agent Extensions

**nuoxi4n 的 QQ Agent 技能与插件仓库。** 各扩展独立配置、维护版本并打包安装，开发工具由仓库统一管理。

## 扩展

| 类型 | ID | 名称 | 功能与说明 |
| --- | --- | --- | --- |
| Skill | `reply-meme` | 回复配图·梗鲸表情包 | [结合聊天上下文选择和发送表情包](skills/reply-meme/README.md) |
| Skill | `ai-image` | AI生图 | [文生图和图生图，并将结果发送到群聊或私聊。](skills/ai-image/README.md) |
| Plugin | `rapport` | 好感度养成 | [自动计分、关系表达、查询与排行](plugins/rapport/README.md) |

## 目录约定

```text
skills/<id>/             LLM 型技能，清单为 skill.json
plugins/<id>/            确定性插件，清单为 plugin.json
test/repository/         通用清单、加载和打包检查
test/skills/<id>/        技能专项测试
test/plugins/<id>/       插件专项测试
scripts/                 通用发现、测试与打包工具
dist/skills/             技能安装包
dist/plugins/            插件安装包
package.json             仓库统一开发命令
```

扩展目录名与清单 `id` 一致，默认入口为 `index.js`，也支持清单中的相对 `entry` 路径。每个扩展提供 `README.md`，资源和模块放在自己的目录中。目录内不放独立 Git 仓库。

当前扩展没有第三方 npm 依赖，不需要独立的 `package.json`。本地开发统一使用仓库根目录的 ESM 配置；安装后由 QQ Agent 宿主加载。

## 安装与配置

将需要的 `skills/<id>/` 或 `plugins/<id>/` 整个目录复制到 QQ Agent 的对应目录，或导入其独立 ZIP。桌面安装版通常位于 `<QQ Agent>/resources/app/` 下。

安装包根目录直接包含清单、入口和运行资源，不多套一层扩展文件夹。各扩展的参数、依赖、使用方式与兼容性见对应 README。

## 开发命令

使用 Node.js 20 或以上，在仓库根目录运行；当前开发工具无需安装第三方依赖。

| 命令 | 作用 |
| --- | --- |
| `npm test` | 通用检查及所有已发现的专项测试 |
| `npm test -- <id>` | 指定扩展的通用检查及专项测试 |
| `npm test -- --type plugins` | 仅检查插件；也支持 `skills` |
| `npm run test:audit` | 所有扩展的通用检查 |
| `npm run pack` | 分别打包所有扩展 |
| `npm run pack:extension -- <id>` | 打包指定扩展 |
| `npm run pack:skill` | 打包全部技能，也可追加 `-- <id>` |
| `npm run pack:plugin` | 打包全部插件，也可追加 `-- <id>` |

测试和打包都支持多个 ID。不同类型中存在同名 ID 时，使用 `skills/<id>` 或 `plugins/<id>` 明确选择。输入未知 ID 或参数会报错，不会静默改为操作全部扩展。

测试自动发现 `*.test.js`、`*.test.mjs`、`*.test.cjs`。没有专项测试的扩展仍会执行通用检查；通用检查只加载并注册扩展，不启动生命周期、不发送 QQ 消息。

打包输出为 `dist/<类型>/<id>-<version>.zip`，名称和版本来自各扩展清单。运行模块、说明和资源递归纳入安装包，自动排除 Git 信息、npm 元数据、测试、本地缓存、运行数据和环境文件，并检查入口、文件数量、体积、默认密钥和市场禁止的文件类型。

## 新增扩展

1. 在 `skills/` 或 `plugins/` 下创建与 ID 同名的目录。
2. 添加对应清单、入口、README 和所需运行资源，独立维护扩展版本。
3. 按需在 `test/<类型>/<id>/` 下添加专项测试，并更新上方扩展目录表。
4. 运行 `npm test -- <id>` 和 `npm run pack:extension -- <id>`。

发现、测试、打包逻辑共用清单扫描，不需要再维护扩展名称或工具名称列表。

这些检查不代替实际宿主联调或 QQ Agent 官方全仓审计。宿主开发接口见 [QQ Agent 扩展文档](https://github.com/K0nd1us/QQ-agent/tree/main/doc/extend_development)。
