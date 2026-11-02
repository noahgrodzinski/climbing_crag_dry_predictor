# isitdry — Peak grit conditions

Static site that predicts whether gritstone crags in the Peak District and Staffordshire
are dry, for each of the next 8 days, along with grit friction and the risk of damaging wet rock.

No backend and no build step. The browser fetches [Open-Meteo](https://open-meteo.com)
directly and runs the model in JavaScript.

## Files

| file | what |
|---|---|
| `crags.js` | crag sectors: location, altitude, aspect, shelter, tree shade, "green" factor, notes, classics |
| `model.js` | hourly two-store wetness model, sun-on-face irradiance, friction, damage risk |
| `forecast.js` | Open-Meteo fetch, deterministic spin-up and ensemble branching, day summaries |
| `app.js`, `index.html`, `style.css` | terminal-style UI |

## Model in one paragraph

Each face has a surface water film `W` and a slow pore store `D`. Rain fills both, and
condensation fills `W` whenever the dew point is above the rock temperature. Evaporation empties `W`, using
Penman for a wet surface driven by direct and diffuse sunlight on a vertical plane at the crag's aspect,
wind at the face (10 m wind × shelter) and vapour-pressure deficit. `D` drains over about 3 days and
wicks back to the surface once it is more than half full. The model spins up from 14 days of
Open-Meteo history. Ensemble members (ECMWF IFS 51, ICON-EPS 40, MOGREPS-G 18) then branch
from the current state. A cell is P(rock dry for ≥75% of the session hours).

## Tuning

Per-crag knobs in `crags.js`:
- `shelter_wind`: multiplies the 10 m wind (1 = open moor edge, 0.4 = deep trees).
- `shade_trees`: multiplies the sunlight reaching the face.
- `green`: divides evaporation and boosts wicking (1 = normal, 2 = notoriously slow and green).

Rock-wide constants are in `ROCK` and `THRESH` in `model.js`.

## Run locally

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765.
