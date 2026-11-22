| method                                 |   coverage@90 |   median area km2 | area vs circle       |
|:---------------------------------------|--------------:|------------------:|:---------------------|
| GBDT (rate + direction + L:B)          |         0.912 |           979.338 | 17.12 [14.87, 20.67] |
| App heuristic (wind-cone-v1)           |         0.920 |           260.651 | 3.88 [3.55, 4.75]    |
| Constant-rate circle (no model)        |         0.882 |            73.553 | 1.00 [1.00, 1.00]    |
| Anderson wind ellipse                  |         0.884 |           133.035 | 1.79 [1.69, 1.88]    |
| GBDT radial rate + circle (deployable) |         0.890 |            69.428 | 1.05 [0.91, 1.15]    |
| GBDT ellipse-head rate + circle        |         0.904 |            73.776 | 1.14 [0.95, 1.26]    |
| GBDT rate + Anderson shape             |         0.909 |           128.395 | 2.00 [1.68, 2.20]    |