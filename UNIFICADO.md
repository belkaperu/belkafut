# data_unificado.json

Catálogo consolidado de `data.json`, `data1.json` y `data2.json`, generado por
`build-unificado.mjs`. **No se edita a mano**: se regenera.

```bash
node build-unificado.mjs            # simulación: muestra el resumen de cambios
node build-unificado.mjs --apply    # escribe data_unificado.json
node build-unificado.mjs --verbose  # detalle canal por canal
node test/unificado.test.mjs        # pruebas
```

## Qué arregla respecto de la versión anterior

| Antes (517 canales, versión previa del archivo) | Ahora |
| --- | --- |
| Variantes repetidas: `real` ×6, `TELEMUNDO` + `Telemundo`, `ESPN` + `ESPN HD`, `Discovery ID` + `ID Investigation`… | Un solo canal por señal; los nombres viejos quedan en `aliases` |
| `options` y `servers` con el mismo destino repetido (a veces envuelto en `/p/…?r=`) | Una sola entrada por destino real |
| 14 categorías con duplicados (`peliculas`, `Películas`, `películas`, `all`, `general`…) | 6 categorías canónicas, con `icon` y `display_name` |
| Basura como `31`, `2025 4:00 PM EST)`, `NO LO SE`, 145 × `Canal A0xx` mezclada con canales reales | Apartadas en `sin_identificar`, agrupadas por motivo y sin perder sus enlaces |
| `tvenvivo.webp` usado como logo de 148 canales distintos | Solo la mejor coincidencia local por canal, sin repetir imagen entre marcas distintas |
| Mojibake (`CNN Espaæol`, `Venezolana de Televisiðn`) y espacios sobrantes | Corregidos |

Estado actual: **497 canales**, 1505 enlaces en el catálogo + 247 en
`sin_identificar`, 192 con logo (el resto no tiene archivo en `img/canales`),
0 canales sin ningún enlace y **0 URLs y 0 nombres repetidos**.

De los 2099 enlaces de los tres archivos de origen quedan **1734 destinos
distintos** (365 eran el mismo destino repetido, a veces envuelto en otra capa de
reproductor); no se pierde ninguno: la comprobación de cobertura da 1734/1734.

## Formato

```jsonc
{
  "meta": {
    "version": "2.0.0",
    "generado": "2026-11-25T20:00:00.000Z",
    "fuentes": { "data.json": 367, "data1.json": 214, "data2.json": 460 },
    "totales": { "canales": 497, "enlaces": 1505, "con_imagen": 192, "sin_identificar": 12, "enlaces_sin_identificar": 247 },
    "fusiones": {
      "canales_fusionados": 186,
      "nombres_absorvidos": 160,
      "urls_repetidas_eliminadas": 83,
      "urls_compartidas_eliminadas": 88,
      "canales_absorbidos_por_stream_compartido": [{ "nombre": "Sky Premiere 2", "alias_de": "IT Sky Cinema 2" }]
    }
  },
  "categories": [{ "name": "Deportes", "display_name": "Deportes en Vivo", "icon": "⚽" }],
  "channels": [
    {
      "id": "espn",
      "name": "ESPN",
      "title": "ESPN",
      "normalized_name": "espn",
      "category": "Deportes",
      "imageUrl": "https://raw.githubusercontent.com/belkaperu/belkafut/main/img/canales/espn.webp",
      "updated": "2026-11-25",
      "aliases": ["ESPN HD"],
      "sources": ["data.json", "data1.json", "data2.json"],
      "servers": [{ "name": "179.51.136.19:8000", "url": "http://…/index.m3u8" }],
      "options": [{ "label": "ESPN MX GLOBAL", "url": "/p/foxrepro1.html?r=https://…" }]
    }
  ],
  "sin_identificar": [
    {
      "name": "Canales numericos sin nombre",
      "motivo": "numericos",
      "cantidad": 8,
      "nombres": ["31", "49"],
      "servers": [{ "name": "belami.top", "url": "http://…" }]
    }
  ]
}
```

### Campos

- **`id`** — slug estable (`espn`, `fox-sports-2-mexico`); sirve como `?channel=` en
  `tt.html` y para enlaces internos. Único en todo el archivo.
- **`name` / `title`** — nombre visible con mayúsculas correctas (se conserva `title`
  por compatibilidad con las listas viejas).
- **`normalized_name`** — clave de búsqueda/fusión: sin acentos, minúsculas,
  `MX` = `México`, `DirecTV Sports` = `DSports`, `daznliga` = `DAZN La Liga`.
- **`aliases`** — todos los nombres de origen que se fusionaron en esta entrada
  (sin variantes que solo cambiaban `HD`).
- **`updated`** — fecha (YYYY-MM-DD) de la última regeneración de la entrada.
- **`sources`** — de cuáles archivos salió (`data1.json` aporta las cadenas con
  reproductor del repo).
- **`servers`** — enlaces directos (`m3u8`, embeds, player…). `name` es el
  proveedor o un número cuando el origen no tenía nombre útil.
- **`options`** — enlaces con reproductor propio (`/p/…?r=…`). `label` es único en
  todo el archivo y desambigua con el destino (`OP SD · dazn2es`) cuando el nombre
  del origen no distingue un enlace de otro.
- **`sin_identificar`** — canales sin nombre confiable. Los genéricos del proveedor
  (`Canal A0xx`), los numéricos y los restos de eventos se agrupan en una entrada
  cada uno con `motivo`, `cantidad` y `nombres`; el resto va suelto.

## Cómo se deduplica

1. **Nombre** — `keyOf()`: minúsculas, sin acentos, `&`=`and`, `+`=`plus`, fuera
   `HD/FHD/SD/OP…`, `canal10`=`canal 10`, y el paréntesis cuenta como región
   (`Fox Sports 2 (AR)` ≠ `Fox Sports 2`, `La 1 (ES)` = `La 1`); después `ALIASES`
   (`MX`→`México`, `foxusa1`→`Fox Sports 1`, `EURO Channel`→`Eurochannel`…).
2. **URL** — `resolveTarget()` sigue la cadena completa
   (`/p/x.html?r=repron?r=<base64|url>`) hasta el destino real; dos enlaces que
   terminan en el mismo destino cuentan como uno.
3. **Entre canales** — si el mismo destino aparece en dos canales, se queda en el
   que lo necesita (menos enlaces propios / mejor coincidencia con la URL). El otro
   nombre pasa a `aliases` del canal ganador y queda anotado en `meta.fusiones`.

## Regenerar tras cambios en los datos

`data.json`, `data1.json` y `data2.json` los actualizan los workflows de
`README.md`. Cuando cambien, basta con:

```bash
node build-unificado.mjs --apply
```
