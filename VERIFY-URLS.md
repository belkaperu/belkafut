# Verificación y arreglo automático de URLs

`verify-urls.mjs` revisa los canales de `data1.json`, comprueba **de verdad** que cada
URL funcione (status HTTP **+ contenido**) y, cuando encuentra una caída, **sale a
internet**: busca futbollibre en Google, entra a su agenda, extrae la URL real del
stream y la verifica antes de escribirla.

`update-canales.mjs` usa el mismo catálogo para **agregar opciones nuevas** a los
canales existentes (también verificadas).

Todo funciona sin dependencias externas (Node 20+).

```
                 ┌── ¿la URL responde y tiene reproductor? ──┐
                 │ sí                                    no │
                 │                                          ▼
                 │                       buscar "futbollibre" en Google
                 │                                          │
                 │                       entrar a su AGENDA (portada + /agenda)
                 │                                          │
                 │              /embed/eventos.html?r=<base64> ──► URL real
                 │                       páginas /en-vivo/<canal> ──► URL real
                 │                                          │
                 │                       verificar candidata ◄┘
                 │                                  │ sí
                 └──────────── data1.json ◄──────────┘
```

---

## 1. Uso rápido

```bash
# Simulación: no escribe nada, solo informa y propone arreglos
node verify-urls.mjs

# Aplicar los arreglos a data1.json (con búsqueda web)
node verify-urls.mjs --apply --search

# Revisar solo un canal y con más detalle
node verify-urls.mjs --only-channel=ESPN --verbose

# Ver las URLs internas que se van a comprobar (sin comprobarlas)
node verify-urls.mjs --list-urls

# Pruebas (levantan un servidor simulado local, no necesitan internet)
node test/verify-urls.test.mjs      # o: npm test
```

En GitHub Actions corre solo cada 6 horas
(`.github/workflows/verify-urls.yml`) y también se puede lanzar a mano desde la
pestaña **Actions** eligiendo si aplica los arreglos y si busca en la web.

---

## 2. Qué considera una URL "caída"

| Señal | Resultado |
| --- | --- |
| DNS inexistente, conexión rechazada, TLS roto, timeout | ❌ caída |
| HTTP 404 / 410 / 5xx | ❌ caída |
| HTTP 200 pero con texto de error ("no encontrada", "domain for sale", "Account Suspended", …) | ❌ caída |
| Respuesta vacía o muy corta | ❌ caída |
| `.m3u8` que no empieza con `#EXTM3U`, o sin segmentos | ❌ caída |
| `.mpd` (DASH) sin manifiesto válido | ❌ caída |
| Página 200 sin ninguna señal de reproductor (`<iframe>`, `<video>`, `m3u8`, `file:`, …) | ⚠️ dudosa |
| HTTP 401 / 403 / 429 / 451 / 503 | ⚠️ bloqueo (no concluyente) |
| `.m3u8` / `.mpd` escondido en `?url=` o `?get=` (base64) que no responde | ❌ caída |
| Página propia (`belkaperu.github.io`) que no existe en el repo | ❌ caída |

Las URLs se analizan **en cadena**, porque en `data1.json` van anidadas:

```
/p/foxrepro1.html?r=https://belkaperu.github.io/belkafut/repron.html?r=https://la18hd.su/vivo/canales.php?stream=espn
└── se comprueban todas las capas y manda el peor resultado ──────────────────────────────┘
```

---

## 3. Cómo busca los reemplazos (en este orden)

Cuando falla **una o más** URLs, el verificador sale a internet:

### 3.1 Agenda de futbollibre (primero de todo)

1. **Encuentra el dominio vivo**: prueba las semillas de `sources.json.agenda.domains`
   y, además, busca `futbollibre agenda` / `futbollibre canales en vivo` en Google
   (Bing y DuckDuckGo como respaldo) quedándose con los dominios que parecen de
   la familia futbollibre.
2. **Entra a la portada y a `/agenda`** y extrae los enlaces de reproducción:
   `https://<dominio>/embed/eventos.html?r=<base64>` → se decodifica el
   `?r=` y aparece la **URL real del stream** (ej. `https://tvf90.com/1.php?stream=winsports2`).
3. **Entra a la página de cada canal** (`/en-vivo/<slug>`) porque ahí suele haber
   un espejo más fresco que el del embed (la agenda da `1.php`, la página `6.php`).
4. Empareja por nombre del canal y **verifica cada URL** antes de usarla.
   El emparejamiento cuida los números (`ESPN` ≠ `ESPN 2`) y acepta calificadores
   (`| OP2`, `HD`, `Móvil`, país).

