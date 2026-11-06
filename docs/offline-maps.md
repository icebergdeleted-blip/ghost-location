# Offline maps, search and routing

Ghost works without internet once a phone is prepared. For iPhone, the first
**Prepare** downloads the developer disk image, so do that while online. When
the network is unavailable:

| Feature | Online default | Offline option |
| --- | --- | --- |
| Map tiles | OpenStreetMap tile server | A local **raster MBTiles** file or **{z}/{x}/{y} tile folder** (Settings → Map tiles) |
| Place search | Photon public demo | A self-hosted Photon on this computer or LAN (Settings → Place search). Coordinates and map pins always work. |
| Road routing | OSRM public demo | A self-hosted OSRM on this computer or LAN (Settings → Road routing) |
| Setting a location, Restore, route playback | — | No internet needed |

Plain `http://` is accepted only for `localhost`, `127.x.x.x`, `::1`,
`*.localhost` and private LAN addresses (10/8, 172.16/12, 192.168/16). Any other
host must use HTTPS. Ghost sends nothing to these services until you search or
press **Plan road route**.

If the map cannot load tiles, Ghost shows *"Map tiles could not load.
Coordinates still work."* You can still type latitude and longitude, or paste
`lat, lon` into the search box.

## Preparing tiles

Ghost's map draws **raster** images (PNG, JPEG or WebP). It cannot draw vector
tiles (`.pbf`/MVT MBTiles or vector PMTiles) and says so when you choose one.

**Do not bulk-download from `tile.openstreetmap.org`.** The
[OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
forbids it. Render your own tiles, or use a provider whose terms allow offline
use.

### Option A: QGIS (any OS, GUI)

1. Add a basemap layer whose licence allows offline export, or your own data.
2. Processing Toolbox → **Raster tools → Generate XYZ tiles (MBTiles)**.
3. Choose the area (extent), zoom range (for example 0–16 for a city; each
   extra zoom level roughly quadruples the size) and PNG or JPG format.
4. Save as `area.mbtiles`.

Use **Generate XYZ tiles (Directory)** instead to get a `{z}/{x}/{y}.png` folder.

### Option B: a folder you already have

Any folder laid out as `<root>/<z>/<x>/<y>.png` (or `.jpg`, `.jpeg`, `.webp`)
works. Ghost uses XYZ row numbering, which is what Leaflet, OSM and QGIS's
directory export use. Folders in TMS order (y flipped) will show the wrong rows.

### Option C: convert between formats

* Folder → MBTiles: `mb-util --image_format=png ./tiles area.mbtiles`
  ([mbutil](https://github.com/mapbox/mbutil)).
* PMTiles is not supported in this version. The `pmtiles` CLI converts
  MBTiles *to* PMTiles; as far as we know it does not convert back. Export
  MBTiles or a folder from your source data instead. Reading raster PMTiles
  directly would need the `pmtiles` JavaScript library and is a possible later
  addition.

## Choosing tiles in Ghost

Settings → **Map tiles**:

* **Choose MBTiles file…** opens the file, checks that it holds raster tiles,
  and shows its name and zoom range.
* **Choose tile folder…** uses a `{z}/{x}/{y}` folder.
* **Use online map** returns to OpenStreetMap.

The choice is saved. If the file is missing on the next start, Ghost falls back
to the online map and shows why. Beyond the file's highest zoom, Ghost enlarges
the deepest tiles it has. Outside the covered area the map is blank, but pins
and coordinates still work.

Tiles are served by Ghost's desktop process from that one file or folder
(`ghost://app/tiles/{z}/{x}/{y}`). Nothing else on disk is readable through it.

## Self-hosted routing (OSRM)

Run OSRM with a regional extract, for example with Docker as described in the
[OSRM README](https://github.com/Project-OSRM/osrm-backend#using-docker), and
enter `http://localhost:5000/` under Settings → **Road routing**. Ghost requests
`<url>route/v1/driving/…` exactly as it does for the public demo. If planning
fails, Ghost names the host it tried. It never draws a straight-line fallback.
