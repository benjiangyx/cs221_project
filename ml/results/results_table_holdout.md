| method                                 |   coverage@90 |   median area km2 | area vs circle       |
|:---------------------------------------|--------------:|------------------:|:---------------------|
| GBDT (rate + direction + L:B)          |         0.870 |           819.722 | 17.76 [13.46, 24.93] |
| App heuristic (wind-cone-v1)           |         0.896 |           208.426 | 4.16 [3.63, 5.14]    |
| Constant-rate circle (no model)        |         0.888 |            58.215 | 1.00 [1.00, 1.00]    |
| Anderson wind ellipse                  |         0.856 |           105.093 | 1.81 [1.71, 1.90]    |
| GBDT radial rate + circle (deployable) |         0.867 |            55.509 | 1.00 [0.82, 1.23]    |
| GBDT ellipse-head rate + circle        |         0.870 |            59.637 | 1.07 [0.84, 1.38]    |
| GBDT rate + Anderson shape             |         0.854 |            99.071 | 1.88 [1.51, 2.41]    |