Después, si la agenda no tiene el canal:

5. **Mismo host, variantes del slug**: `espn` → `espn_hd`, `espn1`, `espn_premium`…
   (`slugAliases` y `slugPatterns`).
6. **Otros proveedores conocidos** de `sources.json` (`streamxhd`, `la18hd`,
   `embed.*`, `streamtp`, `sportsonline`, `jac-tv`, `megadeportes`, players de GitHub…).
7. **Slugs que ya funcionan para ese canal** en `data1.json`, `data2.json` y `data.json`.
8. **Opción hermana** del mismo canal que sí responde.
9. **Búsqueda web genérica** (`"<canal> futbollibre en vivo"` y `"<canal> en vivo"`):
   abre los resultados y extrae el `iframe`/`<video>`/`.m3u8` real; luego lo verifica.

Solo se aplica un reemplazo si la URL nueva pasa la verificación de contenido y si
**realmente cambia** el valor de la opción (nunca se "arregla" con la misma URL).

Los envoltorios se conservan: si muere la URL interna, solo se cambia esa parte
(y si iba en base64, se vuelve a codificar igual). Si muere un envoltorio externo,
se reconstruye la opción manteniendo el reproductor propio.

---

## 4. Qué escribe

* `data1.json` — solo cuando se usa `--apply` **y** hay arreglos verificados.
  Respeta el formato original (CRLF, indentación) porque trabaja reemplazando
  el texto exacto, no reserializando.
* `verificacion-reporte.json` — detalle completo (canales, motivos, arreglos, hosts no verificables).
* `verificacion-reporte.md` — el mismo resumen en tabla, legible.
* `$GITHUB_STEP_SUMMARY` — resumen visible en la ejecución de Actions.
* `$GITHUB_OUTPUT` — `changed`, `fixed`, `broken`, `unfixed`, `report`.
* `.verify-cache.json` — caché de búsquedas (ignorado por git).

**No borra canales ni opciones**: lo que no se puede arreglar queda reportado
(y el workflow abre/comenta un issue con etiqueta `urls-rotas`).

---

## 5. Seguridades

* **Cortafuegos de red**: si más del 85 % de las URLs externas fallan por red
  (con al menos 8 comprobadas), el script asume que el problema es de conexión,
  no de los canales: no toca nada, deja `error: sin_acceso_a_internet` y sale
  con código 3 (el workflow lo trata como "sin cambios", no como fallo).
* **Hosts no verificables**: si un host devuelve 403/429 en todo (Cloudflare,
  por ejemplo), sus URLs se marcan como bloqueadas y **no** se reparan por ese motivo.
* **Presupuesto de búsquedas**: `search.maxQueries` es un límite global por
  ejecución para no ser bloqueado por los buscadores; los canales que queden sin
  presupuesto aparecen en el reporte y se reintentan en la siguiente corrida.
* **Sin dependencias**: nada de `npm install` para el verificador.

---

## 6. Opciones de línea de comandos

| Opción | Qué hace |
| --- | --- |
| `--apply` | Escribe los arreglos en el archivo (por defecto solo simula) |
| `--dry-run` | Fuerza el modo simulación |
| `--search` / `--no-search` | Activa/desactiva la búsqueda en internet (y la agenda) |
| `--agenda-domains=a.com,b.com` | Fuerza los dominios de futbollibre a consultar |
| `--agenda-queries=q1\|q2` | Cambia las búsquedas con las que descubre el dominio |
| `--no-agenda` | Desactiva solo el catálogo de la agenda |
| `--only-channel=ESPN` | Revisa solo los canales que contengan ese texto |
| `--limit=N` | Revisa solo las primeras N opciones |
| `--file=data1.json` | Archivo objetivo |
| `--sources=sources.json` | Configuración de proveedores |
| `--report=verificacion-reporte` | Nombre base de los reportes |
| `--cache=.verify-cache.json` | Caché de búsquedas (`cacheTtlMinutes: 0` la ignora) |
| `--slug-sources=data1.json,data2.json,data.json` | Archivos de donde sacar slugs |
| `--concurrency=N` · `--timeout=MS` | Ajustes de velocidad |
| `--own-mode=auto\|http\|local` | Cómo verificar `belkaperu.github.io` (HTTP, repo local o ambos) |
| `--allow-local` | Permite URLs `127.0.0.1` (solo para pruebas) |
| `--verbose` | Muestra el detalle de lo que va haciendo |
| `--list-urls` | Lista las URLs internas detectadas |

