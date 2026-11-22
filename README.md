# Flashpoint

Grounded decision support for wildfire initial attack (CS221 project).

## Web app

```bash
npm install
cp .env.example .env.local   # add your Mapbox token and NASA FIRMS map key
npm run dev                  # http://localhost:3000
npm test
```

## ML pipeline

Run from the repo root:

```bash
python -m venv ml/.venv
ml/.venv/bin/pip install -r ml/requirements.txt
ml/.venv/bin/python ml/build_dataset.py --years 2018-2024   # data cached in ml/data/ (git-ignored)
ml/.venv/bin/python ml/build_dataset.py --years 2025        # untouched holdout
ml/.venv/bin/python ml/train.py
ml/.venv/bin/python ml/calibrate.py
ml/.venv/bin/python ml/evaluate.py [--holdout]
ml/.venv/bin/python ml/export_model.py   # writes data/models/spread_gbdt.json for the app
```
