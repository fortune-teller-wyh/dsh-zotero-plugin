# dsh-zotero-plugin

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Zotero 工具插件：读本机文库，也能把条目、标签、合集和笔记写回 Zotero 账号。

读取走 Zotero 本地 HTTP API（只读）；写入走 Zotero Web API，需要一把带写权限的 API key。

[English](README.en.md) | 中文

## 提供哪些工具

| 工具 | 作用 |
| --- | --- |
| `zotero_search` | 按关键词、条目类型、标签、合集搜索，返回 key、标题、作者、日期、期刊、DOI、标签、合集名 |
| `zotero_item` | 读单个条目：元数据、摘要、笔记、附件、批注 |
| `zotero_collections` | 列出合集及其 key 与父合集 |
| `zotero_bibtex` | 按 key 导出 BibTeX / BibLaTeX / CSL-JSON / RIS |
| `zotero_add_by_doi` | 用 DOI 建条目（Crossref，arXiv 等回退 DataCite） |
| `zotero_add_by_title` | 只有标题时用 Crossref 检索并建条目，`dryRun` 只列候选不写入 |
| `zotero_add_item` | 用显式元数据建条目 |
| `zotero_update_item` | 改字段、增删标签、增删合集 |
| `zotero_add_note` | 追加笔记，支持少量 Markdown 语法 |
| `zotero_delete_item` | 永久删除条目（需要重复输入 key 确认） |

## 前置条件

- Zotero 7 或更高版本，并处于运行状态。
- 读：Zotero → 设置 → 高级 → 杂项 → 勾选「允许此计算机上的其他应用程序与 Zotero 通信」。
- 写：到 <https://www.zotero.org/settings/keys> 新建私有 key，勾选 **Allow library access** 与 **Allow write access**。

## 安装

这是一个 DSH bundle。用插件管理器的 `install_bundle` 指向本目录，或在 DSH 里「插件 → 添加插件」选择该目录，然后启用。

## 配置

`cordis.patch.yml` 里是默认值，装好后可在插件行里覆盖：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:23119` | 本地 API 地址 |
| `api` | `users/0` | 本地库路径 |
| `webApiBase` | `https://api.zotero.org` | Web API 地址 |
| `apiKeyFile` | `%USERPROFILE%\.dsh\zotero-api-key.txt` | 存放 API key 的文件，一行 |
| `userId` | 自动推断 | Web API 用户 ID，可从本地库或 `/keys/current` 取得 |
| `timeoutMs` | `15000` | 单次请求超时 |

API key 在每次调用时读取，换 key 不需要重启。也支持环境变量 `ZOTERO_API_KEY`。

## 说明

- 写入是异步的：Zotero 同步一轮之后才会在应用里看到。
- Web API 无法上传附件，PDF 仍然要靠 Zotero Connector 保存。
- 本地读取需要 Zotero 正在运行；写入不需要。
- 不覆盖群组库。

## 许可

MIT
