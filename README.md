# dsh-zotero-plugin

Zotero tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): read your local library, and write items, tags, collections and notes back to your Zotero account.

Reads go through Zotero's local HTTP API (read-only). Writes go through the Zotero Web API, so they need an API key with write access.

English | [中文](README.zh.md)

## Tools

| Tool | What it does |
| --- | --- |
| `zotero_search` | Search by text, item type, tag or collection; returns key, title, creators, date, venue, DOI, tags, collection names |
| `zotero_item` | Read one item: metadata, abstract, notes, attachments, annotations |
| `zotero_collections` | List collections with keys and parents |
| `zotero_bibtex` | Export BibTeX / BibLaTeX / CSL-JSON / RIS from item keys |
| `zotero_add_by_doi` | Create an item from a DOI (Crossref, falling back to DataCite for arXiv) |
| `zotero_add_by_title` | Find a paper by title on Crossref and create it; `dryRun` lists candidates without writing |
| `zotero_add_item` | Create an item from explicit metadata |
| `zotero_update_item` | Set fields, add/remove tags, add/remove collections |
| `zotero_add_note` | Attach a note with a small Markdown subset |
| `zotero_delete_item` | Permanently delete one item (requires repeating the key) |

## Requirements

- Zotero 7 or newer, running.
- Zotero → Settings → Advanced → Miscellaneous → enable **"Allow other applications on this computer to communicate with Zotero"** for the read tools.
- An API key from <https://www.zotero.org/settings/keys> with **Allow library access** and **Allow write access** for the write tools.

## Install

This is a DSH bundle. Install the directory through DSH's plugin manager (`install_bundle`) or **Plugins → Add plugin**, then enable it.

## Configuration

`cordis.patch.yml` carries the defaults; override them in the installed row:

| Key | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:23119` | Local API base URL |
| `api` | `users/0` | Local library path |
| `webApiBase` | `https://api.zotero.org` | Web API base URL |
| `apiKeyFile` | `%USERPROFILE%\.dsh\zotero-api-key.txt` | File holding the API key, one line |
| `userId` | discovered | Web API user id; discovered from the local library or `/keys/current` |
| `timeoutMs` | `15000` | Per-request timeout |

The API key is read at call time, so rotating it needs no restart. `ZOTERO_API_KEY` also works.

## Notes

- Writes are asynchronous: Zotero shows the change after its next sync.
- The Web API cannot upload attachments, so PDFs stay a Zotero Connector job.
- Local reads need Zotero running; writes do not.
- Group libraries are not covered.

## License

MIT
