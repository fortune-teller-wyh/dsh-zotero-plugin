# Zotero 文库（读 + 写）

把本机 Zotero 文库接成一组固定工具：搜索、读条目、读笔记与批注、导出 BibTeX，以及按 DOI 添加条目、修改字段、增删标签与合集、追加笔记、删除条目。

读走 Zotero 自带的**本地 API**（只读）；写走 **Zotero Web API**（zotero.org），因此写入需要一把 API key。

## 前置条件

1. Zotero 7 或更高版本正在运行（本机为 10.0.8）。
2. **读**：Zotero → 设置 → 高级 → 杂项 → 勾选「允许此计算机上的其他应用程序与 Zotero 通信」。
3. **写**：到 <https://www.zotero.org/settings/keys> 新建一把私有 key，勾选 `Allow library access` 与 `Allow write access`，把 key 单独一行写进 `C:\Users\BUG\.dsh\zotero-api-key.txt`（或设置环境变量 `ZOTERO_API_KEY`）。
4. 写入后需要 Zotero 与 zotero.org 同步一次，条目才会出现在本地图书馆里。

## 读取工具

| 工具 | 作用 |
| --- | --- |
| `zotero_search` | 按关键词、条目类型、标签、合集搜索，返回 key、标题、作者、年份、期刊、DOI、标签、合集名 |
| `zotero_item` | 按 key 读完整元数据、摘要、笔记、附件、批注；也接受附件 key 以读取该 PDF 上的批注 |
| `zotero_collections` | 列出所有合集的 key、名称、父合集 |
| `zotero_bibtex` | 按 key 导出 BibTeX / BibLaTeX / CSL-JSON / RIS |

## 写入工具

| 工具 | 作用 |
| --- | --- |
| `zotero_add_by_doi` | 用 DOI 建条目：Crossref 查元数据，arXiv/数据集 DOI 自动回退 DataCite；可指定合集；库里已有同一 DOI 时默认跳过（`ifExists: add` 可强制加一条） |
| `zotero_add_by_title` | 只有标题时用：Crossref 标题检索 → 打分挑最匹配的 → 建条目；`dryRun: true` 只列候选不写入，适合先确认是哪篇 |
| `zotero_add_item` | 用你给的元数据建条目：`itemType` + `title` + `fields` 透传任意 Zotero 字段 |
| `zotero_update_item` | 改字段、加/删标签、加入/移出合集；先读后合并，不会覆盖已有标签 |
| `zotero_add_note` | 给某条目追加一条笔记（支持标题、列表、粗体、链接等轻量 Markdown） |
| `zotero_delete_item` | 永久删除条目，必须用 `confirmKey` 重复 key 确认 |

## 配置

插件目录 `cordis.patch.yml` 的 `config` 支持：

- `baseUrl`：本地 API 地址，默认 `http://127.0.0.1:23119`。
- `api`：本地库路径，默认 `users/0`。
- `webApiBase`：Web API 地址，默认 `https://api.zotero.org`。
- `apiKeyFile`：key 文件路径，默认 `%USERPROFILE%\.dsh\zotero-api-key.txt`。
- `userId`：Web API 用户 ID；不填时自动从本地文库的 `library.id` 推断。
- `timeoutMs`：单次请求超时，默认 15000。

## 限制与风险

- 写入需要勾了写权限的 key；key 只存在本机文件里，不会出现在插件配置或插件页。
- **插件自己不会浏览网页**：要"从谷歌学术导入"，由 agent 先取到 DOI 或标题，再调用写工具；谷歌学术页面对抓取不友好，通常从出版商或 arXiv 页拿 DOI 更稳。
- **附件（PDF）无法随条目一起写入**：Zotero Web API 不支持上传附件。要连 PDF 一起存，用 Edge 里的 Zotero Connector 一键保存，或存完条目后把 PDF 拖进去。
- 写入**不要求 Zotero 开着**（走 zotero.org，用户 ID 从 `/keys/current` 取）；读取仍需要 Zotero 运行并开启本地 API。
- Web API 的删除**没有回收站**，删除不可恢复，所以必须 `confirmKey` 二次确认。
- 写入之后本地库不会立刻出现条目：要等 Zotero 同步一轮。
- 只覆盖本机用户库与同一账号的 Web 库，不含群组库。
- 一次最多导出 20 条；搜索单页最多 50 条，用 `start` 翻页。
