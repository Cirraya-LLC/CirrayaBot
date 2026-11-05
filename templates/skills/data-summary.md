---
name: data-summary
description: Use when given a CSV, spreadsheet or other table of data and asked what is in it, for totals, trends or a chart
---
# Summarising a dataset

Use Python with pandas (`pip install pandas matplotlib openpyxl` if they are missing).

1. Load it and look before you count: rows, columns, types, a few sample rows, missing values per column, duplicates.
2. Say what one row means ("one order", "one day per store") — everything else depends on it.
3. Answer the question asked with the fewest numbers that do it. Totals and averages with their units; for a trend,
   compare like with like (month over month, not a short month against a long one).
4. If a chart helps, make one, label its axes, save it as PNG in `/work/out/` and send it with `send_file`.
5. Mention anything that makes the numbers less reliable: gaps, outliers, odd values, a column you had to guess.

Keep the code you ran in `/work/out/analysis.py` so the result can be checked and run again.
