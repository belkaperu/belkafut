# data_unificado.json

Catálogo consolidado de `data.json`, `data1.json` y `data2.json`, generado por
`build-unificado.mjs`. **No se edita a mano**: se regenera.

```bash
node build-unificado.mjs            # simulación: muestra el resumen de cambios
node build-unificado.mjs --apply    # escribe data_unificado.json
node build-unificado.mjs --verbose  # detalle canal por canal
node test/unificado.test.mjs        # pruebas
```

## Esquema: es el MISMO de siempre

El archivo **no cambia de estructura**. Raíz `{categories, channels}` y cada canal
con exactamente estas 7 claves, en este orden:

```jsonc
{
  "categories": [
    { "display_name": "Deportes en Vivo", "icon": "⚽", "name": "Deportes" }
  ],
  "channels": [
    {
      "name": "ESPN",
      "title": "ESPN",
      "normalized_name": "espn",
      "category": "Deportes",
      "imageUrl": "https://raw.githubusercontent.com/belkaperu/belkafut/main/img/canales/espn.webp",
      "servers": [{ "name": "179.51.136.19:8000", "url": "http://…/index.m3u8" }],
      "options": [{ "label": "ESPN AR HD", "url": "/p/foxrepro1.html?r=…" }]
    }
  ]
}
```

- `servers`: `{name, url}` · `options`: `{label, url}`.
- Las **páginas embed** (`/embed2/espn.php`) van en `servers` envueltas en
  `repron.html?r=<página>`: sueltas no se pueden abrir, solo cargan dentro de
  un `iframe`.
- Las categorías mantienen `display_name`, `icon` y `name`.
- Los canales van en orden alfabético, como antes.

`validateUnified()` comprueba que no aparezca ningún campo ni sección de más, así
que el esquema no puede ampliarse por accidente.

## Qué arregla (sin tocar la estructura)

| Antes | Ahora |
| --- | --- |
| Variantes repetidas: `real` ×6, `TELEMUNDO` + `Telemundo`, `ESPN` + `ESPN HD`, `Discovery ID` + `ID Investigation`… | Un solo canal por señal |
| `options` y `servers` con el mismo destino repetido (a veces envuelto en `/p/…?r=`) | Una sola entrada por destino real |
| 14 categorías con duplicados (`peliculas`, `Películas`, `películas`, `all`, `general`…) | 6 categorías canónicas |
| `tvenvivo.webp` usado como logo de 148 canales distintos | Solo la coincidencia real por canal |
| Mojibake (`CNN Espaæol`, `Venezolana de Televisiðn`) y espacios sobrantes | Corregidos |

Cifras actuales: **499 canales**, 1050 enlaces, **0 claves repetidas, 0 URLs
repetidas y 0 canales sin enlace**.

Los destinos comprobados que no reproducen (aunque respondan 200) se descartan
al construir: ver `SIN_VIDEO` en `build-unificado.mjs` y
**[VERIFICAR-ENLACES.md](VERIFICAR-ENLACES.md)**.

## Datos que no entran al archivo

Los nombres sin ningún dato útil (números sueltos, `NO LO SE`, restos de
fecha/hora) no se escriben, para no ensuciar el catálogo; la CLI informa cuántos
son y cuántos enlaces se apartaron. Los `Canal A0xx` del proveedor **sí** se
mantienen en `channels`, como en el archivo original.

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
