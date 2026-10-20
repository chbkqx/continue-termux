# DeepSeek FIM 补全

基于 DeepSeek FIM（Fill In the Middle）API 的 VS Code 内联代码补全扩展，以幽灵文本形式显示在光标处，按 `Tab` 接受。

## 功能

- 在 `file` / `untitled` 文档中自动请求补全
- 状态栏图标一键启用/禁用（`$(sparkle) DeepSeek` / `$(circle-slash) DeepSeek`）
- 自动取消过期请求，快速输入不会堆积并发调用
- 补全结果默认最多 3 行，可配置
- 输出面板 `DeepSeek FIM` 中记录耗时与上下文缓存命中情况

## 使用

1. 在 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 创建 API Key
2. 打开设置，搜索 `continue-termux.apiKey` 并填入
3. 打开代码文件开始输入，停顿约 300ms 后出现补全建议
4. 按 `Tab` 接受，或继续输入忽略

可用命令：

- `切换 DeepSeek 补全`：启用/禁用
- `打开 DeepSeek 补全设置`：跳转到 API Key 配置项

## 配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `continue-termux.enabled` | `true` | 总开关 |
| `continue-termux.apiKey` | `""` | DeepSeek API Key（明文保存在设置中） |
| `continue-termux.baseUrl` | `https://api.deepseek.com/beta` | 必须使用 `/beta` 端点，否则不支持 `suffix` |
| `continue-termux.model` | `deepseek-flash` | 可选 `deepseek-flash` / `deepseek-v4-pro` |
| `continue-termux.maxTokens` | `128` | 单次生成上限，最大 4096 |
| `continue-termux.temperature` | `0.2` | 采样温度 |
| `continue-termux.debounceMs` | `300` | 停止输入多久后发起请求 |
| `continue-termux.maxPrefixChars` | `20000` | 光标前上下文字符上限 |
| `continue-termux.suffixLines` | `30` | 光标后上下文行数 |
| `continue-termux.maxLines` | `3` | 补全结果最多保留行数 |
| `continue-termux.disabledLanguages` | `[]` | 跳过的语言 ID，例如 `markdown` |

## 缓存策略

DeepSeek 的上下文缓存按「完整匹配的 cache prefix unit」命中。为了尽量复用缓存：

- prefix 始终从文件第一行取到光标位置，不做滑动窗口。光标后移时新前缀是旧前缀的超集，可命中已有缓存。
- prefix 中不插入时间戳、文件名或语言标记等易变内容。
- 文件超过 `maxPrefixChars` 时，保留文件开头 60% 与光标前 40%，中间使用固定分隔符拼接，仍可共享文件开头。
- suffix 位于 FIM 模板的 prefix 之后，不影响 prefix 的缓存匹配，因此只取光标后有限行数。

每次请求的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 会写入 `DeepSeek FIM` 输出面板。

## 已知限制

- FIM 接口处于 beta 阶段，`max_tokens` 上限为 4096
- API Key 以明文保存在用户设置中，请勿提交到公开仓库
- 仅对本地文件与未命名文档生效，不支持虚拟文档（如 Git diff）
- 不提供多候选补全，只展示单条建议
