---
"cf": minor
---

Show SQL query results as tables in interactive terminals

In an interactive terminal, `cf sql query` now prints query results as a table, followed by a summary of the rows returned, the elapsed time, and the rows and bytes read. Long values are truncated to fit the terminal, results with too many columns show one record per row, and text formats such as `FORMAT TSV` print as plain text rather than as a quoted JSON string.

Pipes, CI, and detected AI agents still receive the unchanged JSON response. Pass the new global `--json` flag to get JSON in an interactive terminal too; it has no effect on commands without a table view.