---

## 7. `update-canales.mjs` (canales nuevos desde futbollibre)

```bash
node update-canales.mjs                 # simulación: informa qué agregaría
node update-canales.mjs --apply         # escribe en data1.json
node update-canales.mjs --apply --only-channel=ESPN --max-options=2
```

Hace el mismo recorrido que la agenda (buscar dominio → agenda → páginas de
canal → URL real → verificar) pero para **agregar opciones nuevas** a los canales
que ya existen en `data1.json`:

* Solo agrega URLs **verificadas** (nunca mete un canal muerto).
* No toca ni reordena las opciones existentes: inserta texto en el JSON
  conservando el formato (CRLF, indentación) y no reserializa el archivo.
* No duplica: si la URL ya estaba, la omite (por eso es idempotente).
* Deja `canales-reporte.json` y salidas `changed` / `added_options` / `added_channels`.

Corre en `.github/workflows/update-canales.yml` cada 6 horas.

---

## 8. `sources.json`

Es el archivo que se edita para mantener la herramienta al día (sin tocar código):

```jsonc
{
  "providers": [
    {
      "id": "streamxhd",
      "hosts": ["streamxhd.com", "streamx-hd.com"],
      "templates": ["https://streamxhd.com/live1.php?stream={slug}"],
      "kind": "page"
    }
  ],
  "slugAliases": {
    "espn": ["espn", "espn_hd", "espn1"],
    "tudn": ["tudn", "tudn_usa", "tudnmx"]
  },
  "agenda": {
    "enabled": true,
    "priority": 0,                                  // 0 = se prueba antes que los proveedores
    "domains": ["https://futbollibrefullhd.org"],   // semillas (opcional)
    "paths": ["/", "/agenda"],
    "apiPaths": ["/api/agenda?populate=deep"],      // Strapi, si el sitio lo expone
    "discoverFromSearch": true,
    "searchQueries": ["futbollibre agenda", "futbollibre canales en vivo"],
    "hostPattern": "(futbol|pelota|agenda\\d*|rojadirecta|tarjeta)",
    "maxDomains": 2,
    "minNameScore": 0.75
  },
  "search": {
    "enabled": true, "maxQueries": 30,
    "engines": [
      { "name": "google", "kind": "google", "url": "https://www.google.com/search?q={q}&num=20&hl=es" },
      { "name": "bing", "kind": "bing", "url": "https://www.bing.com/search?q={q}&count=20" },
      { "name": "duckduckgo-html", "kind": "duckduckgo", "url": "https://html.duckduckgo.com/html/?q={q}" }
    ]
  },
  "verification": { "timeoutMs": 12000, "deepStreamVerdict": "dead", "strictContent": false },
  "repair": { "enabled": true, "allowSiblingCopy": true, "minSlugScore": 0.55 }
}
```

Si el sitio de futbollibre cambia de estructura, basta con ajustar `paths`,
`apiPaths` o `hostPattern`; si Google bloquea al runner, el orden de `engines`
ya deja Bing y DuckDuckGo como respaldo.

Para **agregar un proveedor nuevo** basta con saber su URL de canal y escribirla
con `{slug}`:

```jsonc
{ "id": "nuevosite", "hosts": ["nuevosite.tv"], "templates": ["https://nuevosite.tv/ver/{slug}"], "kind": "page" }
```

`verification.strictContent: true` hace más estricta la comprobación de contenido
(una página sin señales de reproductor pasa de "dudosa" a "caída").

---

## 9. Pruebas

`test/verify-urls.test.mjs` levanta un servidor HTTP local que simula páginas OK,
404, errores con status 200, dominios parqueados, m3u8 válidos/inválidos, 403,
un buscador tipo Google, un proveedor y **un sitio tipo futbollibre** (portada con
agenda, `/agenda`, páginas `/en-vivo/<slug>` y páginas de embed). Comprueba:
detección de caídas, reparación desde la agenda (base64 y página de canal),
prioridad de la agenda sobre los proveedores, emparejamiento de nombres
(ESPN ≠ ESPN 2), reparación por proveedor y por búsqueda web, preservación de
base64/CRLF, idempotencia de ambos scripts, cortafuegos sin internet y salidas
para Actions.

```bash
node test/verify-urls.test.mjs      # SHOW_OUT=1 para ver la salida del verificador
```

Se ejecuta también en cada push mediante `.github/workflows/test.yml`.
