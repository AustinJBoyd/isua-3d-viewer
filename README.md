# Isua 3D Viewer

A web viewer (CesiumJS) for the UAV photogrammetry 3D models of the north-western Isua Supracrustal Belt,
West Greenland. It opens the models in OGC 3D Tiles format (`.3tz` archives or unpacked tileset folders).
Nothing to install and no account needed.

**Open the viewer: https://austinjboyd.github.io/isua-3d-viewer/**

1. Open the link above in Edge, Chrome or Firefox (on Windows, macOS or Linux).
2. Drag a `.3tz` file onto the map (or use the ".3tz file…" button under "Open data"). The file is read on your own computer,
   piece by piece: nothing is uploaded, and multi-GB files are fine.
3. Add more surveys the same way. They line up with each other (all in WGS 84 / UTM 22N, ITRF2020).

The data are not in this repository. Contact Austin Jarl Boyd (GLOBE Institute, University of Copenhagen)
for the model files until the dataset is published.

## What it can do

| | |
|---|---|
| **Open a `.3tz` from disk** | File picker or drag & drop. The archive is read in place: nothing is unpacked or uploaded, and multi-GB files are fine. |
| **Open an unpacked tileset folder** | "Tileset folder…" button or drag & drop the folder. |
| **Stream from a web link** | Paste a link to a `.3tz` (read piece by piece with HTTP Range requests) or to a `tileset.json`. |
| **Several surveys at once** | One entry per model, each with show/hide, fly-to and a **vertical offset** slider. |
| **Coordinates** | Click a model: latitude, longitude, ellipsoidal height and UTM zone 22N easting/northing (EPSG:32622). |
| **Distance** | Two clicks: 3D distance, horizontal distance and height difference. |
| **Strike/dip** | Click 3 or more points on a planar surface. A least-squares plane is fitted and reported as dip direction/dip and strike/dip (right-hand rule), with the RMS misfit, and drawn in 3D. |
| **Export** | All measurements as CSV (opens in Excel) or GeoJSON (opens in QGIS). |
| **GeoJSON overlay** | E.g. sample locations. Click a point to see its properties. Points without heights are placed on the model surface. |
| **Screenshot** | PNG at 1×, 2× or 3× screen resolution, for figures. |
| **Shareable link** | The address bar holds the camera position and the loaded *web* links. |

Base map: OpenStreetMap (can be switched off). No terrain: the globe is the bare WGS84 ellipsoid.

## Moving around

Open the **Navigation** section in the side panel for the full list, the mouse layout and the
keyboard speed. Movement speed adapts to how far away the surface in the middle of the screen is,
so the same keys work for a close-up of a hand-sample-sized feature and for the whole survey area.
The camera cannot pass through a model.

**Mouse** (default layout "Model"; the panel can switch to CesiumJS' "Map" layout):

| | |
|---|---|
| Left drag | rotate / orbit around the point under the mouse |
| Right drag (or Ctrl + left drag) | pan (move sideways) |
| Wheel | zoom in / out towards the mouse pointer |
| Shift + left drag | look around (turn your head) |

**Keyboard** (click the 3D view first; keys do nothing while you type in a text field):

| | |
|---|---|
| W / S (or + / −) | forward / back = zoom in / out |
| A / D | strafe left / right |
| E / Q (or Page Up / Down) | straight up / down |
| ← / → | rotate around the point in the middle of the screen |
| ↑ / ↓ | orbit over / under that point |
| J / L, I / K | turn your head left / right, look up / down |
| Shift (hold) | 4× faster |
| N, T, H | north up, top-down view (for map figures), home (all models) |

**On-screen buttons** (bottom right of the 3D view; press and hold) do the same for touch screens
and for anyone who prefers not to use the keyboard. They can be hidden in the Navigation section.

