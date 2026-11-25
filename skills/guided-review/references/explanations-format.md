# Explanations file

One JSON file per review: an overview of the whole change and one entry per changed file. The script reads it with `--explanations`. The order of the keys in `files` is the order the reviewer walks through the files and the order of the sidebar groups, so put them in a sensible reading order: shared types and helpers before the code that uses them, the entry points next, then infrastructure and config, and tests last.

```json
{
  "overview": {
    "title": "ABC-123: one line naming the change",
    "body": [
      "Paragraph: what the change does, end to end.",
      "Paragraph: the key design decisions and the trade-offs behind them.",
      "Paragraph: rollout or manual steps, if any."
    ],
    "order_hint": "Suggested order: ... (optional)"
  },
  "files": {
    "path/from/repo/root.ts": {
      "group": "Handlers",
      "summary": "One sentence: what this file is or what changed in it.",
      "purpose": "What it serves in the feature: why it exists or why it changed.",
      "changes": [
        { "lines": "12-40", "text": "What these lines do and why." },
        { "lines": "57", "text": "..." }
      ],
      "notes": ["Something a reviewer should look at closely: a risk, a leftover, a gap."],
      "isTest": false
    }
  }
}
```

## Fields

- **Keys of `files`**: paths relative to the repo root, exactly as `--list` prints them. Write an entry for every listed file.
- **`group`**: the heading the file sits under in the sidebar. Use a handful of groups named after parts of the system (e.g. "API handlers", "Data model", "Infrastructure", "Config & build", "Tests").
- **`summary`**: one sentence.
- **`purpose`**: what the file serves in the feature, not a repeat of the summary.
- **`changes`**: one item per meaningful block of change. `lines` is `"N"` or `"N-M"` in the file's **current** (working-tree) line numbers; in the page it becomes a chip that jumps to those lines. For a lockfile or other generated file, leave `changes` empty and say in `purpose` that it is generated.
- **`notes`** (optional): findings worth a reviewer's attention, each one specific, with line numbers where they apply. Leave the list empty when there is nothing.
- **`isTest`** (optional): overrides the script's guess from the path. Set it for test helpers whose path doesn't look like a test.

Everything is plain text; the page escapes it.
